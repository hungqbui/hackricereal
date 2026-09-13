import type {
  Location,
  PeriodsOut,
  Plan,
  PlanGenerateRequest,
  TokenOut,
  User,
} from './types'

// In development Vite proxies /api to the backend, so no CORS round trip.
const BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '')

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

let token: string | null = null

export function setToken(next: string | null): void {
  token = next
}

/** FastAPI puts a string on `detail` for HTTPException and a list for 422. */
function readDetail(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null) return fallback
  const detail = (payload as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((entry) =>
        typeof entry === 'object' && entry !== null
          ? String((entry as { msg?: unknown }).msg ?? '')
          : '',
      )
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return fallback
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'Could not reach the CougarGrub API. Is the backend running?')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      readDetail(payload, `Request failed with status ${response.status}.`),
    )
  }
  return payload as T
}

export const api = {
  health: () =>
    request<{
      status: string
      database: { connected: boolean; error: string | null }
      gemini: { configured: boolean; model: string | null }
    }>('/health'),

  register: (body: { email: string; password: string }) =>
    request<TokenOut>('/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    request<TokenOut>('/auth/login', { method: 'POST', body }),

  me: () => request<User>('/auth/me'),

  locations: () => request<Location[]>('/dining/locations'),

  periods: (locationId: string, date: string) =>
    request<PeriodsOut>(
      `/dining/locations/${encodeURIComponent(locationId)}/periods?date=${date}`,
    ),

  generatePlan: (body: PlanGenerateRequest, signal?: AbortSignal) =>
    request<Plan>('/plans/generate', { method: 'POST', body, signal }),

  refinePlan: (planId: string, instruction: string, signal?: AbortSignal) =>
    request<Plan>(`/plans/${planId}/refine`, {
      method: 'POST',
      body: { instruction },
      signal,
    }),

  getPlan: (planId: string) => request<Plan>(`/plans/${planId}`),

  deletePlan: (planId: string) =>
    request<void>(`/plans/${planId}`, { method: 'DELETE' }),
}
