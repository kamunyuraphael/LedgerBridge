import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/api'
import { errorMessage } from '../api/client'
import type { Order, OrderFilters, OrderStatus, Supplier } from '../api/types'
import { useAuth } from '../authContext'
import { Button, Card, ErrorBanner, StatusBadge, TextInput } from '../components/ui'
import { STATUS_LABEL, fmtDate } from '../format'
import { OrderDetail } from './OrderDetail'

const TABS: (OrderStatus | '')[] = ['submitted', 'approved', 'sent', 'fulfilled', 'rejected', 'cancelled', '']
const PAGE = 25

export function Orders() {
  const { user } = useAuth()
  const isHq = user?.role === 'hq'
  const [status, setStatus] = useState<OrderStatus | ''>(isHq ? 'submitted' : '')
  const [supplierCode, setSupplierCode] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const seq = useRef(0)

  const filters: OrderFilters = { status, supplierCode, q, from, to }

  const load = useCallback(async (f: OrderFilters, skip: number) => {
    const my = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const [res, c] = await Promise.all([api.orders(f, skip, PAGE), skip === 0 ? api.summary() : Promise.resolve(null)])
      if (my !== seq.current) return // a newer request superseded this one
      setOrders((prev) => (skip === 0 ? res.orders : [...prev, ...res.orders]))
      setTotal(res.total)
      if (c) setCounts(c)
    } catch (e) {
      if (my === seq.current) setError(errorMessage(e))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  // Debounce the free-text search; other filters apply immediately.
  useEffect(() => {
    const t = setTimeout(() => void load({ status, supplierCode, q, from, to }, 0), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, status, supplierCode, q, from, to])

  // HQ inbox refreshes itself so new orders appear without reloading.
  useEffect(() => {
    if (!isHq) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load({ status, supplierCode, q, from, to }, 0)
    }, 30_000)
    return () => clearInterval(id)
  }, [isHq, load, status, supplierCode, q, from, to])

  useEffect(() => {
    if (isHq) api.suppliers().then(setSuppliers).catch(() => undefined)
  }, [isHq])

  function applyUpdate(o: Order) {
    setOrders((prev) => prev.map((x) => (x.id === o.id ? o : x)))
    void api.summary().then(setCounts).catch(() => undefined)
    // The order may no longer match the current tab (e.g. approved from "Awaiting approval").
    if (status && o.status !== status) {
      setOrders((prev) => prev.filter((x) => x.id !== o.id))
      setTotal((t) => Math.max(0, t - 1))
    }
  }

  async function exportXlsx() {
    setExporting(true)
    try {
      const blob = await api.exportOrders(filters)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t || 'all'}
            onClick={() => setStatus(t)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
              status === t ? 'bg-[#064e3b] text-white' : 'bg-white text-[#354139] hover:bg-[#e8f0eb]'
            }`}
          >
            {t ? STATUS_LABEL[t] : 'All'}
            {t && counts[t] ? <span className="ml-1.5 opacity-70">{counts[t]}</span> : null}
          </button>
        ))}
      </div>

      <Card className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1fr_1fr_auto]">
        <TextInput placeholder={isHq ? 'Search order no., PO no., branch, item…' : 'Search order no., PO no., item…'} value={q} onChange={(e) => setQ(e.target.value)} />
        {isHq ? (
          <select
            aria-label="Supplier"
            value={supplierCode}
            onChange={(e) => setSupplierCode(e.target.value)}
            className="h-10 min-w-0 rounded-xl border border-[#d9ded9] bg-white px-3 text-sm"
          >
            <option value="">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        <TextInput type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextInput type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        {isHq && (
          <Button variant="secondary" onClick={() => void exportXlsx()} disabled={exporting}>
            {exporting ? 'Preparing…' : 'Export Excel'}
          </Button>
        )}
      </Card>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="bg-[#f6f8f6] text-left text-xs text-[#5b645e]">
              <tr>
                <th className="px-4 py-3 font-semibold">Order</th>
                {isHq && <th className="px-4 py-3 font-semibold">Branch</th>}
                <th className="px-4 py-3 font-semibold">Supplier</th>
                <th className="px-4 py-3 font-semibold">PO no.</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} onClick={() => setOpenId(o.id)} className="cursor-pointer border-t border-[#eef1ee] hover:bg-[#f6f8f6]">
                  <td className="px-4 py-3">
                    <div className="font-semibold">{o.orderNo}</div>
                    <div className="text-xs text-[#758078]">{fmtDate(o.createdAt)}</div>
                  </td>
                  {isHq && <td className="px-4 py-3">{o.branchName}</td>}
                  <td className="px-4 py-3">{o.supplierName}</td>
                  <td className="px-4 py-3">{o.poNumber ?? <span className="text-[#a7aea9]">—</span>}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={isHq ? 5 : 4} className="px-4 py-10 text-center text-[#758078]">
                    No orders here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <p className="border-t border-[#eef1ee] px-4 py-3 text-xs text-[#758078]">Loading…</p>}
        {!loading && orders.length < total && (
          <div className="border-t border-[#eef1ee] p-3 text-center">
            <Button variant="ghost" onClick={() => void load(filters, orders.length)}>
              Load more ({total - orders.length} left)
            </Button>
          </div>
        )}
      </Card>

      {openId && <OrderDetail id={openId} onClose={() => setOpenId(null)} onChanged={applyUpdate} />}
    </div>
  )
}
