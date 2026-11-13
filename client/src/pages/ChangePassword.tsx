import { useState, type FormEvent } from 'react'
import { api } from '../api/api'
import { errorMessage } from '../api/client'
import { useAuth } from '../authContext'
import { Button, Card, ErrorBanner, Notice, TextInput } from '../components/ui'

export function ChangePassword({ forced }: { forced: boolean }) {
  const { refreshUser, logout } = useAuth()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next !== again) return setError('The new passwords do not match.')
    if (next.length < 8) return setError('Use at least 8 characters.')
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(cur, next)
      setDone(true)
      setCur('')
      setNext('')
      setAgain('')
      await refreshUser()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={forced ? 'grid min-h-screen place-items-center px-4' : ''}>
      <Card className="w-full max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <h2 className="font-display text-lg font-bold text-[#064e3b]">{forced ? 'Set a new password' : 'Change password'}</h2>
          {forced && <p className="text-sm text-[#5b645e]">Your account uses a temporary password. Choose your own to continue.</p>}
          {error && <ErrorBanner>{error}</ErrorBanner>}
          {done && <Notice>Password updated.</Notice>}
          <TextInput type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          <TextInput type="password" placeholder="New password (8+ characters)" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <TextInput type="password" placeholder="Repeat new password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !cur || !next}>
              {busy ? 'Saving…' : 'Save password'}
            </Button>
            {forced && (
              <Button type="button" variant="ghost" onClick={logout}>
                Sign out
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  )
}
