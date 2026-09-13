/**
 * What a dining hall actually serves, per day.
 *
 * Halls differ: Moody Towers runs Breakfast/Lunch/Dinner/Everyday, Cougar
 * Woods adds Late Night, and a retail stand may publish one period or
 * nothing at all. Menus are also only posted a couple of weeks out, so a
 * date far ahead comes back empty even for a hall that serves all day.
 *
 * The composer needs both facts before the user commits to a plan, so this
 * loads the real period list for every selected date and caches it. The
 * cache is module-level and shared with the plan board, so selecting a day
 * in the composer and then planning it costs one request, not two.
 */

import { useEffect, useMemo, useState } from 'react'

import { api } from '../api/client'
import type { Period } from '../api/types'
import { PERIOD_ORDER, matchPeriods, type PeriodName } from '../lib/parse'

const cache = new Map<string, Period[]>()

function key(locationId: string, date: string): string {
  return `${locationId}:${date}`
}

/** Cached period lookup. Shared by the composer and the plan board. */
export async function fetchPeriods(
  locationId: string,
  date: string,
): Promise<Period[]> {
  const cacheKey = key(locationId, date)
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const payload = await api.periods(locationId, date)
  cache.set(cacheKey, payload.periods)
  return payload.periods
}

export interface DayAvailability {
  date: string
  /** Null while in flight, or if the lookup failed. */
  periods: Period[] | null
  /** The hall published nothing for this date. */
  closed: boolean
  error: string | null
}

export interface Availability {
  loading: boolean
  byDate: DayAvailability[]
  /** Period names served on at least one selected day. */
  served: Set<PeriodName>
  /** Period names served on some selected days but not all. */
  partial: Set<PeriodName>
  /** Selected dates the hall publishes no menu for. */
  closedDates: string[]
  /** True once every selected date is known to publish nothing. */
  allClosed: boolean
  /** Which of the user's chosen periods this hall never serves. */
  unavailableSelected: PeriodName[]
}

const EMPTY: Availability = {
  loading: false,
  byDate: [],
  served: new Set(),
  partial: new Set(),
  closedDates: [],
  allClosed: false,
  unavailableSelected: [],
}

export function useAvailability(
  locationId: string | null,
  dates: string[],
  selectedPeriods: PeriodName[],
): Availability {
  const [byDate, setByDate] = useState<DayAvailability[]>([])
  const [loading, setLoading] = useState(false)

  // Dates arrive as a new array each render; key the effect on the content.
  const dateKey = dates.join(',')

  useEffect(() => {
    if (!locationId || dates.length === 0) {
      setByDate([])
      setLoading(false)
      return
    }

    let cancelled = false
    const list = dateKey.split(',')
    setLoading(true)
    setByDate(
      list.map((date) => ({ date, periods: null, closed: false, error: null })),
    )

    void (async () => {
      const results = await Promise.all(
        list.map(async (date): Promise<DayAvailability> => {
          try {
            const periods = await fetchPeriods(locationId, date)
            return { date, periods, closed: periods.length === 0, error: null }
          } catch (error) {
            return {
              date,
              periods: null,
              closed: false,
              error: error instanceof Error ? error.message : 'Lookup failed.',
            }
          }
        }),
      )
      if (cancelled) return
      setByDate(results)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, dateKey])

  const selectedKey = selectedPeriods.join(',')

  return useMemo<Availability>(() => {
    if (!locationId || byDate.length === 0) return EMPTY

    const known = byDate.filter((day) => day.periods !== null)
    const open = known.filter((day) => !day.closed)

    const served = new Set<PeriodName>()
    const countByName = new Map<PeriodName, number>()

    for (const day of open) {
      for (const name of PERIOD_ORDER) {
        if (matchPeriods(day.periods ?? [], [name]).length > 0) {
          served.add(name)
          countByName.set(name, (countByName.get(name) ?? 0) + 1)
        }
      }
    }

    const partial = new Set<PeriodName>()
    for (const [name, count] of countByName) {
      if (count < open.length) partial.add(name)
    }

    const closedDates = known.filter((day) => day.closed).map((day) => day.date)

    return {
      loading,
      byDate,
      served,
      partial,
      closedDates,
      // Only claim "closed" once every date has actually resolved.
      allClosed: known.length === byDate.length && open.length === 0,
      unavailableSelected: (selectedKey ? (selectedKey.split(',') as PeriodName[]) : [])
        .filter((name) => name && !served.has(name)),
    }
  }, [locationId, byDate, loading, selectedKey])
}
