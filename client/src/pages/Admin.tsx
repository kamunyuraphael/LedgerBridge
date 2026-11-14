import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/api'
import { errorMessage } from '../api/client'
import type { AdminStats, AdminUser, ImportResult } from '../api/types'
import { Button, Card, ErrorBanner, Notice, TextInput } from '../components/ui'
import { fmtDate } from '../format'

const KINDS = [
  { kind: 'suppliers', title: 'Suppliers', help: 'Columns: No. (V0001…) and Name.' },
  { kind: 'items', title: 'Products', help: 'Columns: Item No., Description, Supplier No. Import suppliers first.' },
  {
    kind: 'quantities',
    title: 'Standard quantities',
    help: 'Columns: Branch Code, Item No., Qty. This is what each branch can order and how much; branches never type quantities. Each branch only sees the items listed for it.',
  },
  { kind: 'branches', title: 'Branches', help: 'Columns: Code (J001…) and Name. Can also create a login for each branch.' },
] as const

function downloadCsv(name: string, rows: string[][]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function ImportCard({ kind, title, help, onDone }: { kind: 'suppliers' | 'items' | 'branches' | 'quantities'; title: string; help: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [accounts, setAccounts] = useState(kind === 'branches')

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.importFile(kind, file, accounts)
      setResult(r)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3">
      <h3 className="font-display text-base font-bold text-[#064e3b]">Import {title}</h3>
      <p className="text-sm text-[#5b645e]">{help} Re-importing updates existing rows; nothing is deleted.</p>
      {kind === 'branches' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={accounts} onChange={(e) => setAccounts(e.target.checked)} />
          Create a login per new branch (username = branch code)
        </label>
      )}
      {kind === 'quantities' && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={accounts} onChange={(e) => setAccounts(e.target.checked)} />
          <span>Replace each listed branch's current list (items not in the file are removed from that branch)</span>
        </label>
      )}
      <label className={`inline-flex h-10 cursor-pointer items-center rounded-xl border border-[#d9ded9] bg-white px-4 text-sm font-semibold hover:bg-[#f3f5f1] ${busy ? 'opacity-50' : ''}`}>
        {busy ? 'Importing…' : 'Choose .xlsx file'}
        <input type="file" accept=".xlsx" className="hidden" disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {result && (
        <div className="space-y-2">
          <Notice>
            {result.written} of {result.received} rows saved{result.errors.length ? `, ${result.errors.length} skipped` : ''}.
          </Notice>
          {result.errors.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-xs text-[#8a2f27]">
              {result.errors.slice(0, 50).map((e, i) => (
                <li key={i}>
                  {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
          {result.accounts && result.accounts.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold">{result.accounts.length} logins created. Download now, passwords are shown only once.</p>
              <Button
                variant="secondary"
                onClick={() => downloadCsv('branch-logins.csv', [['Username', 'Branch', 'Temporary password'], ...result.accounts!.map((a) => [a.username, a.name, a.password])])}
              >
                Download logins (CSV)
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function AddUser({ onDone }: { onDone: () => void }) {
  const [branches, setBranches] = useState<{ code: string; name: string }[]>([])
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<'branch' | 'hq'>('branch')
  const [branchCode, setBranchCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null)

  useEffect(() => {
    api.branches().then(setBranches).catch(() => undefined)
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setCreated(null)
    try {
      setCreated(await api.createUser({ name: name.trim(), username: username.trim(), role, ...(role === 'branch' ? { branchCode } : {}) }))
      setName('')
      setUsername('')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const ok = name.trim() && username.trim().length >= 3 && (role === 'hq' || branchCode)
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl bg-[#f6f8f6] p-4">
      <h4 className="text-sm font-semibold">Add a user</h4>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextInput placeholder="Full name (e.g. Eric Kerosi)" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput placeholder="Username (e.g. eric.thindigua)" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'branch' | 'hq')} className="h-10 rounded-xl border border-[#d9ded9] bg-white px-3 text-sm">
          <option value="branch">Branch (places orders)</option>
          <option value="hq">HQ (approves orders)</option>
        </select>
        {role === 'branch' && (
          <select aria-label="Branch" value={branchCode} onChange={(e) => setBranchCode(e.target.value)} className="h-10 min-w-0 rounded-xl border border-[#d9ded9] bg-white px-3 text-sm">
            <option value="">Choose branch…</option>
            {branches.map((b) => (
              <option key={b.code} value={b.code}>
                {b.code} · {b.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {created && (
        <Notice>
          Created <strong>{created.username}</strong>. Temporary password: <code className="font-semibold">{created.password}</code> (shown once; they must change it at first sign-in)
        </Notice>
      )}
      <Button type="submit" disabled={busy || !ok}>
        {busy ? 'Creating…' : 'Create user'}
      </Button>
    </form>
  )
}

export function Admin() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [demoMsg, setDemoMsg] = useState<string | null>(null)
  const [reset, setReset] = useState<{ username: string; password: string } | null>(null)

  const refresh = useCallback(() => {
    api.stats().then(setStats).catch((e) => setError(errorMessage(e)))
    api.users().then(setUsers).catch((e) => setError(errorMessage(e)))
  }, [])
  useEffect(refresh, [refresh])

  async function toggle(u: AdminUser) {
    try {
      await api.setUserActive(u.id, !u.active)
      refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  async function clearDemo() {
    if (!window.confirm('Delete all simulated branches, products, demo logins and their orders? Real data is not touched.')) return
    try {
      const r = await api.clearDemo()
      setDemoMsg(`Removed ${r.branches} branches, ${r.items} products, ${r.rules} standard quantities, ${r.users} logins and ${r.orders} orders.`)
      refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  async function retryLedger() {
    try {
      const r = await api.retryLedger()
      setDemoMsg(`${r.requeued} order(s) queued for the sheet again.`)
      refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  async function resetPw(u: AdminUser) {
    try {
      setReset(await api.resetPassword(u.id))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {stats && (
        <div className="grid grid-cols-3 gap-3 text-center">
          {(['suppliers', 'items', 'branches'] as const).map((k) => (
            <Card key={k}>
              <div className="font-display text-2xl font-bold text-[#064e3b]">{stats[k]}</div>
              <div className="text-xs capitalize text-[#758078]">{k === 'items' ? 'products' : k}</div>
            </Card>
          ))}
        </div>
      )}
      {demoMsg && <Notice>{demoMsg}</Notice>}
      {stats?.hasDemoData && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[#354139]">
            <strong>Simulated data is loaded.</strong> Branches J001 to J034 and demo products are for testing; the demo branch logins are j001 to j034
            (password demo1234). Remove them before going live.
          </p>
          <Button variant="danger" onClick={() => void clearDemo()}>
            Remove demo data
          </Button>
        </Card>
      )}
      {stats && (stats.ledger.failed ?? 0) > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[#8a2f27]">
            <strong>{stats.ledger.failed}</strong> approved order(s) could not be copied to the Google Sheet. Check the sheet is shared with the service account, then retry.
          </p>
          <Button variant="secondary" onClick={() => void retryLedger()}>
            Retry sheet sync
          </Button>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {KINDS.map((k) => (
          <ImportCard key={k.kind} {...k} onDone={refresh} />
        ))}
      </div>

      <Card className="space-y-3">
        <h3 className="font-display text-base font-bold text-[#064e3b]">Accounts</h3>
        <AddUser onDone={refresh} />
        {reset && (
          <Notice>
            New temporary password for <strong>{reset.username}</strong>: <code className="font-semibold">{reset.password}</code> (shown once)
          </Notice>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-[#5b645e]">
              <tr>
                <th className="py-2 font-semibold">Username</th>
                <th className="py-2 font-semibold">Name</th>
                <th className="py-2 font-semibold">Role</th>
                <th className="py-2 font-semibold">Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-t border-[#eef1ee] ${u.active ? '' : 'opacity-50'}`}>
                  <td className="py-2 font-semibold">{u.username}</td>
                  <td className="py-2">{u.name}</td>
                  <td className="py-2">{u.role === 'hq' ? 'HQ' : `Branch ${u.branchCode ?? ''}`}</td>
                  <td className="py-2 text-[#758078]">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'never'}</td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => void resetPw(u)}>
                      Reset password
                    </Button>
                    <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => void toggle(u)}>
                      {u.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
