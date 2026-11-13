import { useEffect, useState } from 'react'
import { api, type Health } from './api/api'
import { AuthProvider } from './auth'
import { useAuth } from './authContext'
import { LogoMark } from './components/icons'
import { Button } from './components/ui'
import { Admin } from './pages/Admin'
import { BranchOrder } from './pages/BranchOrder'
import { ChangePassword } from './pages/ChangePassword'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'

type View = 'new' | 'orders' | 'admin' | 'password'

function Shell() {
  const { user, logout } = useAuth()
  const isHq = user?.role === 'hq'
  const [view, setView] = useState<View>(isHq ? 'orders' : 'new')
  const [health, setHealth] = useState<Health | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const check = () => void api.health().then((h) => alive && setHealth(h))
    check()
    const id = setInterval(check, 30_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const tabs: { id: View; label: string }[] = isHq
    ? [
        { id: 'orders', label: 'Orders' },
        { id: 'admin', label: 'Setup' },
        { id: 'password', label: 'Password' },
      ]
    : [
        { id: 'new', label: 'New order' },
        { id: 'orders', label: 'My orders' },
        { id: 'password', label: 'Password' },
      ]

  const ok = health?.status === 'ok'
  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 pb-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex items-center gap-3">
          <LogoMark />
          <div>
            <div className="font-display text-lg font-bold leading-tight text-[#064e3b]">LedgerBridge</div>
            <div className="text-xs text-[#758078]">
              {user?.name}
              {isHq ? ' · HQ' : user?.branchName ? ` · ${user.branchName}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            title={health === undefined ? 'Checking…' : ok ? 'Connected' : health === null ? 'Server unreachable' : 'Database unavailable'}
            className={`h-2.5 w-2.5 rounded-full ${health === undefined ? 'bg-[#c8cec9]' : ok ? 'bg-[#2f9e6e]' : 'bg-[#c65a50]'}`}
          />
          <Button variant="secondary" className="h-9" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <nav className="mb-5 flex gap-1 border-b border-[#dde2dd]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              view === t.id ? 'border-[#064e3b] text-[#064e3b]' : 'border-transparent text-[#758078] hover:text-[#18221d]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {view === 'new' && !isHq && <BranchOrder onViewOrders={() => setView('orders')} />}
        {view === 'orders' && <Orders />}
        {view === 'admin' && isHq && <Admin />}
        {view === 'password' && <ChangePassword forced={false} />}
      </main>
    </div>
  )
}

function Gate() {
  const { user, loading } = useAuth()
  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-[#758078]">Loading…</div>
  if (!user) return <Login />
  if (user.mustChangePassword) return <ChangePassword forced />
  // Key by user so switching accounts never leaks the previous account's screen state.
  return <Shell key={user.id} />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
