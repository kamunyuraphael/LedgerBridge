import { useEffect, useState } from 'react'
import { api } from '../api/api'
import { errorMessage, http } from '../api/client'
import type { Order } from '../api/types'
import { useAuth } from '../authContext'
import { Button, ErrorBanner, StatusBadge, TextInput } from '../components/ui'
import { fmtDate, nf } from '../format'

export function OrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (o: Order) => void }) {
  const { user } = useAuth()
  const isHq = user?.role === 'hq'
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [qtys, setQtys] = useState<Record<string, string>>({})
  const [po, setPo] = useState('')
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)

  useEffect(() => {
    let alive = true
    http
      .get<Order>(`/api/orders/${id}`)
      .then((r) => alive && setOrder(r.data))
      .catch((e) => alive && setError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [id])

  async function run(fn: () => Promise<Order>) {
    setBusy(true)
    setError(null)
    try {
      const o = await fn()
      setOrder(o)
      onChanged(o)
      setEditing(false)
      setRejecting(false)
      setPo('')
      setReason('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function startEdit() {
    if (!order) return
    setQtys(Object.fromEntries(order.lines.map((l) => [l.itemNo, String(l.qty ?? '')])))
    setEditing(true)
  }
  const edited = order
    ? order.lines
        .map((l) => ({ itemNo: l.itemNo, qty: Math.min(parseInt(qtys[l.itemNo] ?? '', 10) || 0, 100_000) }))
        .filter((l) => l.qty > 0)
    : []

  const o = order
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Order details"
        className="h-full w-full max-w-xl space-y-5 overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-[#064e3b]">{o?.orderNo ?? 'Order'}</h2>
            {o && (
              <p className="text-sm text-[#5b645e]">
                {o.branchName} → {o.supplierName}
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!o ? (
          !error && <p className="text-sm text-[#758078]">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <StatusBadge status={o.status} />
              <span className="text-[#758078]">Placed {fmtDate(o.createdAt)}</span>
              {o.poNumber && <span className="rounded-lg bg-[#f0f4f1] px-2 py-0.5 font-semibold">PO no. {o.poNumber}</span>}
              {isHq && o.ledger && (
                <span
                  title={o.ledger.error}
                  className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${o.ledger.status === 'failed' ? 'bg-[#f8e1de] text-[#aa3e35]' : o.ledger.status === 'synced' ? 'bg-[#e2f2e7] text-[#176044]' : 'bg-[#fbf1d6] text-[#855a0a]'}`}
                >
                  {o.ledger.status === 'synced' ? 'Recorded in sheet' : o.ledger.status === 'failed' ? 'Sheet sync failed' : 'Sheet sync queued'}
                </span>
              )}
            </div>
            {o.note && <p className="rounded-xl bg-[#f6f8f6] px-4 py-3 text-sm">Branch note: {o.note}</p>}
            {o.rejectionReason && <ErrorBanner>Rejected: {o.rejectionReason}</ErrorBanner>}

            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[#5b645e]">
                <tr>
                  <th className="py-2 font-semibold">Item</th>
                  {isHq && <th className="py-2 text-right font-semibold">Qty</th>}
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => {
                  const was = o.originalLines?.find((x) => x.itemNo === l.itemNo)?.qty
                  return (
                    <tr key={l.itemNo} className="border-t border-[#eef1ee]">
                      <td className="py-2 pr-2">
                        <div>{l.description}</div>
                        <div className="text-xs text-[#758078]">{l.itemNo}</div>
                      </td>
                      {isHq && <td className="py-2 text-right">
                        {editing ? (
                          <input
                            inputMode="numeric"
                            aria-label={`Quantity for ${l.description}`}
                            value={qtys[l.itemNo] ?? ''}
                            onChange={(e) => setQtys((q) => ({ ...q, [l.itemNo]: e.target.value.replace(/\D/g, '') }))}
                            className="h-9 w-24 rounded-lg border border-[#d9ded9] px-2 text-right font-semibold"
                          />
                        ) : (
                          <>
                            <span className="font-semibold">{nf.format(l.qty ?? 0)}</span>
                            {was !== undefined && was !== l.qty && <div className="text-xs text-[#aa3e35]">asked {nf.format(was)}</div>}
                          </>
                        )}
                      </td>}
                    </tr>
                  )
                })}
                {o.originalLines
                  ?.filter((x) => !o.lines.some((l) => l.itemNo === x.itemNo))
                  .map((x) => (
                    <tr key={x.itemNo} className="border-t border-[#eef1ee] text-[#aa3e35] line-through">
                      <td className="py-2 pr-2">{x.description}</td>
                      {isHq && <td className="py-2 text-right">{nf.format(x.qty ?? 0)}</td>}
                    </tr>
                  ))}
              </tbody>
            </table>
            {editing && <p className="text-xs text-[#758078]">Set a quantity to 0 to remove that line. Changes are recorded in the order history.</p>}

            {/* ---- actions ---- */}
            {isHq && o.status === 'submitted' && (
              <div className="space-y-3 rounded-2xl bg-[#f6f8f6] p-4">
                {editing ? (
                  <div className="flex gap-2">
                    <Button disabled={busy || edited.length === 0} onClick={() => void run(() => api.editLines(o.id, edited))}>
                      Save quantities
                    </Button>
                    <Button variant="secondary" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : rejecting ? (
                  <>
                    <TextInput placeholder="Reason for rejecting (required)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void run(() => api.transition(o.id, 'rejected', { reason: reason.trim() }))}>
                        Reject order
                      </Button>
                      <Button variant="secondary" onClick={() => setRejecting(false)}>
                        Back
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <TextInput placeholder="PO number from the PO system (optional, can add later)" value={po} onChange={(e) => setPo(e.target.value)} />
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={() => void run(() => api.transition(o.id, 'approved', po.trim() ? { poNumber: po } : {}))}>
                        Approve
                      </Button>
                      <Button variant="secondary" onClick={startEdit}>
                        Edit quantities
                      </Button>
                      <Button variant="danger" onClick={() => setRejecting(true)}>
                        Reject
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {isHq && (o.status === 'approved' || o.status === 'sent' || o.status === 'fulfilled') && (
              <div className="space-y-3 rounded-2xl bg-[#f6f8f6] p-4">
                <div className="flex gap-2">
                  <TextInput placeholder={o.poNumber ? 'Change PO number' : 'Add PO number'} value={po} onChange={(e) => setPo(e.target.value)} />
                  <Button variant="secondary" disabled={busy || !po.trim()} onClick={() => void run(() => api.setPo(o.id, po))}>
                    Save PO
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {o.status === 'approved' && (
                    <Button disabled={busy} onClick={() => void run(() => api.transition(o.id, 'sent'))}>
                      Mark sent to supplier
                    </Button>
                  )}
                  {o.status === 'sent' && (
                    <Button disabled={busy} onClick={() => void run(() => api.transition(o.id, 'fulfilled'))}>
                      Mark fulfilled
                    </Button>
                  )}
                  {o.status === 'approved' && (
                    <Button variant="danger" disabled={busy} onClick={() => void run(() => api.transition(o.id, 'cancelled'))}>
                      Cancel order
                    </Button>
                  )}
                </div>
              </div>
            )}

            {!isHq && o.status === 'submitted' && (
              <Button variant="danger" disabled={busy} onClick={() => void run(() => api.transition(o.id, 'cancelled'))}>
                Cancel this order
              </Button>
            )}

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#758078]">History</h3>
              <ol className="space-y-1.5 text-sm">
                {[...o.history].reverse().map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-[#354139]">
                    <span className="font-semibold">{h.status}</span>
                    <span className="text-[#758078]">
                      {fmtDate(h.at)} · {h.by}
                    </span>
                    {h.note && <span>— {h.note}</span>}
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
