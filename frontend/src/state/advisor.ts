/**
 * The Advisor: a question in, one real meal recommendation out — or, when the
 * question is about the plan already on the student's week, a proposed change
 * to that plan that nothing saves until the student confirms it.
 *
 * Recommendations drive `POST /plans/generate` scoped to a **single meal
 * period** so the plan comes back as one meal rather than a whole day:
 *
 *   1. pick the hall — the student's favourite, or one named in the question
 *   2. pick the period — whatever the hall is serving around now
 *   3. set `targets` to what is **left** of the day's goals after logged meals,
 *      so the suggestion fits the remaining room rather than the whole day
 *   4. send the question verbatim, plus the diet/allergy sentences and a line
 *      about what has already been eaten, as `constraints`
 *
 * The backend also reads the saved profile on every call, so preferences apply
 * even when a question never mentions them.
 *
 * Schedule changes go through `POST /plans/{id}/propose`, which runs the
 * refinement without saving; the card shows the difference, and only "Update
 * my schedule" calls `POST /plans/{id}/apply`. "See alternatives" is still
 * `POST /plans/{id}/refine`. All three need a Gemini key; without one the
 * backend answers 503 and that message is shown as-is.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Location, NutritionTargets, Plan, PlanProposal } from '../api/types'
import { addDays, describeRange, friendlyDate, todayISO, weekdayLabel } from '../lib/dates'
import { interpret, matchLocation, type PeriodName } from '../lib/parse'
import { diffPlan, type PlanDiff } from '../lib/planDiff'
import { fetchPeriods } from './availability'
import { pooled, type Board } from './board'
import type { DayTotals } from './meals'
import { DIET_LABELS, listSentence, profileConstraints, type StudentProfile } from './profile'

export type ChangeStatus = 'pending' | 'applying' | 'applied' | 'declined'

export interface DayChange {
  date: string
  locationName: string
  before: Plan
  proposal: PlanProposal
  diff: PlanDiff
}

export interface ScheduleChange {
  instruction: string
  days: DayChange[]
  status: ChangeStatus
  /** Why the last save failed, or which days did not save. */
  error: string | null
}

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
  /** Present on the assistant turn that proposes an edit to the week's plan. */
  change?: ScheduleChange
}

export type AdvisorState = 'idle' | 'thinking' | 'ready' | 'error'

/** Never ask the planner for less than a real meal, however full the day is. */
const MIN_CALORIE_TARGET = 350
const MIN_PROTEIN_TARGET = 15

/** Proposals each run a Gemini call; two at a time keeps a week under rate limits. */
const PROPOSAL_CONCURRENCY = 2

function newId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function assistantMessage(text: string, extra: Partial<AdvisorMessage> = {}): AdvisorMessage {
  return {
    id: newId(),
    role: 'assistant',
    text,
    plan: null,
    locationName: null,
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

/* -------------------------------------------------------- quick prompts */

/**
 * The chips shown before the first question, built from the profile and the
 * day so far: the student's diet, the protein and calories they have left, and
 * — when there is a plan on the week — a prompt that edits it.
 */
export function quickPrompts(
  profile: StudentProfile,
  consumed: DayTotals,
  board: Board | null,
  at = new Date(),
): string[] {
  const hour = at.getHours() + at.getMinutes() / 60
  const meal = hour < 10.5 ? 'breakfast' : hour < 15 ? 'lunch' : 'dinner'
  const proteinLeft = profile.proteinGoal - consumed.protein_g
  const caloriesLeft = profile.calorieGoal - consumed.calories

  const prompts = ['What should I eat now?']
  if (profile.diet !== 'none') prompts.push(`${DIET_LABELS[profile.diet]} ${meal} ideas`)
  prompts.push(
    consumed.meals > 0 && proteinLeft >= 25
      ? `Help me get ${roundTo(proteinLeft, 5)}g more protein`
      : `High protein ${meal}`,
  )
  prompts.push(
    consumed.meals > 0 && caloriesLeft > MIN_CALORIE_TARGET
      ? `A ${meal} under ${roundTo(Math.min(caloriesLeft, 900), 50)} calories`
      : 'Under 600 calories',
  )

  const today = todayISO()
  const planned = board?.days.find((day) => day.plan && day.date >= today)
  if (planned) prompts.push(`Make ${possessiveDay(planned.date, today)} plan higher protein`)

  return [...new Set(prompts)].slice(0, 5)
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step)
}

function possessiveDay(date: string, today: string): string {
  if (date === today) return "today's"
  if (date === addDays(today, 1)) return "tomorrow's"
  return `${weekdayLabel(date, 'long')}'s`
}

/* ------------------------------------------------- schedule-edit intent */

const STRONG_EDIT =
  /\b(change|swap|switch|replace|update|adjust|tweak|edit|remove|drop|redo|rework|rebuild|rearrange|shuffle)\b/
const SOFT_EDIT =
  /\b(make|add|more|less|fewer|lighter|heavier|lower|higher|raise|reduce|increase|cut|without|instead)\b/
const SCHEDULE_WORD = /\b(plans?|schedule|week|weekly|board|planned)\b/
const DAY_WORD = new RegExp(
  [
    /\b(today|tonight|tomorrow|mon(day)?|tues?(day)?|wed(nesday)?|thur?s?(day)?|fri(day)?|sat(urday)?|sun(day)?)\b/.source,
    /\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/.source,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/.source,
    /\bnext \w+ days?\b|\bnext week\b|\bweekends?\b|\bweekdays?\b/.source,
  ].join('|'),
)
const POSSESSIVE_DAY =
  /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)'s\b/

export interface ScheduleTarget {
  /** Planned days the question is about. Empty when it named days the plan lacks. */
  dates: string[]
  periods: PeriodName[]
}

/**
 * Is this question an edit to the week's plan, and to which days?
 *
 * Deliberately conservative: an ordinary "what should I eat tomorrow?" stays a
 * recommendation. It takes an edit verb plus either a word about the plan or a
 * named day — and a soft verb ("make", "more") with a bare day only counts in
 * the possessive, "make tomorrow's lighter".
 */
export function scheduleTarget(
  text: string,
  board: Board | null,
  today = todayISO(),
): ScheduleTarget | null {
  if (!board || !board.days.some((day) => day.plan)) return null

  const lower = text
    .toLowerCase()
    .replace(/’/g, "'")
    // "sat fat" is a nutrient, not Saturday.
    .replace(/\bsat(urated|\.)?\s+fat\b/g, 'saturated-fat')

  const namedDays = DAY_WORD.test(lower)
  const aboutSchedule = SCHEDULE_WORD.test(lower)
  const strong = STRONG_EDIT.test(lower)
  const soft = SOFT_EDIT.test(lower)
  const isEdit =
    (aboutSchedule && (strong || soft)) ||
    (namedDays && (strong || (soft && POSSESSIVE_DAY.test(lower))))
  if (!isEdit) return null

  const spec = interpret(lower, [], { today })
  const planned = board.days.filter((day) => day.plan).map((day) => day.date)
  const dates = namedDays ? planned.filter((date) => spec.dates.includes(date)) : planned

  // A day that is not on the plan is an ordinary question, unless the student
  // clearly meant the plan — then saying so beats recommending something else.
  if (dates.length === 0 && !aboutSchedule) return null
  return { dates, periods: spec.periods }
}

function changeInstruction(text: string, periods: PeriodName[], profile: StudentProfile): string {
  const scope = periods.length
    ? `Only change the ${listSentence(periods.map((period) => period.toLowerCase()))} for this day and keep every other meal exactly as it is.`
    : 'Keep anything the request does not touch exactly as it is.'
  return [text.slice(0, 1500), scope, ...profileConstraints(profile)].join(' ')
}

function dayList(dates: string[]): string {
  return listSentence(
    dates.map((date) => {
      const label = friendlyDate(date)
      return label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : label
    }),
  )
}

/* --------------------------------------------------------- recommendations */

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
  /** The week's plan, which a question may ask to change. */
  board: Board | null
}

export interface AdvisorStore {
  messages: AdvisorMessage[]
  state: AdvisorState
  /** The most recent recommendation, or null before the first answer. */
  latest: AdvisorMessage | null
  ask: (question: string, context: AskContext) => Promise<void>
  alternatives: (message: AdvisorMessage) => Promise<void>
  /** Save a proposed schedule change; `onApplied` receives the saved plans. */
  confirmChange: (messageId: string, onApplied: (plans: Plan[]) => void) => Promise<void>
  declineChange: (messageId: string) => void
  reset: () => void
}

export function useAdvisor(): AdvisorStore {
  const [messages, setMessages] = useState<AdvisorMessage[]>([])
  const [state, setState] = useState<AdvisorState>('idle')
  const busy = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const push = useCallback((message: AdvisorMessage) => {
    setMessages((current) => [...current, message])
  }, [])

  const patchChange = useCallback((messageId: string, patch: Partial<ScheduleChange>) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId && message.change
          ? { ...message, change: { ...message.change, ...patch } }
          : message,
      ),
    )
  }, [])

  /** Propose edits to the planned days a question is about. Saves nothing. */
  const proposeChange = useCallback(
    async (text: string, target: ScheduleTarget, board: Board, profile: StudentProfile) => {
      const days = board.days.filter((day) => day.plan && target.dates.includes(day.date))
      if (days.length === 0) {
        push(
          assistantMessage(
            `That day is not on your plan — it covers ${describeRange(board.days.map((day) => day.date))}. ` +
              'Plan it under My Meals → This Week first, or ask about a day that is on it.',
            { error: true, locationName: board.locationName },
          ),
        )
        setState('error')
        return
      }

      const instruction = changeInstruction(text, target.periods, profile)
      const changes: DayChange[] = []
      const failures: Array<{ date: string; error: unknown }> = []

      await pooled(days, PROPOSAL_CONCURRENCY, async (day) => {
        const before = day.plan!
        try {
          const proposal = await api.proposeRefinement(before.id, instruction)
          const diff = diffPlan(before.content, proposal.content)
          if (diff.changed) {
            changes.push({ date: day.date, locationName: board.locationName, before, proposal, diff })
          }
        } catch (error) {
          failures.push({ date: day.date, error })
        }
      })
      changes.sort((a, b) => a.date.localeCompare(b.date))

      if (changes.length === 0) {
        push(
          failures.length
            ? assistantMessage(describeError(failures[0].error, board.locationName), {
                error: true,
                locationName: board.locationName,
              })
            : assistantMessage(
                `Your plan for ${dayList(days.map((day) => day.date))} already fits that — I would not change anything.`,
                { locationName: board.locationName },
              ),
        )
        setState(failures.length ? 'error' : 'ready')
        return
      }

      const skipped = failures.length
        ? ` I could not rework ${dayList(failures.map((entry) => entry.date))}, so ${failures.length === 1 ? 'it stays' : 'they stay'} as planned.`
        : ''
      push(
        assistantMessage(
          `Here's what I'd change for ${dayList(changes.map((change) => change.date))}. ` +
            `Nothing on your schedule moves until you confirm.${skipped}`,
          {
            locationName: board.locationName,
            change: { instruction, days: changes, status: 'pending', error: null },
          },
        ),
      )
      setState('ready')
    },
    [push],
  )

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

      const { profile, consumed, locations, fallbackLocationId, board } = context

      const target = scheduleTarget(text, board)
      if (target && board) {
        try {
          await proposeChange(text, target, board, profile)
        } finally {
          busy.current = false
        }
        return
      }

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
    [push, proposeChange],
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

  const confirmChange = useCallback(
    async (messageId: string, onApplied: (plans: Plan[]) => void) => {
      const change = messagesRef.current.find((message) => message.id === messageId)?.change
      if (!change || change.status !== 'pending' || busy.current) return
      busy.current = true
      patchChange(messageId, { status: 'applying', error: null })

      const saved: Plan[] = []
      const failed: Array<{ date: string; error: unknown }> = []
      try {
        await pooled(change.days, PROPOSAL_CONCURRENCY, async (day) => {
          try {
            saved.push(await api.applyProposal(day.proposal))
          } catch (error) {
            failed.push({ date: day.date, error })
          }
        })
        if (saved.length) onApplied(saved)

        if (failed.length === 0) {
          patchChange(messageId, { status: 'applied', error: null })
        } else if (saved.length === 0) {
          // Nothing saved, so the student can try again from the same card.
          patchChange(messageId, { status: 'pending', error: describeError(failed[0].error, null) })
        } else {
          patchChange(messageId, {
            status: 'applied',
            error: `${dayList(failed.map((entry) => entry.date))} did not save — ${describeError(failed[0].error, null)}`,
          })
        }
      } finally {
        busy.current = false
      }
    },
    [patchChange],
  )

  const declineChange = useCallback(
    (messageId: string) => {
      const change = messagesRef.current.find((message) => message.id === messageId)?.change
      if (change?.status !== 'pending') return
      patchChange(messageId, { status: 'declined', error: null })
    },
    [patchChange],
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
    () => ({ messages, state, latest, ask, alternatives, confirmChange, declineChange, reset }),
    [messages, state, latest, ask, alternatives, confirmChange, declineChange, reset],
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
      return 'Changing a plan needs a Gemini key on the backend. Plans still work — set GEMINI_API_KEY to talk them into shape.'
    }
    return error.message
  }
  return 'Something went wrong while building that. Try again.'
}
