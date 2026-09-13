/** Mirrors the live database tables (users, meal_plans, plan_revisions). */

export interface NutritionTargets {
  calories?: number
  protein_g?: number
  carbs_g?: number
  fat_g?: number
  fiber_g?: number
  sodium_mg?: number
}

export type MacroField =
  | 'calories'
  | 'protein_g'
  | 'carbs_g'
  | 'fat_g'
  | 'saturated_fat_g'
  | 'fiber_g'
  | 'sugar_g'
  | 'sodium_mg'

/** The users table stores only credentials: no name, targets or dietary notes. */
export interface User {
  id: string
  email: string
  created_at: string
}

export interface TokenOut {
  access_token: string
  token_type: string
  user: User
}

export interface Location {
  id: string
  name: string
  building: string | null
  sort_order: number
}

export interface Period {
  id: string
  name: string | null
  slug: string | null
}

export interface PeriodsOut {
  location_id: string
  date: string
  periods: Period[]
}

export interface PlannedItem {
  item_id: string | null
  name: string | null
  category: string | null
  portion: string | null
  servings: number
  reason: string | null
  tags: string[]
  allergens: string[]
  calories: number | null
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
  saturated_fat_g: number | null
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
}

export interface Meal {
  period_id: string | null
  period_name: string | null
  notes: string | null
  items: PlannedItem[]
  totals: Partial<Record<MacroField, number>>
}

export interface TargetFitEntry {
  target: number
  actual: number
  delta: number
  pct_of_target: number | null
}

export interface PlanContent {
  title: string
  summary: string | null
  meals: Meal[]
  totals: Partial<Record<MacroField, number>>
  target_fit: Partial<Record<MacroField, TargetFitEntry>>
  constraint_notes: string[]
  warnings: string[]
}

export interface Revision {
  id: string
  revision_number: number
  instruction: string | null
  tool_used: string | null
  rationale: string | null
  created_at: string
}

export interface PlanSources {
  location_id?: string
  location_name?: string | null
  period_ids?: string[]
}

export interface Plan {
  id: string
  user_id: string
  plan_date: string
  title: string
  content: PlanContent
  targets: NutritionTargets
  constraints_text: string | null
  sources: PlanSources
  model: string | null
  revision_count: number
  created_at: string
  updated_at: string
  revisions: Revision[]
}

export interface PlanGenerateRequest {
  location_id: string
  date: string
  period_ids?: string[]
  constraints?: string | null
  targets?: NutritionTargets | null
  title?: string | null
}
