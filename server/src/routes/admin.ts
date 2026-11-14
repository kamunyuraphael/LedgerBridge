import express, { Router } from 'express';
import type { Env } from '../config/env';
import { Branch, Item, Replenishment, Supplier } from '../models/catalog';
import { User } from '../models/User';
import { createUserSchema } from '../schemas/order';
import { hashPassword, requireAuth, requireRole, tempPassword } from '../services/auth';
import { importRows, readTable, type ImportKind } from '../services/importers';
import { HttpError } from '../services/orderService';
import { Order } from '../models/Order';
import { requeueFailedLedger } from '../services/orderLedgerWorker';

const KINDS: readonly ImportKind[] = ['suppliers', 'items', 'branches', 'quantities'];

export function adminRouter(env: Env): Router {
  const r = Router();
  r.use(requireAuth(env.JWT_SECRET), requireRole('hq'));

  /** Upload an .xlsx as the raw request body (Content-Type: application/octet-stream). */
  r.post('/import/:kind', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
    const kind = KINDS.find((k) => k === req.params.kind);
    if (!kind) throw new HttpError(404, 'not_found');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(422, 'no_file', 'Attach an .xlsx file');
    let rows;
    try {
      rows = await readTable(req.body, kind);
    } catch {
      throw new HttpError(422, 'bad_file', 'Could not read that file. Upload an .xlsx workbook.');
    }
    if (rows.length === 0) {
      throw new HttpError(422, 'no_rows', 'No rows found. Check the column headers (see Imports help).');
    }
    if (kind === 'branches') {
      // A real branch taking over a simulated code must not keep the demo login (known password).
      const codes = rows.map((r) => (r.code ?? '').toUpperCase()).filter(Boolean);
      const demo = (await Branch.find({ code: { $in: codes }, simulated: true }, { code: 1 }).lean()).map((b) => b.code);
      if (demo.length) {
        await User.deleteMany({ role: 'branch', branchCode: { $in: demo } });
        await Replenishment.deleteMany({ branchCode: { $in: demo }, simulated: true });
      }
    }
    if (kind === 'quantities') {
      // Real quantities replace any demo rules for those branches; "replace" also drops older real rules,
      // which is how HQ removes an item from a branch's list.
      const codes = [...new Set(rows.map((r) => (r.branchCode ?? '').toUpperCase()).filter(Boolean))];
      await Replenishment.deleteMany({ branchCode: { $in: codes }, ...(req.query.replace === 'true' ? {} : { simulated: true }) });
    }
    const result = await importRows(kind, rows);
    // Optionally create a login per imported branch (username = branch code, random temp password).
    let accounts: { username: string; name: string; password: string }[] | undefined;
    if (kind === 'branches' && req.query.createAccounts === 'true') {
      accounts = [];
      for (const row of rows) {
        const code = (row.code ?? '').toUpperCase();
        const username = code.toLowerCase();
        if (!code || !row.name || (await User.exists({ username }))) continue;
        const password = tempPassword();
        await User.create({
          username,
          name: row.name,
          role: 'branch',
          branchCode: code,
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
        });
        accounts.push({ username, name: row.name, password });
      }
    }
    res.json({ ...result, ...(accounts ? { accounts } : {}) });
  });

  r.get('/branches', async (_req, res) => {
    const [branches, users] = await Promise.all([Branch.find().sort({ name: 1 }).lean(), User.find({ role: 'branch' }).lean()]);
    const hasLogin = new Set(users.map((u) => u.branchCode));
    res.json(branches.map((b) => ({ code: b.code, name: b.name, active: b.active, hasLogin: hasLogin.has(b.code) })));
  });

  r.get('/users', async (_req, res) => {
    const users = await User.find().sort({ role: 1, username: 1 }).lean();
    res.json(
      users.map((u) => ({
        id: String(u._id),
        username: u.username,
        name: u.name,
        role: u.role,
        branchCode: u.branchCode ?? undefined,
        active: u.active,
        lastLoginAt: u.lastLoginAt?.toISOString(),
      })),
    );
  });

  r.post('/users', async (req, res) => {
    const p = createUserSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(422, 'validation_failed');
    const { username, name, role, branchCode, password } = p.data;
    if (role === 'branch') {
      if (!branchCode || !(await Branch.exists({ code: branchCode.toUpperCase() }))) {
        throw new HttpError(422, 'unknown_branch', 'A branch account needs an existing branch code');
      }
    }
    if (await User.exists({ username: username.toLowerCase() })) throw new HttpError(409, 'username_taken');
    const plain = password ?? tempPassword();
    await User.create({
      username,
      name,
      role,
      ...(role === 'branch' && branchCode ? { branchCode } : {}),
      passwordHash: await hashPassword(plain),
      mustChangePassword: true,
    });
    res.status(201).json({ username: username.toLowerCase(), password: plain });
  });

  r.post('/users/:id/reset-password', async (req, res) => {
    const u = await User.findById(String(req.params.id));
    if (!u) throw new HttpError(404, 'not_found');
    const plain = tempPassword();
    u.passwordHash = await hashPassword(plain);
    u.mustChangePassword = true;
    await u.save();
    res.json({ username: u.username, password: plain });
  });

  r.patch('/users/:id', async (req, res) => {
    const active = (req.body as { active?: unknown } | undefined)?.active;
    if (typeof active !== 'boolean') throw new HttpError(422, 'validation_failed');
    if (String(req.params.id) === req.user!.id && !active) throw new HttpError(409, 'self_deactivate', 'You cannot deactivate yourself');
    const u = await User.findByIdAndUpdate(String(req.params.id), { active }, { returnDocument: 'after' });
    if (!u) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  /** Deletes the simulated branches, their logins and orders, and the simulated products. Real data is untouched. */
  r.post('/demo/clear', async (_req, res) => {
    const demoBranches = (await Branch.find({ simulated: true }, { code: 1 }).lean()).map((b) => b.code);
    const [orders, users, branches, items, rules] = await Promise.all([
      Order.deleteMany({ branchCode: { $in: demoBranches } }),
      User.deleteMany({ role: 'branch', branchCode: { $in: demoBranches } }),
      Branch.deleteMany({ simulated: true }),
      Item.deleteMany({ simulated: true }),
      Replenishment.deleteMany({ $or: [{ simulated: true }, { branchCode: { $in: demoBranches } }] }),
    ]);
    res.json({ orders: orders.deletedCount, users: users.deletedCount, branches: branches.deletedCount, items: items.deletedCount, rules: rules.deletedCount });
  });

  r.post('/ledger/retry-failed', async (_req, res) => {
    res.json({ requeued: await requeueFailedLedger() });
  });

  r.get('/stats', async (_req, res) => {
    const [suppliers, items, branches, demoItems, ledger] = await Promise.all([
      Supplier.countDocuments(),
      Item.countDocuments({ active: true }),
      Branch.countDocuments(),
      Item.countDocuments({ simulated: true }),
      Order.aggregate<{ _id: string; n: number }>([{ $match: { ledgerStatus: { $exists: true } } }, { $group: { _id: '$ledgerStatus', n: { $sum: 1 } } }]),
    ]);
    res.json({ suppliers, items, branches, hasDemoData: demoItems > 0, ledger: Object.fromEntries(ledger.map((l) => [l._id, l.n])) });
  });

  return r;
}
