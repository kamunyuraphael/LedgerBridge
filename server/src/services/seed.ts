import { Branch, Supplier } from '../models/catalog';
import { Counter } from '../models/Order';
import { User } from '../models/User';
import type { Env } from '../config/env';
import { logger } from '../utils/logger';
import demoBranches from '../data/demoBranches.json';
import suppliers from '../data/suppliers.json';
import { hashPassword } from './auth';
import { importRows } from './importers';

/** Idempotent first-run setup: catalogue from the bundled files, plus the first HQ login. */
export async function seedIfEmpty(env: Env): Promise<void> {
  if ((await Supplier.estimatedDocumentCount()) === 0) {
    const r = await importRows('suppliers', suppliers.map((s) => ({ code: s.code, name: s.name })));
    logger.info('seed.suppliers', { written: r.written, errors: r.errors.length });
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
 * Simulated branches (J001-J034, each with a login), loaded once and marked `simulated`
 * so "Remove demo data" in Setup can delete exactly these. On by default outside production.
 */
async function seedDemo(env: Env): Promise<void> {
  if (!(env.SEED_DEMO_DATA ?? env.NODE_ENV !== 'production')) return;

  // One-time markers: removing the demo data later must not bring it back on the next restart.
  const first = !(await Counter.findOneAndUpdate({ _id: 'demo-seeded' }, { $setOnInsert: { seq: 1 } }, { upsert: true, returnDocument: 'before' }));
  if (first) {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    for (const b of demoBranches) {
      await Branch.updateOne({ code: b.code }, { $setOnInsert: { code: b.code, name: b.name, active: true, simulated: true } }, { upsert: true });
      const username = b.code.toLowerCase();
      if (!(await User.exists({ username }))) {
        await User.create({ username, name: b.name, role: 'branch', branchCode: b.code, passwordHash, mustChangePassword: false });
      }
    }
    logger.info('seed.demo', { branches: demoBranches.length, hint: `Branch logins j001...j034, password ${DEMO_PASSWORD} (demo only)` });
  }
}
