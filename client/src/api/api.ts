import { http } from './client'
import type { AdminStats, AdminUser, ImportResult, Order, OrderFilters, Supplier, User } from './types'

export interface Health {
  status: 'ok' | 'degraded'
  db: boolean
}

export const api = {
  async health(): Promise<Health | null> {
    try {
      const r = await http.get<Health>('/api/health', { validateStatus: () => true, timeout: 5000 })
      return typeof r.data === 'object' && r.data && 'status' in r.data ? r.data : null
    } catch {
      return null
    }
  },
  async login(username: string, password: string) {
    return (await http.post<{ token: string; user: User }>('/api/auth/login', { username, password })).data
  },
  async me() {
    return (await http.get<{ user: User }>('/api/auth/me')).data.user
  },
  async changePassword(currentPassword: string, newPassword: string) {
    await http.post('/api/auth/change-password', { currentPassword, newPassword })
  },

  async suppliers() {
    return (await http.get<Supplier[]>('/api/catalogue/suppliers')).data
  },

  // Branches pick suppliers only; HQ's own system decides products and quantities.
  async submitOrder(requestId: string, supplierCodes: string[], note: string) {
    return (await http.post<{ orders: Order[] }>('/api/orders', { requestId, supplierCodes, ...(note ? { note } : {}) })).data.orders
  },
  async orders(filters: OrderFilters, skip = 0, limit = 25) {
    return (await http.get<{ total: number; orders: Order[] }>('/api/orders', { params: { ...clean(filters), skip, limit } })).data
  },
  async summary() {
    return (await http.get<Record<string, number>>('/api/orders/summary')).data
  },
  async lastSuppliers() {
    return (await http.get<{ supplierCodes: string[] }>('/api/orders/last')).data.supplierCodes
  },
  async transition(id: string, to: string, extra: { reason?: string; poNumber?: string } = {}) {
    return (await http.post<Order>(`/api/orders/${id}/transition`, { to, ...extra })).data
  },
  async setPo(id: string, poNumber: string) {
    return (await http.patch<Order>(`/api/orders/${id}/po`, { poNumber })).data
  },
  async exportOrders(filters: OrderFilters) {
    const r = await http.get<Blob>('/api/orders/export', { params: clean(filters), responseType: 'blob', timeout: 60_000 })
    return r.data
  },

  async stats() {
    return (await http.get<AdminStats>('/api/admin/stats')).data
  },
  async clearDemo() {
    return (await http.post<{ orders: number; users: number; branches: number }>('/api/admin/demo/clear')).data
  },
  async retryLedger() {
    return (await http.post<{ requeued: number }>('/api/admin/ledger/retry-failed')).data
  },
  async importFile(kind: 'suppliers' | 'branches', file: File, flag: boolean) {
    const r = await http.post<ImportResult>(`/api/admin/import/${kind}`, await file.arrayBuffer(), {
      params: kind === 'branches' && flag ? { createAccounts: 'true' } : {},
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 120_000,
    })
    return r.data
  },
  async users() {
    return (await http.get<AdminUser[]>('/api/admin/users')).data
  },
  async branches() {
    return (await http.get<{ code: string; name: string; active: boolean; hasLogin: boolean }[]>('/api/admin/branches')).data
  },
  async createUser(u: { username: string; name: string; role: 'branch' | 'hq'; branchCode?: string; password?: string }) {
    return (await http.post<{ username: string; password: string }>('/api/admin/users', u)).data
  },
  async setUserActive(id: string, active: boolean) {
    await http.patch(`/api/admin/users/${id}`, { active })
  },
  async resetPassword(id: string) {
    return (await http.post<{ username: string; password: string }>(`/api/admin/users/${id}/reset-password`)).data
  },
}

function clean(f: OrderFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string' && v !== '')) as Record<string, string>
}
