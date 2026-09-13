/**
 * The student's goals and preferences.
 *
 * The `users` table stores credentials only, so there is nowhere on the
 * backend to keep any of this yet. It lives in `localStorage`, namespaced per
 * user id, behind the small async-free interface below.
 *
 * **Swapping in a backend:** replace `read`/`write` with calls to
 * `GET/PUT /profile` and make `useProfile` await them. Nothing else in the app
 * reads storage directly — see `docs/BACKEND.md`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

export type DietPreference =
  | 'none'
  | 'vegetarian'
  | 'vegan'
  | 'pescatarian'
  | 'halal'
  | 'kosher'

export const DIET_LABELS: Record<DietPreference, string> = {
  none: 'No restriction',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  pescatarian: 'Pescatarian',
  halal: 'Halal',
  kosher: 'Kosher',
}

/** The allergens DineOnCampus tags items with, so the two vocabularies line up. */
export const COMMON_ALLERGENS = [
  'Milk',
  'Egg',
  'Wheat',
  'Gluten',
  'Soy',
  'Peanut',
  'Tree Nut',
  'Fish',
  'Shellfish',
  'Sesame',
] as const

export interface MealSchedule {
  breakfast: string
  lunch: string
  dinner: string
}

export interface StudentProfile {
  displayName: string
  calorieGoal: number
  proteinGoal: number
  diet: DietPreference
  allergies: string[]
  /** Free-text dislikes — "mushrooms", "anything fried". */
  avoid: string[]
  favoriteLocationIds: string[]
  schedule: MealSchedule
}

export const DEFAULT_PROFILE: StudentProfile = {
  displayName: '',
  calorieGoal: 2200,
  proteinGoal: 120,
  diet: 'none',
  allergies: [],
  avoid: [],
  favoriteLocationIds: [],
  schedule: { breakfast: '08:00', lunch: '12:30', dinner: '18:30' },
}

const STORAGE_PREFIX = 'unibite.profile.'

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`
}

/** Merged against the default so a profile saved by an older build still loads. */
function read(userId: string): StudentProfile {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return DEFAULT_PROFILE
    const parsed = JSON.parse(raw) as Partial<StudentProfile>
    return {
      ...DEFAULT_PROFILE,
      ...parsed,
      schedule: { ...DEFAULT_PROFILE.schedule, ...(parsed.schedule ?? {}) },
      allergies: parsed.allergies ?? [],
      avoid: parsed.avoid ?? [],
      favoriteLocationIds: parsed.favoriteLocationIds ?? [],
    }
  } catch {
    return DEFAULT_PROFILE
  }
}

function write(userId: string, profile: StudentProfile): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(profile))
  } catch {
    // Private browsing or a full quota: preferences just will not persist.
  }
}

export interface ProfileStore {
  profile: StudentProfile
  update: (patch: Partial<StudentProfile>) => void
  reset: () => void
  /** True once the user has saved anything, so onboarding can be offered once. */
  configured: boolean
}

export function useProfile(userId: string | null, email: string | null): ProfileStore {
  const [profile, setProfile] = useState<StudentProfile>(DEFAULT_PROFILE)
  const [configured, setConfigured] = useState(false)

  useEffect(() => {
    if (!userId) {
      setProfile(DEFAULT_PROFILE)
      setConfigured(false)
      return
    }
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(storageKey(userId))
    } catch {
      stored = null
    }
    const next = read(userId)
    // Fall back to the email's local part so the greeting has a name to use.
    if (!next.displayName && email) {
      next.displayName = titleise(email.split('@')[0] ?? '')
    }
    setProfile(next)
    setConfigured(Boolean(stored))
  }, [userId, email])

  const update = useCallback(
    (patch: Partial<StudentProfile>) => {
      setProfile((current) => {
        const next = { ...current, ...patch }
        if (userId) write(userId, next)
        return next
      })
      setConfigured(true)
    },
    [userId],
  )

  const reset = useCallback(() => {
    setProfile(DEFAULT_PROFILE)
    if (userId) write(userId, DEFAULT_PROFILE)
  }, [userId])

  return useMemo(
    () => ({ profile, update, reset, configured }),
    [profile, update, reset, configured],
  )
}

function titleise(value: string): string {
  const cleaned = value.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1))
}

/**
 * The preference half of a plan request, as a sentence Gemini can act on.
 *
 * Targets travel as numbers in `targets`; diet, allergies and dislikes have no
 * structured field on `POST /plans/generate`, so they ride along in
 * `constraints` — which is exactly what that field is for.
 */
export function profileConstraints(profile: StudentProfile): string[] {
  const parts: string[] = []
  if (profile.diet !== 'none') parts.push(`I eat ${DIET_LABELS[profile.diet].toLowerCase()}.`)
  if (profile.allergies.length) {
    parts.push(`I am allergic to ${listSentence(profile.allergies)} — never include them.`)
  }
  if (profile.avoid.length) parts.push(`I would rather avoid ${listSentence(profile.avoid)}.`)
  return parts
}

export function listSentence(values: string[]): string {
  if (values.length === 0) return ''
  if (values.length === 1) return values[0]
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}
