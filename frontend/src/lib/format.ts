import type { MacroField, NutritionTargets } from '../api/types'

export const MACRO_LABELS: Record<MacroField, string> = {
  calories: 'Calories',
  protein_g: 'Protein',
  carbs_g: 'Carbs',
  fat_g: 'Fat',
  saturated_fat_g: 'Sat. fat',
  fiber_g: 'Fiber',
  sugar_g: 'Sugar',
  sodium_mg: 'Sodium',
}

export const MACRO_UNITS: Record<MacroField, string> = {
  calories: '',
  protein_g: 'g',
  carbs_g: 'g',
  fat_g: 'g',
  saturated_fat_g: 'g',
  fiber_g: 'g',
  sugar_g: 'g',
  sodium_mg: 'mg',
}

/** Order used wherever macros are listed together. */
export const MACRO_ORDER: MacroField[] = [
  'calories',
  'protein_g',
  'carbs_g',
  'fat_g',
  'fiber_g',
  'sugar_g',
  'saturated_fat_g',
  'sodium_mg',
]

export const TARGET_FIELDS: Array<keyof NutritionTargets> = [
  'calories',
  'protein_g',
  'carbs_g',
  'fat_g',
  'fiber_g',
  'sodium_mg',
]

export function round(value: number | null | undefined, places = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function macroValue(
  value: number | null | undefined,
  field: MacroField,
): string {
  const rounded = round(value, field === 'calories' || field === 'sodium_mg' ? 0 : 1)
  if (rounded === null) return '—'
  return `${rounded.toLocaleString()}${MACRO_UNITS[field]}`
}

export function servingsLabel(servings: number): string | null {
  if (!Number.isFinite(servings) || servings === 1) return null
  const rounded = round(servings, 2) ?? servings
  return `${rounded}×`
}

/** Green when within 10% of target, amber within 25%, red beyond. */
export function fitTone(pct: number | null): 'on' | 'near' | 'off' {
  if (pct === null) return 'near'
  const drift = Math.abs(pct - 100)
  if (drift <= 10) return 'on'
  if (drift <= 25) return 'near'
  return 'off'
}

export function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1))
}
