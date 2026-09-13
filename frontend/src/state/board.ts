import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { NutritionTargets, Plan } from '../api/types'
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
    // Out of quota or blocked storage: the board just will not persist.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** Run tasks with a small pool so a 7-day week is not 7 parallel requests. */
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

export function usePlanBoard(userId: string | null) {
  const [board, setBoard] = useState<Board | null>(null)
  const [busy, setBusy] = useState(false)
  const boardRef = useRef<Board | null>(null)

  boardRef.current = board

  const commit = useCallback(
    (next: Board | null) => {
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
      return { ...current, days }
    })
  }, [])

  // Restore the last board on load: plan ids are stored, contents refetched.
  useEffect(() => {
    if (!userId) {
      setBoard(null)
      return
    }
    const stored = readStored(userId)
    if (!stored || stored.days.length === 0) return

    let cancelled = false
    setBoard({
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

    Promise.all(
      stored.days
        .filter((day) => day.planId)
        .map(async (day) => {
          try {
            return { date: day.date, plan: await api.getPlan(day.planId!) }
          } catch {
            return { date: day.date, plan: null }
          }
        }),
    ).then((results) => {
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
    })

    return () => {
      cancelled = true
    }
  }, [userId])

  const generate = useCallback(
    async (spec: Interpretation & { locationId: string; locationName: string }) => {
      setBusy(true)
      const next: Board = {
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
      }
      commit(next)

      await pooled(spec.dates, CONCURRENCY, async (date) => {
        patchDay(date, { status: 'loading', message: null })
        try {
          const available = await fetchPeriods(spec.locationId, date)
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
          })
          patchDay(date, { status: 'ready', plan, message: null })
        } catch (error) {
          const status =
            error instanceof ApiError && error.status === 404 ? 'empty' : 'error'
          patchDay(date, { status, plan: null, message: errorMessage(error) })
        }
      })

      setBusy(false)
      if (userId) writeStored(userId, boardRef.current)
    },
    [commit, patchDay, userId],
  )

  const refine = useCallback(
    async (dates: string[], instruction: string) => {
      const current = boardRef.current
      if (!current) return
      const targets = current.days.filter(
        (day) => dates.includes(day.date) && day.plan,
      )
      if (!targets.length) return

      setBusy(true)
      for (const day of targets) patchDay(day.date, { refining: true, message: null })

      await pooled(targets, CONCURRENCY, async (day) => {
        try {
          const plan = await api.refinePlan(day.plan!.id, instruction)
          patchDay(day.date, { plan, status: 'ready', refining: false, message: null })
        } catch (error) {
          patchDay(day.date, { refining: false, message: errorMessage(error) })
        }
      })

      setBusy(false)
      if (userId) writeStored(userId, boardRef.current)
    },
    [patchDay, userId],
  )

  const clear = useCallback(() => {
    commit(null)
  }, [commit])

  return { board, busy, generate, refine, clear }
}
