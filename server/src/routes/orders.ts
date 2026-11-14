import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import ExcelJS from 'exceljs';
import type { Env } from '../config/env';
import { editLinesSchema, poSchema, submitOrderSchema, transitionSchema } from '../schemas/order';
import { requireAuth, requireRole } from '../services/auth';
import {
  editLines,
  getOrder,
  HttpError,
  lastOrderLines,
  listOrders,
  ordersForExport,
  setPo,
  statusCounts,
  submitOrder,
  transitionOrder,
  type OrderFilter,
} from '../services/orderService';
import { ORDER_STATUSES, totalsByItem, type OrderStatus } from '../services/orderLogic';

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

  r.get('/template/:supplierCode', branch, async (req, res) => {
    res.json({ itemNos: await lastOrderLines(req.user!, String(req.params.supplierCode)) });
  });

  /** HQ: one workbook per request: totals per item (what to tell the supplier) + per-branch breakdown. */
  r.get('/export', hq, async (req, res) => {
    const f = filterFrom(req);
    const orders = await ordersForExport(f);
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet('Summary');
    sum.addRow(['Item No.', 'Description', 'QTY']).font = { bold: true };
    for (const row of totalsByItem(orders)) sum.addRow([row.itemNo, row.description, row.qty]);
    sum.columns = [{ width: 14 }, { width: 52 }, { width: 10 }];
    const by = wb.addWorksheet('By branch');
    by.addRow(['Branch', 'Order No.', 'PO No.', 'Supplier', 'Item No.', 'Description', 'QTY']).font = { bold: true };
    for (const o of orders) {
      for (const l of o.lines) by.addRow([o.branchName, o.orderNo, o.poNumber ?? '', o.supplierName, l.itemNo, l.description, l.qty]);
    }
    by.columns = [{ width: 24 }, { width: 20 }, { width: 16 }, { width: 28 }, { width: 14 }, { width: 52 }, { width: 10 }];
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

  r.patch('/:id/lines', hq, async (req, res) => {
    const p = editLinesSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(422, 'validation_failed');
    res.json(await editLines(req.user!, String(req.params.id), p.data.lines));
  });

  r.patch('/:id/po', hq, async (req, res) => {
    const p = poSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(422, 'validation_failed');
    res.json(await setPo(req.user!, String(req.params.id), p.data.poNumber));
  });

  return r;
}
