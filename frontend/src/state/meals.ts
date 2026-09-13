/**
 * What the student has actually eaten.
 *
 * There is no `logged_meals` table on the backend yet, so the log lives in
 * `localStorage` under `unibite.meals.<userId>`. Every macro stored here was
 * computed server-side from the real DineOnCampus payload — a logged item is a
 * copy of a menu item or of an item Gemini picked, never a number the client
 * invented.
 *
 * **Swapping in a backend:** replace `read`/`write` with `GET /meals?date=` and
 * `POST /meals` / `DELETE /meals/{id}`. The `LoggedMeal` shape below is the
 * intended row shape — see `docs/BACKEND.md`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MenuItem, PlannedItem } from '../api/types'
import { addDays, todayISO } from '../lib/dates'

/** The four slots the timeline groups by, in the order they are shown. */
export const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Snack', 'Dinner'] as const
export type MealSlot = (typeof MEAL_SLOTS)[number]

export interface LoggedItem {
  /** DineOnCampus item id, kept so a logged item can be traced to its menu. */
  itemId: string | null
  name: string
  category: string | null
  portion: string | null
  servings: number
  calories: number | null
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
  fiber_g: number | null
  sodium_mg: number | null
}

export interface LoggedMeal {
  id: string
  /** Service date, `YYYY-MM-DD`, local time. */
  date: string
  slot: MealSlot
  title: string
  locationId: string | null
  locationName: string | null
  /** When the student logged it, for the timeline's clock column. */
  loggedAt: string
  items: LoggedItem[]
  note: string | null
  /** Set when the meal came from an advisor recommendation or a week plan. */
  planId: string | null
  /**
   * The plan's meal period this was logged from, so a week plan can show which
   * of its meals were eaten. Absent on entries logged before it existed.
   */
  periodId?: string | null
}

/** Identifies one meal of one plan, for "was this eaten?" lookups. */
export function eatenKey(planId: string, periodId: string | null | undefined): string {
  return `${planId}:${periodId ?? ''}`
}

export interface DayTotals {
  calories: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number
  meals: number
}

const STORAGE_PREFIX = 'unibite.meals.'
/** Slots that count toward "2 of 3 meals" — a snack is a bonus, not a meal. */
const COUNTED_SLOTS: MealSlot[] = ['Breakfast', 'Lunch', 'Dinner']

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`
}

function read(userId: string): LoggedMeal[] {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LoggedMeal[]) : []
  } catch {
    return []
  }
}

function write(userId: string, meals: LoggedMeal[]): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(meals))
  } catch {
    // Nothing to do: the log simply will not survive a reload.
  }
}

function newId(): string {
  return `meal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function emptyTotals(): DayTotals {
  return { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, meals: 0 }
}

/** Sum a set of meals, scaling every item by its serving count. */
export function sumMeals(meals: LoggedMeal[]): DayTotals {
  const totals = emptyTotals()
  for (const meal of meals) {
    for (const item of meal.items) {
      const servings = Number.isFinite(item.servings) ? item.servings : 1
      totals.calories += (item.calories ?? 0) * servings
      totals.protein_g += (item.protein_g ?? 0) * servings
      totals.carbs_g += (item.carbs_g ?? 0) * servings
      totals.fat_g += (item.fat_g ?? 0) * servings
      totals.fiber_g += (item.fiber_g ?? 0) * servings
    }
  }
  const slots = new Set(
    meals.filter((meal) => COUNTED_SLOTS.includes(meal.slot)).map((meal) => meal.slot),
  )
  totals.meals = slots.size
  return {
    calories: Math.round(totals.calories),
    protein_g: Math.round(totals.protein_g),
    carbs_g: Math.round(totals.carbs_g),
    fat_g: Math.round(totals.fat_g),
    fiber_g: Math.round(totals.fiber_g),
    meals: totals.meals,
  }
}

/* ---------------------------------------------------------------- adapters */

export function itemFromMenuItem(item: MenuItem, servings = 1): LoggedItem {
  return {
    itemId: item.id,
    name: item.name ?? 'Item',
    category: item.category ?? null,
    portion: item.portion,
    servings,
    calories: item.calories,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
    fiber_g: item.fiber_g,
    sodium_mg: item.sodium_mg,
  }
}

export function itemFromPlannedItem(item: PlannedItem): LoggedItem {
  return {
    itemId: item.item_id,
    name: item.name ?? 'Item',
    category: item.category,
    portion: item.portion,
    servings: Number.isFinite(item.servings) ? item.servings : 1,
    calories: item.calories,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
    fiber_g: item.fiber_g,
    sodium_mg: item.sodium_mg,
  }
}

/** The slot a period name belongs to; "Late Night" and "Everyday" are snacks. */
export function slotForPeriod(periodName: string | null | undefined): MealSlot {
  const name = periodName ?? ''
  if (/breakfast|brunch|morning/i.test(name)) return 'Breakfast'
  if (/lunch|noon|midday/i.test(name)) return 'Lunch'
  if (/dinner|supper/i.test(name)) return 'Dinner'
  return 'Snack'
}

/** The slot the clock suggests, used to preselect the picker when logging. */
export function slotForTime(date = new Date()): MealSlot {
  const hour = date.getHours()
  if (hour < 10.5) return 'Breakfast'
  if (hour < 15) return 'Lunch'
  if (hour < 17) return 'Snack'
  return 'Dinner'
}

/* ------------------------------------------------------------------- hook */

export interface MealLog {
  meals: LoggedMeal[]
  /** Meals on one date, oldest first. */
  onDate: (date: string) => LoggedMeal[]
  totalsFor: (date: string) => DayTotals
  /** Totals across `days` dates ending at `endDate` inclusive. */
  totalsOver: (endDate: string, days: number) => DayTotals
  log: (meal: Omit<LoggedMeal, 'id' | 'loggedAt'> & { loggedAt?: string }) => LoggedMeal
  remove: (id: string) => void
  clear: () => void
}

export function useMealLog(userId: string | null): MealLog {
  const [meals, setMeals] = useState<LoggedMeal[]>([])

  useEffect(() => {
    setMeals(userId ? read(userId) : [])
  }, [userId])

  const commit = useCallback(
    (next: LoggedMeal[]) => {
      setMeals(next)
      if (userId) write(userId, next)
    },
    [userId],
  )

  const log = useCallback<MealLog['log']>(
    (meal) => {
      const entry: LoggedMeal = {
        ...meal,
        id: newId(),
        loggedAt: meal.loggedAt ?? new Date().toISOString(),
      }
      setMeals((current) => {
        const next = [...current, entry]
        if (userId) write(userId, next)
        return next
      })
      return entry
    },
    [userId],
  )

  const remove = useCallback(
    (id: string) => {
      setMeals((current) => {
        const next = current.filter((meal) => meal.id !== id)
        if (userId) write(userId, next)
        return next
      })
    },
    [userId],
  )

  const byDate = useMemo(() => {
    const map = new Map<string, LoggedMeal[]>()
    for (const meal of meals) {
      const bucket = map.get(meal.date)
      if (bucket) bucket.push(meal)
      else map.set(meal.date, [meal])
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
    }
    return map
  }, [meals])

  const onDate = useCallback((date: string) => byDate.get(date) ?? [], [byDate])

  const totalsFor = useCallback(
    (date: string) => sumMeals(byDate.get(date) ?? []),
    [byDate],
  )

  const totalsOver = useCallback(
    (endDate: string, days: number) => {
      const collected: LoggedMeal[] = []
      for (let offset = 0; offset < days; offset += 1) {
        collected.push(...(byDate.get(addDays(endDate, -offset)) ?? []))
      }
      return sumMeals(collected)
    },
    [byDate],
  )

  const clear = useCallback(() => commit([]), [commit])

  return useMemo(
    () => ({ meals, onDate, totalsFor, totalsOver, log, remove, clear }),
    [meals, onDate, totalsFor, totalsOver, log, remove, clear],
  )
}

export { todayISO }
