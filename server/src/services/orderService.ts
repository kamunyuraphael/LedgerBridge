import { Item, Supplier, Branch } from '../models/catalog';
import { Counter, Order } from '../models/Order';
import {
  applyLineEdits,
  canTransition,
  groupBySupplier,
  normalizePo,
  type CatalogItem,
  type OrderLine,
  type OrderStatus,
  type QtyLine,
  type Role,
} from './orderLogic';
import type { AuthUser } from './auth';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const isDuplicateKey = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;

/** Order numbers are per-day sequences in Nairobi time, e.g. ORD-20261113-0007. */
async function nextOrderNo(): Promise<string> {
  const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const c = await Counter.findOneAndUpdate({ _id: `order-${day}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `ORD-${day}-${String(c.seq).padStart(4, '0')}`;
}

/** Fields that put an order back in the ledger queue (callers also $inc ledgerRev). */
const ledgerRequeue = () => ({ ledgerStatus: 'pending' as const, ledgerAttempts: 0, ledgerNextAt: new Date() });

export type OrderDoc = Awaited<ReturnType<typeof Order.create>>;
type Lean = {
  _id: unknown;
  orderNo: string;
  requestId: string;
  branchCode: string;
  branchName: string;
  supplierCode: string;
  supplierName: string;
  lines: OrderLine[];
  originalLines?: OrderLine[] | null;
  status: OrderStatus;
  note?: string | null;
  rejectionReason?: string | null;
  poNumber?: string | null;
  ledgerStatus?: 'pending' | 'processing' | 'synced' | 'failed' | null;
  ledgerError?: string | null;
  ledgerSyncedAt?: Date | null;
  history: { status: string; at: Date; by: string; note?: string | null }[];
  createdAt: Date;
  updatedAt: Date;
};

export function presentOrder(o: Lean) {
  return {
    id: String(o._id),
    orderNo: o.orderNo,
    branchCode: o.branchCode,
    branchName: o.branchName,
    supplierCode: o.supplierCode,
    supplierName: o.supplierName,
    status: o.status,
    lines: o.lines.map((l) => ({ itemNo: l.itemNo, description: l.description, qty: l.qty })),
    originalLines: o.originalLines?.map((l) => ({ itemNo: l.itemNo, description: l.description, qty: l.qty })),
    totalQty: o.lines.reduce((n, l) => n + l.qty, 0),
    note: o.note ?? undefined,
    rejectionReason: o.rejectionReason ?? undefined,
    poNumber: o.poNumber ?? undefined,
    ledger: o.ledgerStatus
      ? { status: o.ledgerStatus, error: o.ledgerStatus === 'failed' ? (o.ledgerError ?? undefined) : undefined, syncedAt: o.ledgerSyncedAt?.toISOString() }
      : undefined,
    history: o.history.map((h) => ({ status: h.status, at: h.at.toISOString(), by: h.by, note: h.note ?? undefined })),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

/** One basket in, one order per supplier out. Safe to retry with the same requestId. */
export async function submitOrder(user: AuthUser, input: { requestId: string; note?: string | undefined; lines: QtyLine[] }) {
  if (user.role !== 'branch' || !user.branchCode) throw new HttpError(403, 'forbidden', 'Only branch accounts can place orders');
  const branch = await Branch.findOne({ code: user.branchCode, active: true }).lean();
  if (!branch) throw new HttpError(403, 'branch_inactive', 'Your branch is not active');

  const wanted = [...new Set(input.lines.map((l) => l.itemNo.trim().toUpperCase()))];
  const found = await Item.find({ itemNo: { $in: wanted }, active: true }).lean();
  const catalog = new Map<string, CatalogItem>(found.map((i) => [i.itemNo, i]));
  const { groups, unknown } = groupBySupplier(input.lines, catalog);
  if (unknown.length) throw new HttpError(422, 'unknown_items', `Unknown or inactive items: ${unknown.join(', ')}`);

  const suppliers = await Supplier.find({ code: { $in: [...groups.keys()] } }).lean();
  const supplierName = new Map(suppliers.map((s) => [s.code, s.name]));
  const now = new Date();
  const out = [];
  for (const [supplierCode, lines] of groups) {
    const existing = await Order.findOne({ branchCode: branch.code, requestId: input.requestId, supplierCode }).lean();
    if (existing) {
      out.push(presentOrder(existing as unknown as Lean));
      continue;
    }
    try {
      const created = await Order.create({
        orderNo: await nextOrderNo(),
        requestId: input.requestId,
        branchCode: branch.code,
        branchName: branch.name,
        supplierCode,
        supplierName: supplierName.get(supplierCode) ?? supplierCode,
        lines,
        status: 'submitted',
        ...(input.note ? { note: input.note } : {}),
        history: [{ status: 'submitted', at: now, by: user.username }],
        createdBy: user.username,
      });
      out.push(presentOrder(created.toObject() as unknown as Lean));
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const raced = await Order.findOne({ branchCode: branch.code, requestId: input.requestId, supplierCode }).lean();
      if (!raced) throw e;
      out.push(presentOrder(raced as unknown as Lean));
    }
  }
  return out;
}

async function loadFor(user: AuthUser, id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(404, 'not_found');
  const o = await Order.findById(id).lean();
  if (!o || (user.role === 'branch' && o.branchCode !== user.branchCode)) throw new HttpError(404, 'not_found');
  return o as unknown as Lean;
}
export const getOrder = async (user: AuthUser, id: string) => presentOrder(await loadFor(user, id));

export async function transitionOrder(
  user: AuthUser,
  id: string,
  input: { to: OrderStatus; reason?: string | undefined; poNumber?: string | undefined },
) {
  const o = await loadFor(user, id);
  const role: Role = user.role;
  if (!canTransition(o.status, input.to, role)) {
    throw new HttpError(409, 'invalid_transition', `Cannot move an order from ${o.status} to ${input.to}`);
  }
  const set: Record<string, unknown> = { status: input.to };
  if (input.to === 'rejected') {
    if (!input.reason) throw new HttpError(422, 'reason_required', 'Give a reason when rejecting an order');
    set.rejectionReason = input.reason;
  }
  if (input.poNumber) {
    if (input.to !== 'approved' && input.to !== 'sent') throw new HttpError(422, 'po_not_allowed', 'PO number is set on approval or when sent');
    const po = normalizePo(input.poNumber);
    if (!po) throw new HttpError(422, 'invalid_po', 'PO number must be 3-40 letters, digits, / _ or -');
    set.poNumber = po;
  }
  // Approved orders (and any later PO/status change) are queued for the ledger sheet.
  const requeue = input.to === 'approved' || Boolean(o.ledgerStatus);
  if (input.to === 'approved') set.approvedAt = new Date();
  if (requeue) Object.assign(set, ledgerRequeue());
  try {
    // Atomic: only moves if nobody else changed the status meanwhile.
    const updated = await Order.findOneAndUpdate(
      { _id: id, status: o.status },
      {
        $set: set,
        ...(requeue ? { $inc: { ledgerRev: 1 } } : {}),
        $push: { history: { status: input.to, at: new Date(), by: user.username, ...(input.reason ? { note: input.reason } : {}) } },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new HttpError(409, 'conflict', 'The order was changed by someone else; refresh and retry');
    return presentOrder(updated as unknown as Lean);
  } catch (e) {
    if (isDuplicateKey(e)) throw new HttpError(409, 'po_in_use', 'That PO number is already used on another order');
    throw e;
  }
}

export async function editLines(user: AuthUser, id: string, edits: QtyLine[]) {
  const o = await loadFor(user, id);
  if (o.status !== 'submitted') throw new HttpError(409, 'locked', 'Only submitted orders can be edited');
  const r = applyLineEdits(o.lines, edits);
  if (!r.ok) throw new HttpError(422, 'invalid_lines', r.error);
  const updated = await Order.findOneAndUpdate(
    { _id: id, status: 'submitted' },
    {
      $set: { lines: r.lines, ...(o.originalLines?.length ? {} : { originalLines: o.lines }) },
      $push: { history: { status: 'submitted', at: new Date(), by: user.username, note: 'Quantities edited by HQ' } },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw new HttpError(409, 'conflict', 'The order was changed by someone else; refresh and retry');
  return presentOrder(updated as unknown as Lean);
}

export async function setPo(user: AuthUser, id: string, raw: string) {
  const o = await loadFor(user, id);
  if (!['approved', 'sent', 'fulfilled'].includes(o.status)) throw new HttpError(409, 'not_approved', 'Approve the order before adding a PO number');
  const po = normalizePo(raw);
  if (!po) throw new HttpError(422, 'invalid_po', 'PO number must be 3-40 letters, digits, / _ or -');
  try {
    const updated = await Order.findByIdAndUpdate(
      id,
      {
        $set: { poNumber: po, ...ledgerRequeue() },
        $inc: { ledgerRev: 1 },
        $push: { history: { status: o.status, at: new Date(), by: user.username, note: `PO number ${po}` } },
      },
      { returnDocument: 'after' },
    ).lean();
    return presentOrder(updated as unknown as Lean);
  } catch (e) {
    if (isDuplicateKey(e)) throw new HttpError(409, 'po_in_use', 'That PO number is already used on another order');
    throw e;
  }
}

export interface OrderFilter {
  status?: OrderStatus | undefined;
  supplierCode?: string | undefined;
  branchCode?: string | undefined;
  q?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildFilter(user: AuthUser, f: OrderFilter): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (user.role === 'branch') q.branchCode = user.branchCode;
  else if (f.branchCode) q.branchCode = f.branchCode.toUpperCase();
  if (f.status) q.status = f.status;
  if (f.supplierCode) q.supplierCode = f.supplierCode.toUpperCase();
  if (f.from || f.to) q.createdAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) };
  if (f.q) {
    const re = new RegExp(escapeRe(f.q.trim()), 'i');
    q.$or = [{ orderNo: re }, { poNumber: re }, { branchName: re }, { supplierName: re }, { 'lines.itemNo': re }];
  }
  return q;
}

export async function listOrders(user: AuthUser, f: OrderFilter, limit: number, skip: number) {
  const filter = buildFilter(user, f);
  const [rows, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return { total, orders: rows.map((r) => presentOrder(r as unknown as Lean)) };
}

export async function statusCounts(user: AuthUser): Promise<Record<string, number>> {
  const rows = await Order.aggregate<{ _id: string; n: number }>([
    { $match: buildFilter(user, {}) },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/** The branch's most recent order for a supplier, for the "repeat last order" button. */
export async function lastOrderLines(user: AuthUser, supplierCode: string) {
  const o = await Order.findOne({ branchCode: user.branchCode, supplierCode: supplierCode.toUpperCase(), status: { $ne: 'cancelled' } })
    .sort({ createdAt: -1 })
    .lean();
  return o ? (o.lines as unknown as OrderLine[]).map((l) => ({ itemNo: l.itemNo, qty: l.qty })) : [];
}

export async function ordersForExport(f: OrderFilter) {
  const rows = await Order.find(buildFilter({ role: 'hq' } as AuthUser, f)).sort({ branchCode: 1, createdAt: 1 }).lean();
  return rows.map((r) => presentOrder(r as unknown as Lean));
}
