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

/** Normalise the suppliers a branch ticked: trim, upper-case, drop blanks and duplicates (order kept). */
export function uniqueSupplierCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
}

/** PO numbers come from HQ's PO system: keep them predictable for search and uniqueness. */
export function normalizePo(raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9/_-]{2,39}$/.test(v) ? v : null;
}
