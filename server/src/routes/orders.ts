import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import ExcelJS from 'exceljs';
import type { Env } from '../config/env';
import { poSchema, submitOrderSchema, transitionSchema } from '../schemas/order';
import { requireAuth, requireRole } from '../services/auth';
import {
  getOrder,
  HttpError,
  lastSupplierCodes,
  listOrders,
  ordersForExport,
  setPo,
  statusCounts,
  submitOrder,
  transitionOrder,
  type OrderFilter,
} from '../services/orderService';
import { ORDER_STATUSES, STATUS_LABELS, type OrderStatus } from '../services/orderLogic';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const status = (v: unknown): OrderStatus | undefined => ORDER_STATUSES.find((s) => s === v);
const date = (v: unknown, endOfDay = false): Date | undefined => {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00+03:00`); // Nairobi calendar days
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d;
};

function filterFrom(req: Request): OrderFilter {
  return {
    status: status(req.query.status),
    supplierCode: str(req.query.supplierCode),
    branchCode: str(req.query.branchCode),
    q: str(req.query.q),
    from: date(req.query.from),
    to: date(req.query.to, true),
  };
}

export function ordersRouter(env: Env): Router {
  const r = Router();
  r.use(requireAuth(env.JWT_SECRET));
  const hq = requireRole('hq');
  const branch = requireRole('branch');

  const submitLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? 'anon',
    message: { error: 'rate_limited', message: 'Too many submissions, slow down.' },
  });

  r.post('/', branch, submitLimiter, async (req, res) => {
    const p = submitOrderSchema.safeParse(req.body);
    if (!p.success) {
      res.status(422).json({
        error: 'validation_failed',
        issues: p.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const orders = await submitOrder(req.user!, p.data);
    res.status(201).json({ orders });
  });

  r.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    res.json(await listOrders(req.user!, filterFrom(req), limit, skip));
  });

  r.get('/summary', async (req, res) => {
    res.json(await statusCounts(req.user!));
  });

  r.get('/last', branch, async (req, res) => {
    res.json({ supplierCodes: await lastSupplierCodes(req.user!) });
  });

  /** HQ: one workbook per request: a summary per supplier (how many branches ordered) and the order list. */
  r.get('/export', hq, async (req, res) => {
    const orders = await ordersForExport(filterFrom(req));
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet('By supplier');
    sum.addRow(['Supplier No.', 'Supplier', 'Orders', 'Branches']).font = { bold: true };
    const bySupplier = new Map<string, { name: string; n: number; branches: string[] }>();
    for (const o of orders) {
      const e = bySupplier.get(o.supplierCode) ?? { name: o.supplierName, n: 0, branches: [] };
      e.n += 1;
      e.branches.push(o.branchCode);
      bySupplier.set(o.supplierCode, e);
    }
    for (const [code, e] of bySupplier) sum.addRow([code, e.name, e.n, e.branches.join(', ')]);
    sum.columns = [{ width: 14 }, { width: 36 }, { width: 10 }, { width: 60 }];
    const by = wb.addWorksheet('Orders');
    by.addRow(['Order No.', 'Date', 'Branch No.', 'Branch', 'Supplier No.', 'Supplier', 'PO No.', 'Status']).font = { bold: true };
    for (const o of orders) {
      by.addRow([o.orderNo, o.createdAt.slice(0, 10), o.branchCode, o.branchName, o.supplierCode, o.supplierName, o.poNumber ?? '', STATUS_LABELS[o.status]]);
    }
    by.columns = [{ width: 20 }, { width: 12 }, { width: 12 }, { width: 24 }, { width: 14 }, { width: 36 }, { width: 16 }, { width: 20 }];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="orders.xlsx"')
      .send(buf);
  });

  r.get('/:id', async (req, res) => {
    res.json(await getOrder(req.user!, String(req.params.id)));
  });

  r.post('/:id/transition', async (req, res) => {
    const p = transitionSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(422, 'validation_failed');
    res.json(await transitionOrder(req.user!, String(req.params.id), p.data));
  });

  r.patch('/:id/po', hq, async (req, res) => {
    const p = poSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(422, 'validation_failed');
    res.json(await setPo(req.user!, String(req.params.id), p.data.poNumber));
  });

  return r;
}
