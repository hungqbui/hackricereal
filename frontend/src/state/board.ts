/**
 * The This Week board: a few days of plans generated together.
 *
 * The server is the source of truth. Every day is generated with a `board`
 * marker, and `GET /plans/week` rebuilds the most recent week from those
 * plans, so the board survives a reload, another browser, or another origin.
 * A copy is kept in `localStorage` for offline starts and for boards made
 * before the server knew about weeks. "New plan" clears it on the server too.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { BoardRef, NutritionTargets, Plan, WeekOut } from '../api/types'
import { matchPeriods, type Interpretation, type PeriodName } from '../lib/parse'
import { weekdayLabel } from '../lib/dates'
import { fetchPeriods } from './availability'

export type DayStatus = 'queued' | 'loading' | 'ready' | 'empty' | 'error'

export interface DayCell {
  date: string
  status: DayStatus
  plan: Plan | null
  /** Why a day is empty or failed — shown in place of the meals. */
  message: string | null
  refining: boolean
}

export interface Board {
  /** The server-side week id; absent on boards saved before weeks were stored. */
  id?: string
  locationId: string
  locationName: string
  query: string
  targets: NutritionTargets
  periods: PeriodName[]
  days: DayCell[]
}

interface StoredDay {
  date: string
  /** Null for a day that produced no plan — no menu, or a failure. */
  planId: string | null
  message: string | null
}

interface StoredBoard {
  id?: string
  locationId: string
  locationName: string
  query: string
  targets: NutritionTargets
  periods: PeriodName[]
  days: StoredDay[]
}

const STORAGE_PREFIX = 'unibite.board.'
// Two at a time: fast enough for a week, gentle on the upstream menu API.
const CONCURRENCY = 2

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`
}

function readStored(userId: string): StoredBoard | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    return raw ? (JSON.parse(raw) as StoredBoard) : null
  } catch {
    return null
  }
}

function writeStored(userId: string, board: Board | null): void {
  try {
    if (!board) {
      window.localStorage.removeItem(storageKey(userId))
      return
    }
    const stored: StoredBoard = {
      id: board.id,
      locationId: board.locationId,
      locationName: board.locationName,
      query: board.query,
      targets: board.targets,
      periods: board.periods,
      days: board.days.map((day) => ({
        date: day.date,
        planId: day.plan?.id ?? null,
        message: day.plan ? null : day.message,
      })),
    }
    window.localStorage.setItem(storageKey(userId), JSON.stringify(stored))
  } catch {
    // Out of quota or blocked storage: the server copy still holds.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function newBoardId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Rebuild the board from `GET /plans/week`. */
function boardFromWeek(week: WeekOut): Board {
  const byDate = new Map(week.plans.map((plan) => [plan.plan_date, plan]))
  const dates = [...new Set([...week.dates, ...week.plans.map((plan) => plan.plan_date)])].sort()
  return {
    id: week.board_id,
    locationId: week.location_id ?? week.plans[0]?.sources.location_id ?? '',
    locationName: week.location_name ?? week.plans[0]?.sources.location_name ?? 'Campus dining',
    query: week.query ?? '',
    targets: week.targets ?? {},
    periods: week.periods as PeriodName[],
    days: dates.map((date) => {
      const plan = byDate.get(date) ?? null
      return {
        date,
        status: (plan ? 'ready' : 'empty') as DayStatus,
        plan,
        message: plan ? null : 'No plan was made for this day — the hall had no menu, or it failed.',
        refining: false,
      }
    }),
  }
}

/** Run tasks with a small pool so a 7-day week is not 7 parallel requests. */
export async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await run(items[index])
    }
  })
  await Promise.all(workers)
}

export function usePlanBoard(userId: string | null) {
  const [board, setBoard] = useState<Board | null>(null)
  const [busy, setBusy] = useState(false)
  const boardRef = useRef<Board | null>(null)

  boardRef.current = board

  const commit = useCallback(
    (next: Board | null) => {
      boardRef.current = next
      setBoard(next)
      if (userId) writeStored(userId, next)
    },
    [userId],
  )

  const patchDay = useCallback((date: string, patch: Partial<DayCell>) => {
    setBoard((current) => {
      if (!current) return current
      const days = current.days.map((day) =>
        day.date === date ? { ...day, ...patch } : day,
      )
      const next = { ...current, days }
      boardRef.current = next
      return next
    })
  }, [])

  // Restore on load: the server's week first, this device's copy if offline.
  useEffect(() => {
    if (!userId) {
      setBoard(null)
      return
    }

    let cancelled = false
    // A board the student started generating while this loaded wins.
    const stillWanted = () => !cancelled && !boardRef.current

    void (async () => {
      try {
        const week = await api.week()
        if (!stillWanted()) return
        if (week) {
          const next = boardFromWeek(week)
          boardRef.current = next
          setBoard(next)
          writeStored(userId, next)
          return
        }
        // No week on the server. A stored board with an id was cleared or
        // belongs to the server's history, so only a pre-server board is kept.
        const stored = readStored(userId)
        if (stored?.id) {
          writeStored(userId, null)
          return
        }
        if (stored) await restoreStored(stored)
      } catch {
        const stored = readStored(userId)
        if (stored && stillWanted()) await restoreStored(stored)
      }
    })()

    /** Rebuild a board from this device's copy: plan ids stored, contents refetched. */
    async function restoreStored(stored: StoredBoard) {
      if (stored.days.length === 0 || !stillWanted()) return
      setBoard({
        id: stored.id,
        locationId: stored.locationId,
        locationName: stored.locationName,
        query: stored.query,
        targets: stored.targets,
        periods: stored.periods,
        days: stored.days.map((day) => ({
          date: day.date,
          status: (day.planId ? 'loading' : 'empty') as DayStatus,
          plan: null,
          message: day.planId ? null : day.message,
          refining: false,
        })),
      })

      const results = await Promise.all(
        stored.days
          .filter((day) => day.planId)
          .map(async (day) => {
            try {
              return { date: day.date, plan: await api.getPlan(day.planId!) }
            } catch {
              return { date: day.date, plan: null }
            }
          }),
      )
      if (cancelled) return
      setBoard((current) => {
        if (!current) return current
        const byDate = new Map(results.map((entry) => [entry.date, entry.plan]))
        return {
          ...current,
          days: current.days.map((day) => {
            if (day.status !== 'loading') return day
            const plan = byDate.get(day.date) ?? null
            return plan
              ? { ...day, status: 'ready' as DayStatus, plan }
              : {
                  ...day,
                  status: 'error' as DayStatus,
                  message: 'This plan is no longer available.',
                }
          }),
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [userId])

  const generate = useCallback(
    async (spec: Interpretation & { locationId: string; locationName: string }) => {
      setBusy(true)
      const id = newBoardId()
      const marker: BoardRef = {
        id,
        query: spec.text || null,
        periods: spec.periods,
        dates: spec.dates,
      }
      const previousId = boardRef.current?.id

      commit({
        id,
        locationId: spec.locationId,
        locationName: spec.locationName,
        query: spec.text,
        targets: spec.targets,
        periods: spec.periods,
        days: spec.dates.map((date) => ({
          date,
          status: 'queued' as DayStatus,
          plan: null,
          message: null,
          refining: false,
        })),
      })

      await pooled(spec.dates, CONCURRENCY, async (date) => {
        patchDay(date, { status: 'loading', message: null })
        try {
          // Fresh: these ids are sent to /plans/generate, and upstream reissues them.
          const available = await fetchPeriods(spec.locationId, date, { fresh: true })
          if (available.length === 0) {
            patchDay(date, {
              status: 'empty',
              message: 'No menu is published for this day yet.',
            })
            return
          }

          const wanted = matchPeriods(available, spec.periods)
          if (spec.periods.length > 0 && wanted.length === 0) {
            patchDay(date, {
              status: 'empty',
              message: `No ${spec.periods.join(' or ')} served here on this day.`,
            })
            return
          }

          const plan = await api.generatePlan({
            location_id: spec.locationId,
            date,
            period_ids: wanted.map((period) => period.id),
            constraints: spec.text || null,
            targets: Object.keys(spec.targets).length ? spec.targets : null,
            title: `${weekdayLabel(date, 'long')} at ${spec.locationName}`,
            board: marker,
          })
          patchDay(date, { status: 'ready', plan, message: null })
        } catch (error) {
          const status =
            error instanceof ApiError && error.status === 404 ? 'empty' : 'error'
          patchDay(date, { status, plan: null, message: errorMessage(error) })
        }
      })

      setBusy(false)
      // patchDay keeps the ref current, so every finished day is stored —
      // including the last one, which a render-time ref would still miss.
      if (userId) writeStored(userId, boardRef.current)
      // The new week supersedes the old one on the server as well.
      if (previousId && previousId !== id) void api.clearWeek(previousId).catch(() => undefined)
    },
    [commit, patchDay, userId],
  )

  /**
   * Swap in plans whose change the student confirmed — from the day panel or
   * the Advisor. Plans are never rewritten here directly: every change goes
   * through propose → review → apply (`state/changes.ts`).
   */
  const replacePlans = useCallback(
    (plans: Plan[]) => {
      const current = boardRef.current
      if (!current) return
      const byId = new Map(plans.map((plan) => [plan.id, plan]))
      commit({
        ...current,
        days: current.days.map((day) => {
          const plan = day.plan ? byId.get(day.plan.id) : undefined
          return plan ? { ...day, plan, status: 'ready' as DayStatus, message: null } : day
        }),
      })
    },
    [commit],
  )

  const clear = useCallback(() => {
    const id = boardRef.current?.id
    commit(null)
    // If this fails the week comes back on the next load, which is the safe way to fail.
    if (id) void api.clearWeek(id).catch(() => undefined)
  }, [commit])

  return { board, busy, generate, replacePlans, clear }
}
