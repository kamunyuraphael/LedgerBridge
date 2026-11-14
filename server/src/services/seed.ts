import { Branch, Item, Replenishment, Supplier } from '../models/catalog';
import { Counter } from '../models/Order';
import { User } from '../models/User';
import type { Env } from '../config/env';
import { logger } from '../utils/logger';
import demoBranches from '../data/demoBranches.json';
import demoItems from '../data/demoItems.json';
import items from '../data/items.json';
import suppliers from '../data/suppliers.json';
import { hashPassword } from './auth';
import { importRows } from './importers';

/** Idempotent first-run setup: catalogue from the bundled files, plus the first HQ login. */
export async function seedIfEmpty(env: Env): Promise<void> {
  if ((await Supplier.estimatedDocumentCount()) === 0) {
    const r = await importRows('suppliers', suppliers.map((s) => ({ code: s.code, name: s.name })));
    logger.info('seed.suppliers', { written: r.written, errors: r.errors.length });
  }
  if ((await Item.estimatedDocumentCount()) === 0) {
    const r = await importRows(
      'items',
      items.map((i) => ({ itemNo: i.itemNo, description: i.description, supplierCode: i.supplierCode, ...(i.qty ? { defaultQty: String(i.qty) } : {}) })),
    );
    logger.info('seed.items', { written: r.written, errors: r.errors.length });
  }
  await seedDemo(env);
  if ((await User.countDocuments({ role: 'hq' })) === 0) {
    if (!env.BOOTSTRAP_ADMIN_PASSWORD) {
      logger.warn('seed.no_hq_user', {
        hint: 'Set BOOTSTRAP_ADMIN_PASSWORD (min 8 chars) in .env and restart to create the first HQ login',
      });
      return;
    }
    await User.create({
      username: env.BOOTSTRAP_ADMIN_USERNAME,
      name: 'HQ Admin',
      role: 'hq',
      passwordHash: await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD),
      mustChangePassword: false,
    });
    logger.info('seed.hq_user_created', { username: env.BOOTSTRAP_ADMIN_USERNAME });
  }
}

export const DEMO_PASSWORD = 'demo1234';

/**
 * Simulated branches (J001-J034, each with a login) and products, loaded once and marked `simulated`
 * so "Remove demo data" in Setup can delete exactly these. On by default outside production.
 */
async function seedDemo(env: Env): Promise<void> {
  // Databases created by an earlier version have items without default quantities: fill them in once.
  await Item.bulkWrite(
    [...items.map((i) => ({ itemNo: i.itemNo, qty: i.qty })), ...demoItems.map((i) => ({ itemNo: i.itemNo, qty: i.qty }))]
      .filter((i) => i.qty)
      .map((i) => ({ updateOne: { filter: { itemNo: i.itemNo, defaultQty: { $exists: false } }, update: { $set: { defaultQty: i.qty } } } })),
  );
  if (!(env.SEED_DEMO_DATA ?? env.NODE_ENV !== 'production')) return;

  // One-time markers: removing the demo data later must not bring it back on the next restart.
  const first = !(await Counter.findOneAndUpdate({ _id: 'demo-seeded' }, { $setOnInsert: { seq: 1 } }, { upsert: true, returnDocument: 'before' }));
  if (first) {
    const known = new Set((await Supplier.find({}, { code: 1 }).lean()).map((s) => s.code));
    const demo = demoItems.filter((i) => known.has(i.supplierCode));
    await Item.bulkWrite(
      demo.map((i) => ({
        updateOne: { filter: { itemNo: i.itemNo }, update: { $setOnInsert: { itemNo: i.itemNo, description: i.description, supplierCode: i.supplierCode, defaultQty: i.qty, active: true, simulated: true } }, upsert: true },
      })),
    );
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    for (const b of demoBranches) {
      await Branch.updateOne({ code: b.code }, { $setOnInsert: { code: b.code, name: b.name, active: true, simulated: true } }, { upsert: true });
      const username = b.code.toLowerCase();
      if (!(await User.exists({ username }))) {
        await User.create({ username, name: b.name, role: 'branch', branchCode: b.code, passwordHash, mustChangePassword: false });
      }
    }
    logger.info('seed.demo', { branches: demoBranches.length, items: demo.length, hint: `Branch logins j001...j034, password ${DEMO_PASSWORD} (demo only)` });
  }

  // Standard quantities are a later addition, so they have their own marker (and need the demo branches to exist).
  const rulesFirst = !(await Counter.findOneAndUpdate({ _id: 'demo-rules-seeded' }, { $setOnInsert: { seq: 1 } }, { upsert: true, returnDocument: 'before' }));
  if (rulesFirst && (await Branch.exists({ simulated: true }))) {
    const demo = await Item.find({ simulated: true }, { itemNo: 1, supplierCode: 1, defaultQty: 1 }).lean();
    await seedDemoRules(demo.map((i) => ({ itemNo: i.itemNo, supplierCode: i.supplierCode, qty: i.defaultQty ?? 12 })));
    logger.info('seed.demo_rules', { hint: 'Branches only see items with a standard quantity (never the quantity itself)' });
  }
}

/** Small seeded PRNG so the demo data is the same on every machine. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard quantities per branch, like the lists HQ's system would hold: each branch orders a different
 * subset of items (e.g. 25 from one supplier, 4 from another). J001 (Thindigua) gets exactly the items and
 * quantities from Eric's sample order sheet, plus some extra demo items.
 */
async function seedDemoRules(demo: { itemNo: string; supplierCode: string; qty: number }[]): Promise<void> {
  const realNos = new Set(items.map((i) => i.itemNo));
  const catalog = [
    ...items.map((i) => ({ itemNo: i.itemNo, supplierCode: i.supplierCode, qty: i.qty ?? 12 })),
    ...demo,
  ];
  const bySupplier = new Map<string, typeof catalog>();
  for (const it of catalog) bySupplier.set(it.supplierCode, [...(bySupplier.get(it.supplierCode) ?? []), it]);

  const docs: { branchCode: string; itemNo: string; qty: number; simulated: true }[] = [];
  demoBranches.forEach((b, idx) => {
    const rnd = prng(1000 + idx);
    for (const [, list] of bySupplier) {
      const first = idx === 0 && realNos.has(list[0]!.itemNo);
      if (!first && rnd() > 0.7) continue; // this branch doesn't order from this supplier
      const keep = 0.35 + rnd() * 0.6;
      for (const it of list) {
        const sample = idx === 0 && realNos.has(it.itemNo);
        if (!sample && rnd() > keep) continue;
        docs.push({ branchCode: b.code, itemNo: it.itemNo, qty: sample ? it.qty : Math.max(1, Math.round(it.qty * (0.5 + rnd()))), simulated: true });
      }
    }
  });
  await Replenishment.bulkWrite(docs.map((d) => ({ updateOne: { filter: { branchCode: d.branchCode, itemNo: d.itemNo }, update: { $setOnInsert: d }, upsert: true } })));
}
