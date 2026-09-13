import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { ApiError, api, setToken } from '../api/client'
import type { User } from '../api/types'

const TOKEN_KEY = 'unibite.token'

interface AuthValue {
  user: User | null
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private browsing: the session simply will not survive a reload.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const stored = readStoredToken()
    if (!stored) {
      setReady(true)
      return
    }
    setToken(stored)
    let cancelled = false
    api
      .me()
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch((error) => {
        // An expired or revoked token should log out, but a backend that
        // is merely down should not throw away a usable session.
        if (error instanceof ApiError && error.status === 401) {
          setToken(null)
          storeToken(null)
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const accept = useCallback((token: string, nextUser: User) => {
    setToken(token)
    storeToken(token)
    setUser(nextUser)
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login({ email: email.trim(), password })
      accept(result.access_token, result.user)
    },
    [accept],
  )

  const register = useCallback(
    async (email: string, password: string) => {
      const result = await api.register({ email: email.trim(), password })
      accept(result.access_token, result.user)
    },
    [accept],
  )

  const logout = useCallback(() => {
    setToken(null)
    storeToken(null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, ready, login, register, logout }),
    [user, ready, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
