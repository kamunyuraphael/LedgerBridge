import { Router } from 'express';
import type { Env } from '../config/env';
import { Item, Supplier } from '../models/catalog';
import { requireAuth } from '../services/auth';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function catalogueRouter(env: Env): Router {
  const r = Router();
  r.use(requireAuth(env.JWT_SECRET));

  /** Suppliers that have orderable items (HQ can pass ?all=true to see every supplier). */
  r.get('/suppliers', async (req, res) => {
    const counts = await Item.aggregate<{ _id: string; n: number }>([
      { $match: { active: true } },
      { $group: { _id: '$supplierCode', n: { $sum: 1 } } },
    ]);
    const n = new Map(counts.map((c) => [c._id, c.n]));
    const all = req.user!.role === 'hq' && req.query.all === 'true';
    const suppliers = await Supplier.find({ active: true }).sort({ name: 1 }).lean();
    res.json(
      suppliers
        .map((s) => ({ code: s.code, name: s.name, itemCount: n.get(s.code) ?? 0 }))
        .filter((s) => all || s.itemCount > 0),
    );
  });

  r.get('/items', async (req, res) => {
    const filter: Record<string, unknown> = { active: true };
    if (typeof req.query.supplierCode === 'string' && req.query.supplierCode) filter.supplierCode = req.query.supplierCode.toUpperCase();
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const re = new RegExp(escapeRe(req.query.q.trim()), 'i');
      filter.$or = [{ itemNo: re }, { description: re }];
    }
    const items = await Item.find(filter).sort({ description: 1 }).limit(1000).lean();
    res.json(items.map((i) => ({ itemNo: i.itemNo, description: i.description, supplierCode: i.supplierCode })));
  });

  return r;
}
