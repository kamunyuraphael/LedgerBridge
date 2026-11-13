import axios from 'axios'

const TOKEN_KEY = 'lb.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage blocked: the session just won't survive a reload */
  }
}

// VITE_API_URL is only a public base URL (never a secret). Empty = same origin / dev proxy.
export const http = axios.create({
  baseURL: (import.meta.env.VITE_API_URL as string | undefined) ?? '',
  timeout: 15_000,
})

http.interceptors.request.use((cfg) => {
  const t = getToken()
  if (t) cfg.headers.set('Authorization', `Bearer ${t}`)
  return cfg
})

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}
http.interceptors.response.use(
  (r) => r,
  (err: unknown) => {
    if (axios.isAxiosError(err) && err.response?.status === 401 && !err.config?.url?.includes('/auth/login')) {
      onUnauthorized?.()
    }
    return Promise.reject(err)
  },
)

/** Turn any failure into a sentence a person can act on. */
export function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (!err.response) return 'Cannot reach the server. Check your connection and retry.'
    const d = err.response.data as { message?: string; error?: string } | undefined
    if (d?.message) return d.message
    if (err.response.status === 429) return 'Too many requests. Please wait a moment and retry.'
    if (err.response.status === 403) return 'You do not have permission to do that.'
    if (err.response.status === 404) return 'Not found.'
  }
  return 'Something went wrong. Please retry.'
}
