import { useState, type FormEvent } from 'react'
import { errorMessage } from '../api/client'
import { useAuth } from '../authContext'
import { Button, ErrorBanner, TextInput } from '../components/ui'
import { LogoMark } from '../components/icons'

export function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (err) {
      const msg = errorMessage(err)
      setError(msg.startsWith('Something') ? 'Wrong username or password.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-[#e4e8e4] bg-white p-7 shadow-sm">
        <div className="flex items-center gap-3">
          <LogoMark />
          <div>
            <h1 className="font-display text-xl font-bold text-[#064e3b]">LedgerBridge</h1>
            <p className="text-xs text-[#758078]">Branch ordering &amp; HQ approvals</p>
          </div>
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <label className="block text-xs font-semibold text-[#354139]">
          Username
          <TextInput className="mt-1.5" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block text-xs font-semibold text-[#354139]">
          Password
          <TextInput className="mt-1.5" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}
