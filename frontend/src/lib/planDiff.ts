/**
 * What changed between two versions of a day's plan.
 *
 * Items are matched by `item_id` within the same meal period, so moving a dish
 * to another period reads as removed there and added here — which is what it
 * is. A hall can list one dish twice, so repeats are numbered rather than
 * collapsed.
 */

import type { Meal, PlanContent, PlannedItem } from '../api/types'
import { PERIOD_ORDER } from './parse'

export type ItemChangeKind = 'added' | 'removed' | 'servings' | 'kept'

export interface ItemChange {
  key: string
  kind: ItemChangeKind
  name: string
  before: PlannedItem | null
  after: PlannedItem | null
}

export interface MealChange {
  key: string
  periodName: string
  items: ItemChange[]
  changed: boolean
}

/** `null` where a side did not publish the macro, so there is no honest delta. */
export interface MacroShift {
  before: number | null
  after: number | null
  delta: number | null
}

export interface PlanDiff {
  meals: MealChange[]
  calories: MacroShift
  protein: MacroShift
  changed: boolean
}

function keyed(items: PlannedItem[]): Map<string, PlannedItem> {
  const seen = new Map<string, number>()
  const out = new Map<string, PlannedItem>()
  for (const item of items) {
    const base = item.item_id ?? `name:${item.name ?? ''}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    out.set(`${base}#${count}`, item)
  }
  return out
}

/**
 * Meals match by period name first. Upstream reissues period ids, so a plan
 * saved last week and its refinement today can hold different ids for the same
 * lunch; matching on id would show every item as removed and re-added.
 */
function mealKey(meal: Meal): string {
  const name = (meal.period_name ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return name ? `name:${name}` : `id:${meal.period_id ?? ''}`
}

function periodRank(name: string): number {
  const index = PERIOD_ORDER.findIndex(
    (period) => period.toLowerCase() === name.trim().toLowerCase(),
  )
  return index === -1 ? PERIOD_ORDER.length : index
}

function diffMeal(key: string, before: Meal | undefined, after: Meal | undefined): MealChange {
  const was = keyed(before?.items ?? [])
  const now = keyed(after?.items ?? [])
  const items: ItemChange[] = []

  for (const [itemKey, item] of was) {
    const next = now.get(itemKey)
    const name = item.name ?? 'Item'
    if (!next) {
      items.push({ key: itemKey, kind: 'removed', name, before: item, after: null })
    } else {
      const same = Math.abs(next.servings - item.servings) < 0.01
      items.push({ key: itemKey, kind: same ? 'kept' : 'servings', name, before: item, after: next })
    }
  }
  for (const [itemKey, item] of now) {
    if (was.has(itemKey)) continue
    items.push({ key: itemKey, kind: 'added', name: item.name ?? 'Item', before: null, after: item })
  }

  return {
    key,
    periodName: after?.period_name ?? before?.period_name ?? 'Meal',
    items,
    changed: items.some((item) => item.kind !== 'kept'),
  }
}

function shift(before: number | null | undefined, after: number | null | undefined): MacroShift {
  const was = typeof before === 'number' ? before : null
  const now = typeof after === 'number' ? after : null
  return { before: was, after: now, delta: was !== null && now !== null ? now - was : null }
}

export function diffPlan(before: PlanContent, after: PlanContent): PlanDiff {
  const was = new Map(before.meals.map((meal) => [mealKey(meal), meal]))
  const now = new Map(after.meals.map((meal) => [mealKey(meal), meal]))
  const meals = [...new Set([...was.keys(), ...now.keys()])]
    .map((key) => diffMeal(key, was.get(key), now.get(key)))
    .sort((a, b) => periodRank(a.periodName) - periodRank(b.periodName))

  return {
    meals,
    calories: shift(before.totals.calories, after.totals.calories),
    protein: shift(before.totals.protein_g, after.totals.protein_g),
    changed: meals.some((meal) => meal.changed),
  }
}
