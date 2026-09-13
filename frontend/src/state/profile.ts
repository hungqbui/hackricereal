/**
 * The student's goals and preferences.
 *
 * `GET/PUT /profile` is the source of truth. The backend reads the saved
 * profile on every plan request, so diet, allergies and dislikes steer the
 * Advisor even when a question never mentions them.
 *
 * A copy is kept in `localStorage`, namespaced per user id, for two reasons:
 * the first paint has the student's name and goals before the network
 * answers, and an edit made while the backend is unreachable is not lost — it
 * is marked dirty and pushed on the next load. The same path migrates a
 * profile saved by a build from before the backend kept one.
 *
 * Saves are optimistic and debounced: the Profile screen writes on every
 * keystroke and slider tick, and one PUT per pause is plenty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../api/client'
import type { ProfileOut, ProfileUpdate } from '../api/types'

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
const DIRTY_PREFIX = 'unibite.profile.dirty.'
const SAVE_DELAY_MS = 450
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/* ----------------------------------------------------------- conversion */

/** Merged against the default so a partial or older profile still loads. */
function normalise(parsed: Partial<Omit<StudentProfile, 'schedule'>> & {
  schedule?: Partial<MealSchedule>
}): StudentProfile {
  return {
    ...DEFAULT_PROFILE,
    ...parsed,
    diet: parsed.diet && parsed.diet in DIET_LABELS ? parsed.diet : 'none',
    schedule: { ...DEFAULT_PROFILE.schedule, ...(parsed.schedule ?? {}) },
    allergies: parsed.allergies ?? [],
    avoid: parsed.avoid ?? [],
    favoriteLocationIds: parsed.favoriteLocationIds ?? [],
  }
}

function fromServer(out: ProfileOut): StudentProfile {
  return normalise({
    displayName: out.display_name ?? '',
    calorieGoal: out.calorie_goal,
    proteinGoal: out.protein_goal,
    diet: out.diet as DietPreference,
    allergies: out.allergies,
    avoid: out.avoid,
    favoriteLocationIds: out.favorite_location_ids,
    schedule: out.schedule as Partial<MealSchedule>,
  })
}

/** Only the fields present in the patch, in the API's shape. */
function toServer(patch: Partial<StudentProfile>): ProfileUpdate {
  const body: ProfileUpdate = {}
  if (patch.displayName !== undefined) body.display_name = patch.displayName.trim() || null
  if (patch.calorieGoal !== undefined) body.calorie_goal = patch.calorieGoal
  if (patch.proteinGoal !== undefined) body.protein_goal = patch.proteinGoal
  if (patch.diet !== undefined) body.diet = patch.diet
  if (patch.allergies !== undefined) body.allergies = patch.allergies
  if (patch.avoid !== undefined) body.avoid = patch.avoid
  if (patch.favoriteLocationIds !== undefined) {
    body.favorite_location_ids = patch.favoriteLocationIds
  }
  if (patch.schedule !== undefined) {
    // A cleared time input reports "", which the API rightly rejects.
    body.schedule = Object.fromEntries(
      Object.entries(patch.schedule).filter(([, value]) => CLOCK_TIME.test(value)),
    )
  }
  return body
}

/* -------------------------------------------------------------- storage */

function readCache(userId: string): StudentProfile | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${userId}`)
    return raw ? normalise(JSON.parse(raw) as Partial<StudentProfile>) : null
  } catch {
    return null
  }
}

function writeCache(userId: string, profile: StudentProfile): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(profile))
  } catch {
    // Private browsing or a full quota: the server copy still holds.
  }
}

function isDirty(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${DIRTY_PREFIX}${userId}`) === '1'
  } catch {
    return false
  }
}

function markDirty(userId: string, dirty: boolean): void {
  try {
    if (dirty) window.localStorage.setItem(`${DIRTY_PREFIX}${userId}`, '1')
    else window.localStorage.removeItem(`${DIRTY_PREFIX}${userId}`)
  } catch {
    // Nothing to do: without storage there is nothing to retry from either.
  }
}

/* ----------------------------------------------------------------- hook */

/** Where the profile stands against the server, for the Profile screen. */
export type ProfileSync = 'loading' | 'saving' | 'saved' | 'offline'

export interface ProfileStore {
  profile: StudentProfile
  update: (patch: Partial<StudentProfile>) => void
  reset: () => void
  /** True once the user has saved anything, so onboarding can be offered once. */
  configured: boolean
  sync: ProfileSync
}

export function useProfile(userId: string | null, email: string | null): ProfileStore {
  const [profile, setProfile] = useState<StudentProfile>(DEFAULT_PROFILE)
  const [configured, setConfigured] = useState(false)
  const [sync, setSync] = useState<ProfileSync>('loading')

  // Edits not yet sent, merged, so a burst of changes becomes one PUT.
  const pending = useRef<Partial<StudentProfile>>({})
  const timer = useRef<number | null>(null)
  const owner = useRef(userId)

  const flush = useCallback(async () => {
    timer.current = null
    const user = owner.current
    const patch = pending.current
    pending.current = {}
    if (!user || Object.keys(patch).length === 0) return

    setSync('saving')
    try {
      await api.updateProfile(toServer(patch))
      if (owner.current !== user) return
      if (Object.keys(pending.current).length === 0 && timer.current === null) {
        markDirty(user, false)
        setSync('saved')
      }
    } catch {
      if (owner.current !== user) return
      // Keep it queued: the next edit retries, and the dirty flag covers a reload.
      pending.current = { ...patch, ...pending.current }
      setSync('offline')
    }
  }, [])

  useEffect(() => {
    owner.current = userId
    pending.current = {}
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (!userId) {
      setProfile(DEFAULT_PROFILE)
      setConfigured(false)
      setSync('loading')
      return
    }

    // Fall back to the email's local part so the greeting has a name to use.
    const named = (value: StudentProfile): StudentProfile =>
      value.displayName || !email
        ? value
        : { ...value, displayName: titleise(email.split('@')[0] ?? '') }

    const cached = readCache(userId)
    setProfile(named(cached ?? DEFAULT_PROFILE))
    setConfigured(Boolean(cached))
    setSync('loading')

    let cancelled = false
    void (async () => {
      try {
        const server = await api.profile()
        if (cancelled) return
        // An edit made while this request was out wins over what it returned.
        if (Object.keys(pending.current).length > 0 || timer.current !== null) return

        if (cached && (isDirty(userId) || !server.updated_at)) {
          // Edits that never reached the server, or a profile from before it kept one.
          await api.updateProfile(toServer(cached))
          if (cancelled) return
          markDirty(userId, false)
          setConfigured(true)
        } else {
          const next = fromServer(server)
          if (server.updated_at) writeCache(userId, next)
          setProfile(named(next))
          setConfigured(Boolean(server.updated_at))
        }
        setSync('saved')
      } catch {
        if (!cancelled) setSync('offline')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId, email])

  const update = useCallback(
    (patch: Partial<StudentProfile>) => {
      setProfile((current) => {
        const next = { ...current, ...patch }
        if (userId) writeCache(userId, next)
        return next
      })
      setConfigured(true)
      if (!userId) return

      markDirty(userId, true)
      pending.current = { ...pending.current, ...patch }
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
      setSync('saving')
    },
    [userId, flush],
  )

  const reset = useCallback(() => update(DEFAULT_PROFILE), [update])

  return useMemo(
    () => ({ profile, update, reset, configured, sync }),
    [profile, update, reset, configured, sync],
  )
}

function titleise(value: string): string {
  const cleaned = value.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1))
}

/**
 * The preference half of a plan request, as sentences Gemini can act on.
 *
 * The backend already adds the saved profile to every prompt. These ride along
 * in `constraints` too, so an edit whose save is still in flight counts.
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

/** Short labels for what the planner is steering around, for display. */
export function preferenceTags(profile: StudentProfile): string[] {
  const tags: string[] = []
  if (profile.diet !== 'none') tags.push(DIET_LABELS[profile.diet])
  for (const allergen of profile.allergies) tags.push(`No ${allergen.toLowerCase()}`)
  for (const food of profile.avoid) tags.push(`Avoids ${food}`)
  return tags
}

export function listSentence(values: string[]): string {
  if (values.length === 0) return ''
  if (values.length === 1) return values[0]
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}
