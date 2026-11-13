import type { OrderStatus } from './api/types'

export const STATUS_LABEL: Record<OrderStatus, string> = {
  submitted: 'Awaiting approval',
  approved: 'Approved',
  sent: 'Sent to supplier',
  fulfilled: 'Fulfilled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

const dt = new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' })
export const fmtDate = (iso: string): string => dt.format(new Date(iso))
export const nf = new Intl.NumberFormat('en-US')
