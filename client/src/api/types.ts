export type Role = 'branch' | 'hq'
export type OrderStatus = 'submitted' | 'approved' | 'rejected' | 'sent' | 'fulfilled' | 'cancelled'

export interface User {
  id: string
  username: string
  name: string
  role: Role
  branchCode?: string
  branchName?: string
  mustChangePassword: boolean
}
export interface Supplier {
  code: string
  name: string
  itemCount: number
}
export interface Item {
  itemNo: string
  description: string
  supplierCode: string
}
export interface Line {
  itemNo: string
  description: string
  qty: number
}
export interface Order {
  id: string
  orderNo: string
  branchCode: string
  branchName: string
  supplierCode: string
  supplierName: string
  status: OrderStatus
  lines: Line[]
  originalLines?: Line[]
  totalQty: number
  note?: string
  rejectionReason?: string
  poNumber?: string
  ledger?: { status: 'pending' | 'processing' | 'synced' | 'failed'; error?: string; syncedAt?: string }
  history: { status: string; at: string; by: string; note?: string }[]
  createdAt: string
  updatedAt: string
}
export interface OrderFilters {
  status?: OrderStatus | ''
  supplierCode?: string
  q?: string
  from?: string
  to?: string
}
export interface ImportResult {
  kind: string
  received: number
  written: number
  errors: { row: string; message: string }[]
  accounts?: { username: string; name: string; password: string }[]
}
export interface AdminUser {
  id: string
  username: string
  name: string
  role: Role
  branchCode?: string
  active: boolean
  lastLoginAt?: string
}
export interface AdminStats {
  suppliers: number
  items: number
  branches: number
  hasDemoData: boolean
  ledger: Record<string, number>
}
