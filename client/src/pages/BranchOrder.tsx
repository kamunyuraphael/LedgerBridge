import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/api'
import { errorMessage } from '../api/client'
import type { Order, Supplier } from '../api/types'
import { useAuth } from '../authContext'
import { Button, Card, ErrorBanner, Notice, TextInput } from '../components/ui'

function loadPicked(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const v: unknown = JSON.parse(raw)
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
    }
  } catch {
    /* ignore */
  }
  return []
}

export function BranchOrder({ onViewOrders }: { onViewOrders: () => void }) {
  const { user } = useAuth()
  const storeKey = `lb.suppliers.${user?.username ?? ''}`
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [picked, setPicked] = useState<string[]>(() => loadPicked(storeKey))
  const [search, setSearch] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Order[] | null>(null)
  // One id per selection, reused on retry, so a double-click or a flaky connection can never create duplicates.
  const requestId = useRef<string | null>(null)

  useEffect(() => {
    api
      .suppliers()
      .then((list) => {
        setSuppliers(list)
        const valid = new Set(list.map((s) => s.code))
        setPicked((cur) => cur.filter((c) => valid.has(c)))
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(picked))
    } catch {
      /* ignore */
    }
  }, [picked, storeKey])

  function change(fn: (cur: string[]) => string[]) {
    requestId.current = null // the selection changed: this is a new submission
    setPicked(fn)
  }
  const toggle = (code: string) => change((cur) => (cur.includes(code) ? cur.filter((x) => x !== code) : [...cur, code]))

  async function repeatLast() {
    setError(null)
    try {
      const last = await api.lastSuppliers()
      if (!last.length) return setError('You have no earlier order yet.')
      const valid = new Set((suppliers ?? []).map((s) => s.code))
      change((cur) => [...new Set([...cur, ...last.filter((c) => valid.has(c))])])
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const names = useMemo(() => new Map((suppliers ?? []).map((s) => [s.code, s.name])), [suppliers])
  const chosen = useMemo(() => new Set(picked), [picked])
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (suppliers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
  }, [suppliers, search])

  async function submit() {
    setSubmitting(true)
    setError(null)
    requestId.current ??= crypto.randomUUID()
    try {
      const orders = await api.submitOrder(requestId.current, picked, note.trim())
      setDone(orders)
      setPicked([])
      setNote('')
      setReviewing(false)
      requestId.current = null
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <Card className="mx-auto max-w-xl space-y-4">
        <Notice>
          {done.length > 1 ? `${done.length} orders submitted` : 'Order submitted'}. HQ can see {done.length > 1 ? 'them' : 'it'} now.
        </Notice>
        <ul className="divide-y divide-[#eef1ee] text-sm">
          {done.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="font-semibold">{o.supplierName}</span>
              <span className="text-[#5b645e]">{o.orderNo}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button onClick={() => setDone(null)}>New order</Button>
          <Button variant="secondary" onClick={onViewOrders}>
            View my orders
          </Button>
        </div>
      </Card>
    )
  }

  if (reviewing) {
    return (
      <Card className="mx-auto max-w-xl space-y-5">
        <h2 className="font-display text-lg font-bold text-[#064e3b]">Review your order</h2>
        <p className="text-sm text-[#5b645e]">
          HQ will receive {picked.length} order{picked.length > 1 ? 's' : ''}, one per supplier. HQ decides the products and quantities.
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <ul className="divide-y divide-[#eef1ee] text-sm">
          {picked.map((c) => (
            <li key={c} className="py-2">
              {names.get(c) ?? c}
            </li>
          ))}
        </ul>
        <TextInput placeholder="Note for HQ (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit order'}
          </Button>
          <Button variant="secondary" onClick={() => setReviewing(false)} disabled={submitting}>
            Back
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-base font-bold text-[#064e3b]">Which suppliers do you need to order from?</h2>
          <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => void repeatLast()}>
            Repeat my last order
          </Button>
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <TextInput placeholder="Search suppliers" value={search} onChange={(e) => setSearch(e.target.value)} />
        {suppliers === null ? (
          <p className="text-sm text-[#758078]">Loading…</p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-[#eef1ee] overflow-y-auto pr-1">
            {visible.map((s) => {
              const on = chosen.has(s.code)
              return (
                <li key={s.code}>
                  <label className={`flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition ${on ? 'bg-[#eaf5ee]' : 'hover:bg-[#f6f8f6]'}`}>
                    <input type="checkbox" className="h-5 w-5 flex-none accent-[#064e3b]" checked={on} onChange={() => toggle(s.code)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-[#758078]">{s.code}</span>
                  </label>
                </li>
              )
            })}
            {visible.length === 0 && <li className="py-3 text-sm text-[#758078]">No suppliers match.</li>}
          </ul>
        )}
      </Card>

      <div className="sticky bottom-3 z-10">
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#064e3b] px-5 py-3 text-white shadow-lg">
          <span className="text-sm">
            <strong>{picked.length}</strong> supplier{picked.length === 1 ? '' : 's'} selected
          </span>
          <div className="flex gap-2">
            {picked.length > 0 && (
              <button className="h-10 rounded-xl px-4 text-sm font-semibold text-white hover:bg-white/10" onClick={() => change(() => [])}>
                Clear
              </button>
            )}
            <button
              className="h-10 rounded-xl bg-white px-4 text-sm font-semibold text-[#064e3b] hover:bg-[#e8f0eb] disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-white/70"
              disabled={picked.length === 0}
              onClick={() => setReviewing(true)}
            >
              Review &amp; submit
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
