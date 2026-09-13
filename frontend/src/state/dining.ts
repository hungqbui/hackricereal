/**
 * Live hall statuses for the Dining tab.
 *
 * `GET /dining/locations` is one request, but the open/closed sentence lives on
 * `/details`, which is one request per hall — twenty of them on this campus.
 * They are fetched through a small pool and cached for the session, so the
 * Dining tab costs at most one burst per session. The backend does not cache
 * upstream, so each of those requests reaches DineOnCampus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api/client'
import type { Location, LocationDetails, LocationStatus } from '../api/types'

export type OpenState = 'open' | 'closing' | 'closed' | 'unknown'

export interface HallStatus {
  state: OpenState
  /** The hall's own sentence: "Open 24 hours.", "Closed. Opens at 11:00am." */
  message: string | null
  /** Short chip text derived from the sentence: "Open until 9:00 PM". */
  chip: string
}

export interface Hall extends Location {
  status: HallStatus
  loading: boolean
}

const detailsCache = new Map<string, LocationDetails>()
/** Gentle on the upstream: four halls in flight at a time. */
const CONCURRENCY = 4

const UNKNOWN: HallStatus = { state: 'unknown', message: null, chip: 'Hours unavailable' }

/**
 * Turn the upstream status into a state and a short chip.
 *
 * DineOnCampus sends `color` (green/yellow/red) alongside the sentence. Yellow
 * means closing soon, which the spec asks us to show distinctly. The chip
 * prefers a "until <time>" phrase pulled out of the sentence, because "Open
 * until 9:00 PM" is the thing a hungry student is actually reading for.
 */
export function readStatus(status: LocationStatus | null | undefined): HallStatus {
  if (!status) return UNKNOWN

  const message = status.message?.trim() || null
  const label = (status.label ?? '').toLowerCase()
  const color = (status.color ?? '').toLowerCase()

  let state: OpenState = 'unknown'
  if (color === 'yellow' || /closing soon/i.test(message ?? '')) state = 'closing'
  else if (color === 'green' || label === 'open') state = 'open'
  else if (color === 'red' || label === 'closed') state = 'closed'

  return { state, message, chip: chipFor(state, message) }
}

function chipFor(state: OpenState, message: string | null): string {
  if (!message) {
    return state === 'open' ? 'Open now' : state === 'closed' ? 'Closed' : 'Hours unavailable'
  }
  // "Open until 9:00pm." / "Closes at 9:00pm." -> "Open until 9:00pm"
  const until = message.match(/(?:until|closes at)\s+([0-9][^.,]*)/i)
  if (until && state !== 'closed') return `Open until ${until[1].trim()}`
  if (/24 hours/i.test(message)) return 'Open 24 hours'
  // "Closed. Opens at 11:00am." -> "Opens 11:00am"
  const opens = message.match(/opens?\s+(?:at\s+)?([^.,]*)/i)
  if (opens && state === 'closed') return `Opens ${opens[1].trim()}`
  if (state === 'closing') return 'Closing soon'
  return state === 'open' ? 'Open now' : state === 'closed' ? 'Closed' : 'Hours unavailable'
}

async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await run(items[index])
    }
  })
  await Promise.all(workers)
}

export interface DiningStore {
  halls: Hall[]
  /** Distinct building names, for the campus selector. */
  buildings: string[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useDining(locations: Location[], error: string | null): DiningStore {
  const [details, setDetails] = useState<Map<string, LocationDetails>>(
    () => new Map(detailsCache),
  )
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    if (locations.length === 0) return

    const missing = locations.filter((location) => !detailsCache.has(location.id))
    if (missing.length === 0) {
      setDetails(new Map(detailsCache))
      return
    }

    setLoading(true)
    void pooled(missing, CONCURRENCY, async (location) => {
      try {
        const payload = await api.locationDetails(location.id)
        detailsCache.set(location.id, payload)
      } catch {
        // A hall whose details fail keeps its "hours unavailable" chip; it
        // must not take the rest of the list down with it.
      }
      if (!cancelled.current) setDetails(new Map(detailsCache))
    }).finally(() => {
      if (!cancelled.current) setLoading(false)
    })

    return () => {
      cancelled.current = true
    }
  }, [locations, nonce])

  const halls = useMemo<Hall[]>(
    () =>
      locations.map((location) => {
        const detail = details.get(location.id)
        return {
          ...location,
          status: detail ? readStatus(detail.status) : UNKNOWN,
          loading: !detail,
        }
      }),
    [locations, details],
  )

  const buildings = useMemo(() => {
    const seen = new Set<string>()
    for (const location of locations) {
      if (location.building) seen.add(location.building)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [locations])

  const refresh = useCallback(() => {
    detailsCache.clear()
    setNonce((value) => value + 1)
  }, [])

  return useMemo(
    () => ({ halls, buildings, loading, error, refresh }),
    [halls, buildings, loading, error, refresh],
  )
}

/** Sort order for the hall list: open first, then closing, then closed. */
export function byOpenness(a: Hall, b: Hall): number {
  const rank: Record<OpenState, number> = { open: 0, closing: 1, unknown: 2, closed: 3 }
  const delta = rank[a.status.state] - rank[b.status.state]
  return delta !== 0 ? delta : a.name.localeCompare(b.name)
}
