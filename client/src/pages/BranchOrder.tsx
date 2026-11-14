import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/api'
import { errorMessage } from '../api/client'
import type { Item, Order, Supplier } from '../api/types'
import { useAuth } from '../authContext'
import { Button, Card, ErrorBanner, Notice, TextInput } from '../components/ui'

interface Saved {
  picked: string[]
  items: Record<string, Item>
}

function loadSaved(key: string): Saved {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const v = JSON.parse(raw) as Partial<Saved>
      if (Array.isArray(v.picked) && v.picked.every((x) => typeof x === 'string') && v.items && typeof v.items === 'object') return v as Saved
    }
  } catch {
    /* ignore */
  }
  return { picked: [], items: {} }
}

export function BranchOrder({ onViewOrders }: { onViewOrders: () => void }) {
  const { user } = useAuth()
  const storeKey = `lb.picks.${user?.username ?? ''}`
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [picked, setPicked] = useState<string[]>(() => loadSaved(storeKey).picked)
  const [known, setKnown] = useState<Record<string, Item>>(() => loadSaved(storeKey).items)
  const [search, setSearch] = useState('')
  const [supSearch, setSupSearch] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Order[] | null>(null)
  // One id per basket, reused on retry, so a double-click or a flaky connection can never create duplicates.
  const requestId = useRef<string | null>(null)

  useEffect(() => {
    api.suppliers().then(setSuppliers).catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ picked, items: known }))
    } catch {
      /* ignore */
    }
  }, [picked, known, storeKey])

  const select = useCallback(async (code: string) => {
    setSelected(code)
    setSearch('')
    setItemsLoading(true)
    setError(null)
    try {
      const list = await api.items(code)
      setItems(list)
      setKnown((k) => ({ ...k, ...Object.fromEntries(list.map((i) => [i.itemNo, i])) }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setItemsLoading(false)
    }
  }, [])

  function change(fn: (cur: string[]) => string[]) {
    requestId.current = null // the selection changed: this is a new submission
    setPicked(fn)
  }
  const toggle = (itemNo: string) => change((cur) => (cur.includes(itemNo) ? cur.filter((x) => x !== itemNo) : [...cur, itemNo]))

  async function repeatLast() {
    if (!selected) return
    try {
      const last = await api.lastLines(selected)
      if (!last.length) return setError('You have no earlier order for this supplier yet.')
      const valid = new Set(items.map((i) => i.itemNo))
      change((cur) => [...new Set([...cur, ...last.filter((n) => valid.has(n))])])
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const supplierName = useMemo(() => new Map((suppliers ?? []).map((s) => [s.code, s.name])), [suppliers])
  const perSupplier = useMemo(() => {
    const m = new Map<string, number>()
    for (const no of picked) {
      const code = known[no]?.supplierCode
      if (code) m.set(code, (m.get(code) ?? 0) + 1)
    }
    return m
  }, [picked, known])
  const totalLines = picked.length
  const chosen = useMemo(() => new Set(picked), [picked])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? items.filter((i) => i.description.toLowerCase().includes(q) || i.itemNo.toLowerCase().includes(q)) : items
  }, [items, search])
  const visibleSuppliers = useMemo(() => {
    const q = supSearch.trim().toLowerCase()
    return (suppliers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q))
  }, [suppliers, supSearch])

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
          Order{done.length > 1 ? 's' : ''} submitted. HQ can see {done.length > 1 ? 'them' : 'it'} now.
        </Notice>
        <ul className="divide-y divide-[#eef1ee] text-sm">
          {done.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <span>
                <span className="font-semibold">{o.orderNo}</span> · {o.supplierName}
              </span>
              <span className="text-[#5b645e]">{o.lines.length} items</span>
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
    const groups = new Map<string, string[]>()
    for (const no of picked) {
      const code = known[no]?.supplierCode ?? '?'
      groups.set(code, [...(groups.get(code) ?? []), no])
    }
    return (
      <Card className="mx-auto max-w-2xl space-y-5">
        <h2 className="font-display text-lg font-bold text-[#064e3b]">Review your order</h2>
        <p className="text-sm text-[#5b645e]">
          This will be sent as {groups.size} separate order{groups.size > 1 ? 's' : ''}, one per supplier. HQ applies the usual quantities.
        </p>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {[...groups].map(([code, nos]) => (
          <div key={code}>
            <h3 className="mb-1.5 text-sm font-semibold">{supplierName.get(code) ?? code}</h3>
            <table className="w-full text-sm">
              <tbody>
                {nos.map((no) => (
                  <tr key={no} className="border-t border-[#eef1ee]">
                    <td className="py-1.5 pr-2 text-[#758078]">{no}</td>
                    <td className="py-1.5">{known[no]?.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <Card className="space-y-3">
        <h2 className="font-display text-base font-bold text-[#064e3b]">1. Choose a supplier</h2>
        <TextInput placeholder="Search suppliers" value={supSearch} onChange={(e) => setSupSearch(e.target.value)} />
        {suppliers === null ? (
          <p className="text-sm text-[#758078]">Loading…</p>
        ) : visibleSuppliers.length === 0 ? (
          <p className="text-sm text-[#758078]">No suppliers found.</p>
        ) : (
          <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {visibleSuppliers.map((s) => (
              <li key={s.code}>
                <button
                  onClick={() => void select(s.code)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    selected === s.code ? 'bg-[#064e3b] text-white' : 'hover:bg-[#f0f4f1]'
                  }`}
                >
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="flex flex-none items-center gap-2 text-xs opacity-80">
                    {perSupplier.get(s.code) ? (
                      <span className="rounded-full bg-[#bbf7d0] px-2 py-0.5 font-semibold text-[#064e3b]">{perSupplier.get(s.code)} in order</span>
                    ) : null}
                    {s.itemCount} {s.itemCount === 1 ? 'item' : 'items'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-base font-bold text-[#064e3b]">
            2. Tick what you need{selected ? ` · ${supplierName.get(selected) ?? ''}` : ''}
          </h2>
          {selected && (
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => void repeatLast()}>
              Repeat my last order
            </Button>
          )}
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!selected ? (
          <p className="text-sm text-[#758078]">Pick a supplier on the left to see the products you can order. HQ applies the usual quantities.</p>
        ) : itemsLoading ? (
          <p className="text-sm text-[#758078]">Loading products…</p>
        ) : (
          <>
            <TextInput placeholder="Search products or item numbers" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="flex items-center justify-between text-xs text-[#5b645e]">
              <span>
                {filtered.filter((i) => chosen.has(i.itemNo)).length} of {filtered.length} selected
              </span>
              <span className="flex gap-1">
                <button className="rounded-lg px-2 py-1 font-semibold text-[#064e3b] hover:bg-[#e8f0eb]" onClick={() => change((cur) => [...new Set([...cur, ...filtered.map((i) => i.itemNo)])])}>
                  Select all
                </button>
                <button className="rounded-lg px-2 py-1 font-semibold text-[#064e3b] hover:bg-[#e8f0eb]" onClick={() => change((cur) => cur.filter((n) => !filtered.some((i) => i.itemNo === n)))}>
                  Clear
                </button>
              </span>
            </div>
            <ul className="max-h-[28rem] divide-y divide-[#eef1ee] overflow-y-auto pr-1">
              {filtered.map((i) => {
                const on = chosen.has(i.itemNo)
                return (
                  <li key={i.itemNo}>
                    <label className={`flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition ${on ? 'bg-[#eaf5ee]' : 'hover:bg-[#f6f8f6]'}`}>
                      <input type="checkbox" className="h-5 w-5 flex-none accent-[#064e3b]" checked={on} onChange={() => toggle(i.itemNo)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{i.description}</span>
                        <span className="text-xs text-[#758078]">{i.itemNo}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
              {filtered.length === 0 && <li className="py-3 text-sm text-[#758078]">No products match.</li>}
            </ul>
          </>
        )}
      </Card>

      <div className="sticky bottom-3 z-10 lg:col-span-2">
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#064e3b] px-5 py-3 text-white shadow-lg">
          <span className="text-sm">
            <strong>{totalLines}</strong> item{totalLines === 1 ? '' : 's'} from <strong>{perSupplier.size}</strong> supplier
            {perSupplier.size === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            {totalLines > 0 && (
              <button className="h-10 rounded-xl px-4 text-sm font-semibold text-white hover:bg-white/10" onClick={() => change(() => [])}>
                Clear
              </button>
            )}
            <button
              className="h-10 rounded-xl bg-white px-4 text-sm font-semibold text-[#064e3b] hover:bg-[#e8f0eb] disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-white/70"
              disabled={totalLines === 0}
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
