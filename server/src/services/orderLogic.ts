/** Pure order rules (no database) so they can be tested offline. */

export const ORDER_STATUSES = ['submitted', 'approved', 'rejected', 'sent', 'fulfilled', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const STATUS_LABELS: Record<OrderStatus, string> = {
  submitted: 'Awaiting approval',
  approved: 'Approved',
  sent: 'Sent to supplier',
  fulfilled: 'Fulfilled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export type Role = 'branch' | 'hq';

const HQ_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['sent', 'cancelled'],
  sent: ['fulfilled'],
  rejected: [],
  fulfilled: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus, role: Role): boolean {
  if (role === 'branch') return from === 'submitted' && to === 'cancelled';
  return HQ_TRANSITIONS[from].includes(to);
}

export interface QtyLine {
  itemNo: string;
  qty: number;
}
export interface OrderLine extends QtyLine {
  description: string;
}
export interface CatalogItem {
  itemNo: string;
  description: string;
  supplierCode: string;
}

/** Merge duplicate item numbers (summing quantities) and normalise the codes. */
export function mergeLines(lines: readonly QtyLine[]): QtyLine[] {
  const out = new Map<string, number>();
  for (const l of lines) {
    const key = l.itemNo.trim().toUpperCase();
    out.set(key, (out.get(key) ?? 0) + l.qty);
  }
  return [...out].map(([itemNo, qty]) => ({ itemNo, qty }));
}

/** Split a basket into one group per supplier. Unknown item numbers are returned separately. */
export function groupBySupplier(
  lines: readonly QtyLine[],
  catalog: ReadonlyMap<string, CatalogItem>,
): { groups: Map<string, OrderLine[]>; unknown: string[] } {
  const groups = new Map<string, OrderLine[]>();
  const unknown: string[] = [];
  for (const l of mergeLines(lines)) {
    const item = catalog.get(l.itemNo);
    if (!item) {
      unknown.push(l.itemNo);
      continue;
    }
    const list = groups.get(item.supplierCode) ?? [];
    list.push({ itemNo: item.itemNo, description: item.description, qty: l.qty });
    groups.set(item.supplierCode, list);
  }
  return { groups, unknown };
}

/** HQ may only reduce/change quantities of lines already on the order, and must keep at least one. */
export function applyLineEdits(
  current: readonly OrderLine[],
  edits: readonly QtyLine[],
): { ok: true; lines: OrderLine[] } | { ok: false; error: string } {
  const byNo = new Map(current.map((l) => [l.itemNo, l]));
  const next: OrderLine[] = [];
  for (const e of mergeLines(edits)) {
    const base = byNo.get(e.itemNo);
    if (!base) return { ok: false, error: `${e.itemNo} is not on this order` };
    next.push({ ...base, qty: e.qty });
  }
  if (next.length === 0) return { ok: false, error: 'An order needs at least one line (reject it instead)' };
  return { ok: true, lines: next };
}

/** PO numbers come from HQ's PO system: keep them predictable for search and uniqueness. */
export function normalizePo(raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9/_-]{2,39}$/.test(v) ? v : null;
}

export interface SummaryRow {
  itemNo: string;
  description: string;
  qty: number;
}
/** Total quantity per item across orders (what HQ tells a supplier). */
export function totalsByItem(orders: readonly { lines: readonly OrderLine[] }[]): SummaryRow[] {
  const m = new Map<string, SummaryRow>();
  for (const o of orders) {
    for (const l of o.lines) {
      const row = m.get(l.itemNo);
      if (row) row.qty += l.qty;
      else m.set(l.itemNo, { itemNo: l.itemNo, description: l.description, qty: l.qty });
    }
  }
  return [...m.values()].sort((a, b) => a.itemNo.localeCompare(b.itemNo));
}

/**
 * Branches pick items only; HQ's standard quantities decide how much. Items with no known quantity for
 * the branch are not orderable. Duplicate picks collapse to one line.
 */
export function resolveQuantities(
  itemNos: readonly string[],
  orderable: ReadonlyMap<string, number>,
): { lines: QtyLine[]; notOrderable: string[] } {
  const lines: QtyLine[] = [];
  const notOrderable: string[] = [];
  for (const no of new Set(itemNos.map((n) => n.trim().toUpperCase()))) {
    const qty = orderable.get(no);
    if (qty === undefined) notOrderable.push(no);
    else lines.push({ itemNo: no, qty });
  }
  return { lines, notOrderable };
}
