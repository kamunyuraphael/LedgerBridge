import axios from 'axios'
import type { SaleInput } from '../schemas/sale'

export type SyncStatus = 'pending' | 'processing' | 'synced' | 'failed'

export interface SaleRecord {
  recordId: string
  storeCode: string
  sku: string
  unitsSold: number
  totalRevenue: number
  timestamp: string
  syncStatus: SyncStatus
  attempts: number
  lastError?: string
  syncedAt?: string
  ledgerFile?: string
}

export interface ValidationIssue {
  field: string
  message: string
}

// VITE_API_URL is only a public base URL (never a secret). Empty = same origin / dev proxy.
const http = axios.create({
  baseURL: (import.meta.env.VITE_API_URL as string | undefined) ?? '',
  timeout: 10_000,
})

export class ApiValidationError extends Error {
  readonly issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super('Server rejected the submission')
    this.issues = issues
  }
}

export async function submitSale(input: SaleInput): Promise<{ record: SaleRecord; ackMs: number }> {
  const started = performance.now()
  try {
    const res = await http.post<SaleRecord>('/api/sales', input)
    return { record: res.data, ackMs: Math.round(performance.now() - started) }
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      const issues = (err.response.data as { issues?: ValidationIssue[] }).issues ?? []
      throw new ApiValidationError(issues)
    }
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      throw new Error('Too many submissions. Please wait a moment and retry.')
    }
    if (axios.isAxiosError(err) && !err.response) {
      throw new Error('Cannot reach the server. Check your connection and retry.')
    }
    throw new Error('Something went wrong while saving. Please retry.')
  }
}

export async function fetchRecent(limit = 8): Promise<SaleRecord[]> {
  const res = await http.get<SaleRecord[]>('/api/sales', { params: { limit } })
  return res.data
}

export interface Health {
  status: 'ok' | 'degraded'
  db: boolean
  graphMode: 'live' | 'onedrive' | 'sheets' | 'mock'
}

/** Resolves to null when the API is unreachable. A 503 (DB down) still returns its body. */
export async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await http.get<Health>('/api/health', { validateStatus: () => true, timeout: 5000 })
    return typeof res.data === 'object' && res.data && 'status' in res.data ? res.data : null
  } catch {
    return null
  }
}
