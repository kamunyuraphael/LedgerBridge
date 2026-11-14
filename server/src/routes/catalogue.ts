import { Router } from 'express';
import type { Env } from '../config/env';
import { Supplier } from '../models/catalog';
import { requireAuth } from '../services/auth';

export function catalogueRouter(env: Env): Router {
  const r = Router();
  r.use(requireAuth(env.JWT_SECRET));

  /** Every active supplier. Branches pick from this list; products are HQ's business. */
  r.get('/suppliers', async (_req, res) => {
    const suppliers = await Supplier.find({ active: true }).sort({ name: 1 }).lean();
    res.json(suppliers.map((s) => ({ code: s.code, name: s.name })));
  });

  return r;
}
