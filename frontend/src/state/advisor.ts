/**
 * The Advisor: a question in, one real meal recommendation out.
 *
 * There is no chat endpoint on the backend, and there does not need to be —
 * `POST /plans/generate` already takes a natural-language `constraints` string
 * and returns items chosen off the live menu with server-computed macros. The
 * Advisor drives that endpoint scoped to a **single meal period** so the plan
 * comes back as one meal rather than a whole day:
 *
 *   1. pick the hall — the student's favourite, or one named in the question
 *   2. pick the period — whatever the hall is serving around now
 *   3. set `targets` to what is **left** of the day's goals after logged meals,
 *      so the suggestion fits the remaining room rather than the whole day
 *   4. send the question verbatim, plus the diet/allergy sentences and a line
 *      about what has already been eaten, as `constraints`
 *
 * "See alternatives" is `POST /plans/{id}/refine`, which needs a Gemini key;
 * without one the backend answers 503 and that message is shown as-is.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Location, NutritionTargets, Plan } from '../api/types'
import { todayISO } from '../lib/dates'
import { matchLocation } from '../lib/parse'
import { fetchPeriods } from './availability'
import type { DayTotals } from './meals'
import { listSentence, profileConstraints, type StudentProfile } from './profile'

export interface AdvisorMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Present on the assistant turn that carries a recommendation. */
  plan: Plan | null
  /** The hall the recommendation came from, for the card's location line. */
  locationName: string | null
  createdAt: string
  error?: boolean
}

export type AdvisorState = 'idle' | 'thinking' | 'ready' | 'error'

/** The chips shown before the first question. */
export const QUICK_PROMPTS = [
  'What should I eat now?',
  'High protein dinner',
  'Under 600 calories',
  'Vegetarian options',
] as const

/** Never ask the planner for less than a real meal, however full the day is. */
const MIN_CALORIE_TARGET = 350
const MIN_PROTEIN_TARGET = 15

function newId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * What is left of the day, floored so a student who has already hit their goal
 * still gets a sensible small meal instead of an impossible one.
 */
export function remainingTargets(
  profile: StudentProfile,
  consumed: DayTotals,
): NutritionTargets {
  return {
    calories: Math.max(MIN_CALORIE_TARGET, profile.calorieGoal - consumed.calories),
    protein_g: Math.max(MIN_PROTEIN_TARGET, profile.proteinGoal - consumed.protein_g),
  }
}

/** The period a hall is serving closest to now, preferring one that is current. */
export function currentPeriod<T extends { name: string | null }>(
  periods: T[],
  at = new Date(),
): T | null {
  if (periods.length === 0) return null
  const hour = at.getHours()
  const wanted =
    hour < 10.5 ? /breakfast|brunch/i : hour < 15 ? /lunch|brunch/i : hour < 21 ? /dinner/i : /late/i
  return (
    periods.find((period) => wanted.test(period.name ?? '')) ??
    // Nothing matches the clock: an all-day period beats an arbitrary pick.
    periods.find((period) => /everyday|all day|retail/i.test(period.name ?? '')) ??
    periods[0]
  )
}

/** The sentence the model reads about what the student has already eaten. */
export function intakeSentence(profile: StudentProfile, consumed: DayTotals): string {
  if (consumed.meals === 0 && consumed.calories === 0) {
    return (
      `I have not logged anything yet today. My goals are ` +
      `${profile.calorieGoal} calories and ${profile.proteinGoal}g protein for the whole day, ` +
      `so this meal should be one part of that, not all of it.`
    )
  }
  return (
    `So far today I have eaten ${consumed.calories} calories and ` +
    `${consumed.protein_g}g protein across ${consumed.meals} ` +
    `${consumed.meals === 1 ? 'meal' : 'meals'}. My goals are ${profile.calorieGoal} calories ` +
    `and ${profile.proteinGoal}g protein for the day, so this meal should fit what is left.`
  )
}

export interface AskContext {
  profile: StudentProfile
  consumed: DayTotals
  locations: Location[]
  /** Hall to use when the question names none and no favourite is set. */
  fallbackLocationId: string | null
}

export interface AdvisorStore {
  messages: AdvisorMessage[]
  state: AdvisorState
  /** The most recent recommendation, or null before the first answer. */
  latest: AdvisorMessage | null
  ask: (question: string, context: AskContext) => Promise<void>
  alternatives: (message: AdvisorMessage) => Promise<void>
  reset: () => void
}

export function useAdvisor(): AdvisorStore {
  const [messages, setMessages] = useState<AdvisorMessage[]>([])
  const [state, setState] = useState<AdvisorState>('idle')
  const busy = useRef(false)

  const push = useCallback((message: AdvisorMessage) => {
    setMessages((current) => [...current, message])
  }, [])

  const ask = useCallback(
    async (question: string, context: AskContext) => {
      const text = question.trim()
      if (!text || busy.current) return
      busy.current = true

      push({
        id: newId(),
        role: 'user',
        text,
        plan: null,
        locationName: null,
        createdAt: new Date().toISOString(),
      })
      setState('thinking')

      const { profile, consumed, locations, fallbackLocationId } = context

      // A hall named in the question wins; then a favourite; then the default.
      const named = matchLocation(text, locations)
      const favourite = profile.favoriteLocationIds
        .map((id) => locations.find((entry) => entry.id === id))
        .find(Boolean)
      const location =
        named ??
        favourite ??
        locations.find((entry) => entry.id === fallbackLocationId) ??
        locations[0] ??
        null

      if (!location) {
        push({
          id: newId(),
          role: 'assistant',
          text: 'I could not reach the campus dining list just now. Try again in a moment.',
          plan: null,
          locationName: null,
          createdAt: new Date().toISOString(),
          error: true,
        })
        setState('error')
        busy.current = false
        return
      }

      const date = todayISO()

      try {
        const periods = await fetchPeriods(location.id, date)
        if (periods.length === 0) {
          push({
            id: newId(),
            role: 'assistant',
            text: `${location.name} has not published a menu for today. Try another hall from the Dining tab.`,
            plan: null,
            locationName: location.name,
            createdAt: new Date().toISOString(),
            error: true,
          })
          setState('error')
          busy.current = false
          return
        }

        const period = currentPeriod(periods)
        const constraints = [
          text,
          intakeSentence(profile, consumed),
          ...profileConstraints(profile),
          'Recommend one meal for this period only — a small number of items that go together on a tray.',
        ]
          .filter(Boolean)
          .join(' ')

        const plan = await api.generatePlan({
          location_id: location.id,
          date,
          period_ids: period ? [period.id] : [],
          constraints,
          targets: remainingTargets(profile, consumed),
          title: `${period?.name ?? 'Meal'} at ${location.name}`,
        })

        // A plan can come back 201 but empty — the greedy planner answers
        // "no menu items satisfied the stated dietary constraints" that way,
        // and an empty card reading "0 kcal" would be worse than saying so.
        if (!isUsable(plan)) {
          push({
            id: newId(),
            role: 'assistant',
            text: nothingFits(plan, location.name, period?.name ?? null),
            plan: null,
            locationName: location.name,
            createdAt: new Date().toISOString(),
            error: true,
          })
          setState('error')
          busy.current = false
          return
        }

        push({
          id: newId(),
          role: 'assistant',
          text: answerText(plan, location.name),
          plan,
          locationName: location.name,
          createdAt: new Date().toISOString(),
        })
        setState('ready')
      } catch (error) {
        push({
          id: newId(),
          role: 'assistant',
          text: describeError(error, location.name),
          plan: null,
          locationName: location.name,
          createdAt: new Date().toISOString(),
          error: true,
        })
        setState('error')
      } finally {
        busy.current = false
      }
    },
    [push],
  )

  /** Re-roll the open recommendation through the refine endpoint. */
  const alternatives = useCallback(
    async (message: AdvisorMessage) => {
      if (!message.plan || busy.current) return
      busy.current = true
      setState('thinking')
      try {
        const plan = await api.refinePlan(
          message.plan.id,
          'Suggest a different meal for this period using other items on the same menu. ' +
            'Keep it close to the same calories and protein.',
        )
        if (!isUsable(plan)) {
          push({
            id: newId(),
            role: 'assistant',
            text: `I could not find another combination at ${message.locationName ?? 'that hall'} that still fits. The one above is your best option on this menu.`,
            plan: null,
            locationName: message.locationName,
            createdAt: new Date().toISOString(),
            error: true,
          })
          setState('ready')
          busy.current = false
          return
        }
        setMessages((current) =>
          current.map((entry) =>
            entry.id === message.id
              ? { ...entry, plan, text: answerText(plan, entry.locationName ?? 'this hall') }
              : entry,
          ),
        )
        setState('ready')
      } catch (error) {
        push({
          id: newId(),
          role: 'assistant',
          text: describeError(error, message.locationName),
          plan: null,
          locationName: message.locationName,
          createdAt: new Date().toISOString(),
          error: true,
        })
        setState('error')
      } finally {
        busy.current = false
      }
    },
    [push],
  )

  const reset = useCallback(() => {
    setMessages([])
    setState('idle')
  }, [])

  const latest = useMemo(
    () => [...messages].reverse().find((message) => message.plan) ?? null,
    [messages],
  )

  return useMemo(
    () => ({ messages, state, latest, ask, alternatives, reset }),
    [messages, state, latest, ask, alternatives, reset],
  )
}

/**
 * Is there actually a meal here?
 *
 * `/plans/generate` answers 201 with an empty meal when nothing on the menu
 * survived the constraints, so "it worked" is not the same as "there is
 * something to eat".
 */
function isUsable(plan: Plan): boolean {
  const meal = plan.content.meals[0]
  if (!meal || meal.items.length === 0) return false
  return (plan.content.totals.calories ?? 0) > 0
}

/**
 * Why nothing came back. The backend's own `warnings` are already written for
 * a reader, so the first one that is not about the missing Gemini key is
 * preferred over anything composed here.
 */
function nothingFits(plan: Plan, locationName: string, periodName: string | null): string {
  const warning = plan.content.warnings.find(
    (entry) => !/GEMINI_API_KEY|fallback planner/i.test(entry),
  )
  const where = periodName
    ? `the ${periodName.toLowerCase()} menu at ${locationName}`
    : `the menu at ${locationName}`
  if (warning) {
    return `Nothing on ${where} fits — ${warning.replace(/\.$/, '').toLowerCase()}. Try another hall, or loosen a preference in your profile.`
  }
  return `I could not find anything on ${where} that fits your goals and preferences. Try another hall from the Dining tab.`
}

/**
 * What the assistant bubble says.
 *
 * Gemini writes a summary addressed to the student, so that is used as-is. The
 * offline planner writes an engineering note instead ("Greedy selection
 * maximising protein per calorie…"), which is the exact register the tone
 * guidance rules out — so a fallback plan gets a sentence composed here.
 */
function answerText(plan: Plan, locationName: string): string {
  if (plan.model === 'fallback-greedy' || !plan.content.summary) {
    return describePlan(plan, locationName)
  }
  return plan.content.summary
}

function describePlan(plan: Plan, locationName: string): string {
  const calories = Math.round(plan.content.totals.calories ?? 0)
  const protein = Math.round(plan.content.totals.protein_g ?? 0)
  const names = (plan.content.meals[0]?.items ?? [])
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) {
    return `I could not find anything that fits at ${locationName} right now.`
  }
  const macros = protein > 0 ? `${calories} calories and ${protein}g protein` : `${calories} calories`
  return `Here's what works at ${locationName} right now: ${listSentence(names)}. That's about ${macros}.`
}

function describeError(error: unknown, locationName: string | null): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return `${locationName ?? 'That hall'} has not published a menu for this meal yet. Try the Dining tab for somewhere that is open.`
    }
    if (error.status === 503) {
      return 'Refinement needs a Gemini key on the backend. Plans still work — set GEMINI_API_KEY to talk them into shape.'
    }
    return error.message
  }
  return 'Something went wrong while building that. Try again.'
}
