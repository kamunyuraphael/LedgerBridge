import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api/api'
import { getToken, setToken, setUnauthorizedHandler } from './api/client'
import type { User } from './api/types'
import { Ctx } from './authContext'


export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => getToken() !== null)

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  useEffect(() => {
    if (!getToken()) return
    let alive = true
    api
      .me()
      .then((u) => alive && setUser(u))
      .catch(() => undefined) // a 401 already logged us out; other errors leave the login screen
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const r = await api.login(username, password)
    setToken(r.token)
    setUser(r.user)
  }, [])

  const refreshUser = useCallback(async () => setUser(await api.me()), [])

  const value = useMemo(() => ({ user, loading, login, logout, refreshUser }), [user, loading, login, logout, refreshUser])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
