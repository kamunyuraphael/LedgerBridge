import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  ApiValidationError,
  fetchHealth,
  fetchRecent,
  submitSale,
  type Health,
  type SaleRecord,
} from './api/sales'
import { ArrowIcon, CheckIcon, ClockIcon, LogoMark } from './components/icons'
import { RecentList } from './components/RecentList'
import { StatusBadge } from './components/StatusBadge'
import { CURRENCY } from './config'
import { saleInputSchema } from './schemas/sale'

interface FormState {
  storeCode: string
  sku: string
  unitsSold: string
  totalRevenue: string
}
type Errors = Partial<Record<keyof FormState, string>>

const EMPTY: FormState = { storeCode: '', sku: '', unitsSold: '', totalRevenue: '' }

/** Live input filters: enforced while typing, before any network call. */
const filters = {
  storeCode: (v: string) => v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12),
  sku: (v: string) => v.replace(/^\s+/, ''), // trailing whitespace is stripped on blur / submit
  unitsSold: (v: string) => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 7),
  totalRevenue: (v: string) => {
    const cleaned = v.replace(/[^\d.]/g, '')
    const [whole = '', ...rest] = cleaned.split('.')
    return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole
  },
}

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type Ack = { record: SaleRecord; ackMs: number }

function App() {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [last, setLast] = useState<Ack | null>(null)
  const [recent, setRecent] = useState<SaleRecord[]>([])
  const [health, setHealth] = useState<Health | null | undefined>(undefined)
  // Reused across retries of the SAME submission so a double-click never creates two rows.
  const pendingId = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const rows = await fetchRecent()
      setRecent(rows)
      setLast((prev) => {
        const fresh = prev && rows.find((r) => r.recordId === prev.record.recordId)
        return prev && fresh ? { ...prev, record: fresh } : prev
      })
    } catch {
      /* transient: the next poll will retry */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let alive = true
    const check = () => void fetchHealth().then((h) => alive && setHealth(h))
    check()
    const id = setInterval(check, 30_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const hasOpen = recent.some((r) => r.syncStatus === 'pending' || r.syncStatus === 'processing')
  useEffect(() => {
    if (!hasOpen) return
    const id = setInterval(() => void refresh(), 2000)
    return () => clearInterval(id)
  }, [hasOpen, refresh])

  const onChange = (name: keyof FormState) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [name]: filters[name](e.target.value) }))
    setErrors((er) => ({ ...er, [name]: undefined }))
    setLast(null)
  }

  const onBlur = (name: keyof FormState) => () =>
    setForm((f) => {
      if (name === 'sku') return { ...f, sku: f.sku.trim() }
      if (name === 'totalRevenue' && f.totalRevenue !== '' && f.totalRevenue !== '.') {
        return { ...f, totalRevenue: Number(f.totalRevenue).toFixed(2) }
      }
      return f
    })

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    setFormError(null)

    const parsed = saleInputSchema.safeParse({
      recordId: (pendingId.current ??= crypto.randomUUID()),
      storeCode: form.storeCode,
      sku: form.sku,
      unitsSold: form.unitsSold === '' ? Number.NaN : Number(form.unitsSold),
      totalRevenue: form.totalRevenue === '' ? Number.NaN : Number(form.totalRevenue),
      clientSubmittedAt: new Date().toISOString(),
    })
    if (!parsed.success) {
      const next: Errors = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState | undefined
        if (key && key in EMPTY && !next[key]) next[key] = issue.message
      }
      // Friendlier wording for untouched fields (matches the design copy).
      if (form.storeCode === '' && next.storeCode) next.storeCode = 'Store code is required'
      if (form.unitsSold === '' && next.unitsSold) next.unitsSold = 'Enter a positive whole number'
      if (form.totalRevenue === '' && next.totalRevenue) next.totalRevenue = 'Enter a valid amount with up to 2 decimals'
      setErrors(next)
      return
    }

    setSubmitting(true)
    try {
      const result = await submitSale(parsed.data)
      setLast(result)
      setForm(EMPTY)
      setErrors({})
      pendingId.current = null
      void refresh()
    } catch (err) {
      if (err instanceof ApiValidationError) {
        const next: Errors = {}
        for (const i of err.issues) if (i.field in EMPTY) next[i.field as keyof FormState] = i.message
        setErrors(next)
        pendingId.current = null
      } else {
        setFormError(err instanceof Error ? err.message : 'Unexpected error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const field = (
    name: keyof FormState,
    label: string,
    prefix: string,
    hint: string,
    props: React.InputHTMLAttributes<HTMLInputElement>,
  ) => (
    <label className="field-group">
      <span className="field-label">{label}</span>
      <div className={`field-shell ${errors[name] ? 'field-error' : ''}`}>
        <span className="field-prefix">{prefix}</span>
        <input
          name={name}
          id={name}
          value={form[name]}
          onChange={onChange(name)}
          onBlur={onBlur(name)}
          aria-invalid={Boolean(errors[name])}
          aria-describedby={`${name}-msg`}
          {...props}
        />
      </div>
      <span id={`${name}-msg`} className={errors[name] ? 'field-message error' : 'field-message'}>
        {errors[name] ?? hint}
      </span>
    </label>
  )

  const online = health?.status === 'ok'
  const statusLabel =
    health === undefined
      ? 'Checking service…'
      : health === null
        ? 'Ingestion service unreachable'
        : online
          ? `Ingestion service online${health.graphMode === 'mock' ? ' · mock ledger' : ''}`
          : 'Ingestion service degraded'
  const dot = online ? 'bg-emerald-600' : health === undefined ? 'bg-[#a7aea9]' : 'bg-[#c65a50]'

  return (
    <main className="min-h-screen bg-[#f3f5f1] text-[#18221d]">
      <header className="border-b border-[#dce1db] bg-[#f8faf7]/90 backdrop-blur">
        <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-6 sm:px-10 lg:px-14">
          <div className="flex items-center gap-3">
            <LogoMark />
            <span className="font-display text-[19px] font-semibold tracking-[-0.02em]">LedgerBridge</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-[#526057]" role="status">
            <span className="relative flex h-2 w-2">
              {online ? (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-40" />
              ) : null}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
            </span>
            <span className="hidden sm:inline">{statusLabel}</span>
            <span className="sr-only sm:hidden">{statusLabel}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] grid-cols-[minmax(0,1fr)] lg:min-h-[calc(100vh-72px)] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="relative overflow-hidden bg-[#073c2f] px-6 py-12 text-white sm:px-10 sm:py-16 lg:px-14 lg:py-20">
          <div className="ledger-grid pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative flex h-full max-w-xl flex-col justify-between gap-20">
            <div>
              <div className="mb-8 inline-flex items-center rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-[11px] font-semibold tracking-[0.16em] text-emerald-100 uppercase">
                Revenue Operations
              </div>
              <h1 className="font-display text-[clamp(2.75rem,5vw,5.2rem)] leading-[0.95] font-medium tracking-[-0.055em]">
                Every sale,
                <br />
                <span className="text-[#a7f3c0]">accounted for.</span>
              </h1>
              <p className="mt-7 max-w-md text-base leading-7 text-emerald-50/65">
                Record store-level sales with clean, validated data ready for your financial ledger.
              </p>
            </div>

            <div className="grid max-w-lg grid-cols-3 border-y border-white/15 py-6">
              <div>
                <p className="text-2xl font-semibold tracking-tight">4</p>
                <p className="mt-1 text-[11px] tracking-wide text-emerald-50/50 uppercase">Data fields</p>
              </div>
              <div className="border-l border-white/15 pl-6">
                <p className="text-2xl font-semibold tracking-tight">100%</p>
                <p className="mt-1 text-[11px] tracking-wide text-emerald-50/50 uppercase">Validated</p>
              </div>
              <div className="border-l border-white/15 pl-6">
                <p className="text-2xl font-semibold tracking-tight">ISO</p>
                <p className="mt-1 text-[11px] tracking-wide text-emerald-50/50 uppercase">Timestamped</p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex items-start px-6 py-12 sm:px-10 lg:items-center lg:px-[clamp(3rem,6vw,6rem)] lg:py-16">
          <div className="w-full max-w-[620px]">
            <div className="mb-9">
              <p className="mb-3 text-xs font-semibold tracking-[0.16em] text-[#237355] uppercase">New transaction</p>
              <h2 className="font-display text-3xl font-semibold tracking-[-0.035em] sm:text-[2.5rem]">Record a sale</h2>
              <p className="mt-3 text-sm leading-6 text-[#69736c]">
                Enter the transaction details below. Fields are normalized before ingestion.
              </p>
            </div>

            <form noValidate onSubmit={onSubmit}>
              <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
                {field('storeCode', 'Store code', 'ST', 'Automatically capitalized', {
                  autoComplete: 'off',
                  placeholder: 'NYC01',
                  maxLength: 12,
                })}
                {field('sku', 'SKU', '#', 'Whitespace removed on entry', {
                  autoComplete: 'off',
                  placeholder: 'BRG-1042',
                  maxLength: 64,
                })}
                {field('unitsSold', 'Units sold', '×', 'Positive whole numbers only', {
                  inputMode: 'numeric',
                  placeholder: '24',
                })}
                {field('totalRevenue', `Total revenue (${CURRENCY})`, CURRENCY, 'Formatted to 2 decimal places', {
                  inputMode: 'decimal',
                  placeholder: '1,248.00',
                })}
              </div>

              <div className="my-8 flex items-start gap-3 rounded-xl border border-[#dbe4dc] bg-[#f8faf7] p-4">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#e2f2e7] text-[#176044]">
                  <ClockIcon />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#26352c]">Automatic timestamping</p>
                  <p className="mt-1 text-xs leading-5 text-[#69736c]">
                    A precise ISO-8601 timestamp is generated by the server when this transaction is submitted.
                  </p>
                </div>
              </div>

              {formError ? (
                <p className="mb-4 rounded-xl border border-[#efc9c4] bg-[#fbeceb] px-4 py-3 text-xs text-[#aa3e35]" role="alert">
                  {formError}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={submitting}
                className="group flex h-13 w-full items-center justify-between rounded-xl bg-[#0b513d] px-5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(7,60,47,0.16)] transition hover:bg-[#063d2f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b513d] disabled:cursor-wait disabled:opacity-70"
              >
                <span>{submitting ? 'Saving transaction…' : 'Submit transaction'}</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 transition-transform group-hover:translate-x-0.5">
                  <ArrowIcon />
                </span>
              </button>
            </form>

            {last ? (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4" role="status" aria-live="polite">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-emerald-900">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white">
                    <CheckIcon />
                  </span>
                  Transaction accepted
                  <span className="ml-auto flex items-center gap-2 text-[11px] font-medium text-emerald-900/60">
                    {last.ackMs} ms
                    <StatusBadge status={last.record.syncStatus} />
                  </span>
                </div>
                <p className="mt-3 break-all font-mono text-[11px] leading-5 text-emerald-900/70">
                  {last.record.storeCode} · {last.record.sku} · {last.record.unitsSold} units · {CURRENCY}{' '}
                  {money.format(last.record.totalRevenue)}
                  <br />
                  {last.record.timestamp}
                </p>
              </div>
            ) : null}

            <div className="mt-10">
              <h3 className="mb-3 text-xs font-semibold tracking-[0.16em] text-[#237355] uppercase">Recent transactions</h3>
              <RecentList records={recent} />
            </div>

            <p className="mt-6 text-center text-[11px] text-[#8a938c]">
              Data is validated in the browser and again on the server before it reaches the ledger.
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
