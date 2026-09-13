/**
 * The Advisor: the chat that recommends meals and manages saved plans.
 *
 * Every message is read for intent (`lib/intent.ts`):
 *
 * - **recommend** — one real meal off the live menu. `POST /plans/generate` is
 *   scoped to a single meal period, `targets` are what is left of the day's
 *   goals, and the question plus diet, allergy and intake sentences ride along
 *   as `constraints`. The backend also reads the saved profile.
 * - **retrieve** — "show my plans", "what am I eating tomorrow". Plans come
 *   from the week board first, then from the server (`GET /plans`).
 * - **edit** — "swap Tuesday's dinner", or "make it lighter" about the plans
 *   the conversation just showed. Proposed, shown as a diff, and saved only on
 *   confirm — see `state/changes.ts`. "See alternatives" takes the same path.
 *
 * The plans a conversation is about are kept as its *focus*, so follow-ups
 * that say "it" or "them" edit the right thing.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Location, NutritionTargets, Plan } from '../api/types'
import { addDays, describeRange, todayISO, weekdayLabel } from '../lib/dates'
import { readIntent, type Intent } from '../lib/intent'
import { matchLocation, type PeriodName } from '../lib/parse'
import { fetchPeriods } from './availability'
import type { Board } from './board'
import {
  applyChanges,
  dayList,
  describeChangeError,
  proposeChanges,
  settleChange,
  type ChangeKind,
  type ChangeTarget,
  type ScheduleChange,
} from './changes'
import type { DayTotals } from './meals'
import { DIET_LABELS, listSentence, profileConstraints, type StudentProfile } from './profile'

/** Saved plans shown in the chat, optionally narrowed to some meal periods. */
export interface PlanDigest {
  plans: ChangeTarget[]
  periods: PeriodName[]
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
  /** Saved plans the student asked to see. */
  digest?: PlanDigest
  /** A proposed edit awaiting the student's confirmation. */
  change?: ScheduleChange
}

export type AdvisorState = 'idle' | 'thinking' | 'ready' | 'error'

/** Never ask the planner for less than a real meal, however full the day is. */
const MIN_CALORIE_TARGET = 350
const MIN_PROTEIN_TARGET = 15

const ALTERNATIVES_INSTRUCTION =
  'Suggest a different meal for this period using other items on the same menu. ' +
  'Keep it close to the same calories and protein.'

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
 * day so far: the student's diet, the protein and calories they have left,
 * their saved plans, and — when the week has a plan — a prompt that edits it.
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

  const prompts = ['What should I eat now?', 'Show my plans']
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

  return [...new Set(prompts)].slice(0, 6)
}

function roundTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step)
}

function possessiveDay(date: string, today: string): string {
  if (date === today) return "today's"
  if (date === addDays(today, 1)) return "tomorrow's"
  return `${weekdayLabel(date, 'long')}'s`
}

/* ---------------------------------------------------------- finding plans */

function boardPlans(board: Board | null): ChangeTarget[] {
  if (!board) return []
  return board.days
    .filter((day) => day.plan)
    .map((day) => ({ date: day.date, locationName: board.locationName, plan: day.plan! }))
}

/**
 * The week-plan days a message is about: the named days, or the days from
 * today on (all of them when the week is in the past).
 *
 * Only the week plan counts. Advisor recommendations are saved plans too, but
 * "what is my plan for today?" must never answer with one of those — the
 * board is restored from the server (`GET /plans/week`), so it is the
 * student's actual plan wherever they sign in.
 */
function findPlans(dates: string[] | null, board: Board | null, today: string): ChangeTarget[] {
  const onBoard = boardPlans(board)
  if (dates) return onBoard.filter((entry) => dates.includes(entry.date))
  const ahead = onBoard.filter((entry) => entry.date >= today)
  return ahead.length ? ahead : onBoard
}

/** What to say when a message is about a week plan that has no such days. */
function noWeekPlanText(dates: string[] | null, board: Board | null): string {
  const planned = boardPlans(board)
  if (planned.length === 0) {
    return "You don't have a week plan yet. Build one under My Meals → This Week and I can show it or change it here — or ask me what to eat now."
  }
  return `Your week plan doesn't cover ${dates ? dayList(dates) : 'that'} — it runs ${describeRange(planned.map((entry) => entry.date))}.`
}

/** Words in a message that could name a food, rather than the request around it. */
const NOT_FOOD = new Set([
  'remove', 'delete', 'drop', 'swap', 'switch', 'replace', 'change', 'update', 'adjust', 'tweak',
  'edit', 'refine', 'redo', 'rework', 'exclude', 'skip', 'take', 'out', 'off', 'get', 'rid', 'cut',
  'want', 'dont', "don't", 'not', 'more', 'less', 'fewer', 'make', 'add', 'instead', 'without',
  'lighter', 'heavier', 'higher', 'lower', 'healthier', 'bigger', 'smaller', 'with', 'from', 'for',
  'the', 'and', 'please', 'can', 'you', 'could', 'would', 'some', 'something', 'anything', 'that',
  'this', 'them', 'these', 'those', 'its', 'my', 'mine', 'your', 'into', 'have', 'our', 'plan',
  'plans', 'meal', 'meals', 'breakfast', 'brunch', 'lunch', 'dinner', 'snack', 'today', 'tonight',
  'tomorrow', 'week', 'day', 'days', 'option', 'protein', 'calories', 'carbs', 'fat', 'fiber',
  'sodium', 'sugar', 'vegetarian', 'vegan', 'one', 'item', 'items', 'thing', 'things', 'all',
])

function foodWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !NOT_FOOD.has(word))
    .map((word) => word.replace(/s$/, ''))
}

/** Plans holding an item the message names — "remove the fries" edits the day with fries. */
export function plansMentioning(text: string, candidates: ChangeTarget[]): ChangeTarget[] {
  const wanted = [...new Set(foodWords(text))]
  if (wanted.length === 0) return []
  return candidates.filter((entry) =>
    entry.plan.content.meals.some((meal) =>
      meal.items.some((item) => {
        const words = foodWords(item.name ?? '')
        return wanted.some((word) =>
          words.some((name) => name === word || (word.length >= 4 && name.startsWith(word))),
        )
      }),
    ),
  )
}

function uniquePlans(entries: ChangeTarget[]): ChangeTarget[] {
  const seen = new Set<string>()
  return entries.filter((entry) => !seen.has(entry.plan.id) && seen.add(entry.plan.id))
}

function changeInstruction(text: string, periods: PeriodName[], profile: StudentProfile): string {
  const scope = periods.length
    ? `Only change the ${listSentence(periods.map((period) => period.toLowerCase()))} for this day and keep every other meal exactly as it is.`
    : 'Keep anything the request does not touch exactly as it is.'
  return [text.slice(0, 1500), scope, ...profileConstraints(profile)].join(' ')
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
  /** The week's plan, which a question may ask to see or change. */
  board: Board | null
}

export interface AdvisorStore {
  messages: AdvisorMessage[]
  state: AdvisorState
  /** The most recent recommendation, or null before the first answer. */
  latest: AdvisorMessage | null
  ask: (question: string, context: AskContext) => Promise<void>
  alternatives: (message: AdvisorMessage) => Promise<void>
  /** Save a proposed change; `onApplied` receives the saved plans. */
  confirmChange: (messageId: string, onApplied: (plans: Plan[]) => void) => Promise<void>
  declineChange: (messageId: string) => void
  reset: () => void
}

export function useAdvisor(): AdvisorStore {
  const [messages, setMessages] = useState<AdvisorMessage[]>([])
  const [state, setState] = useState<AdvisorState>('idle')
  const busy = useRef(false)
  const focus = useRef<ChangeTarget[]>([])
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

  /** Propose an edit to `targets` and post it as a card awaiting confirmation. */
  const offerChange = useCallback(
    async (targets: ChangeTarget[], instruction: string, kind: ChangeKind) => {
      const outcome = await proposeChanges(targets, instruction)
      focus.current = targets

      if (outcome.changes.length === 0) {
        if (outcome.failures.length) {
          push(assistantMessage(describeChangeError(outcome.failures[0].error), { error: true }))
          setState('error')
        } else if (kind === 'meal') {
          push(
            assistantMessage(
              `I could not find another combination at ${targets[0]?.locationName ?? 'that hall'} that still fits. The one above is your best option on this menu.`,
            ),
          )
          setState('ready')
        } else {
          push(
            assistantMessage(
              `Your plan for ${dayList(targets.map((target) => target.date))} already fits that — I would not change anything.`,
            ),
          )
          setState('ready')
        }
        return
      }

      const skipped = outcome.failures.length
        ? ` I could not rework ${dayList(outcome.failures.map((entry) => entry.date))}, so ${outcome.failures.length === 1 ? 'it stays' : 'they stay'} as planned.`
        : ''
      const lead =
        kind === 'meal'
          ? `Here's another option at ${outcome.changes[0].locationName}. Swap it in?`
          : `Here's what I'd change for ${dayList(outcome.changes.map((change) => change.date))}. Nothing is saved until you confirm.`
      push(
        assistantMessage(`${lead}${skipped}`, {
          locationName: outcome.changes[0].locationName,
          change: { kind, instruction, days: outcome.changes, status: 'pending', error: null },
        }),
      )
      setState('ready')
    },
    [push],
  )

  const showPlans = useCallback(
    async (intent: Extract<Intent, { kind: 'retrieve' }>, context: AskContext) => {
      const found = findPlans(intent.dates, context.board, todayISO())
      if (found.length === 0) {
        push(assistantMessage(noWeekPlanText(intent.dates, context.board)))
        setState('ready')
        return
      }

      focus.current = found
      const days = dayList(found.map((entry) => entry.date))
      push(
        assistantMessage(
          found.length === 1
            ? `Here's your plan for ${days}. Tell me what to change and I'll show you the difference first.`
            : `Here are your plans for ${days}. Ask me to change any of them — nothing is saved until you confirm.`,
          { digest: { plans: found, periods: intent.periods } },
        ),
      )
      setState('ready')
    },
    [push],
  )

  const changePlans = useCallback(
    async (text: string, intent: Extract<Intent, { kind: 'edit' }>, context: AskContext) => {
      const today = todayISO()
      const candidates =
        intent.followUp && focus.current.length
          ? focus.current
          : findPlans(intent.dates, context.board, today)

      // Narrow to what the message is about: the plan holding a named food
      // (looking past the focus to the week if needed), otherwise one day
      // rather than a whole week the student did not ask to change.
      const pool = intent.followUp ? uniquePlans([...candidates, ...boardPlans(context.board)]) : candidates
      const mentioned = plansMentioning(text, pool)
      let targets = candidates
      if (mentioned.length) {
        targets = mentioned
      } else if (!intent.dates && !intent.wholeSchedule && candidates.length > 1) {
        targets = [candidates.find((entry) => entry.date === today) ?? candidates[0]]
      }

      if (targets.length === 0) {
        push(assistantMessage(noWeekPlanText(intent.dates, context.board), { error: true }))
        setState('error')
        return
      }

      await offerChange(targets, changeInstruction(text, intent.periods, context.profile), 'schedule')
    },
    [push, offerChange],
  )

  const recommend = useCallback(
    async (text: string, context: AskContext) => {
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
        push(
          assistantMessage('I could not reach the campus dining list just now. Try again in a moment.', {
            error: true,
          }),
        )
        setState('error')
        return
      }

      const date = todayISO()

      try {
        // Fresh: the chosen id is sent to /plans/generate, and upstream reissues them.
        const periods = await fetchPeriods(location.id, date, { fresh: true })
        if (periods.length === 0) {
          push(
            assistantMessage(
              `${location.name} has not published a menu for today. Try another hall from the Dining tab.`,
              { locationName: location.name, error: true },
            ),
          )
          setState('error')
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
          push(
            assistantMessage(nothingFits(plan, location.name, period?.name ?? null), {
              locationName: location.name,
              error: true,
            }),
          )
          setState('error')
          return
        }

        focus.current = [{ date, locationName: location.name, plan }]
        push(
          assistantMessage(answerText(plan, location.name), {
            plan,
            locationName: location.name,
          }),
        )
        setState('ready')
      } catch (error) {
        push(assistantMessage(describeError(error, location.name), { locationName: location.name, error: true }))
        setState('error')
      }
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

      try {
        const intent = readIntent(text, {
          hasFocus: focus.current.length > 0,
          hasPlans: boardPlans(context.board).length > 0,
        })
        if (intent.kind === 'retrieve') await showPlans(intent, context)
        else if (intent.kind === 'edit') await changePlans(text, intent, context)
        else await recommend(text, context)
      } catch (error) {
        push(assistantMessage(describeChangeError(error), { error: true }))
        setState('error')
      } finally {
        busy.current = false
      }
    },
    [push, showPlans, changePlans, recommend],
  )

  /** Another combination for a recommendation, offered as a swap to confirm. */
  const alternatives = useCallback(
    async (message: AdvisorMessage) => {
      if (!message.plan || busy.current) return
      busy.current = true
      setState('thinking')
      try {
        const target: ChangeTarget = {
          date: message.plan.plan_date,
          locationName: message.locationName ?? message.plan.sources.location_name ?? 'this hall',
          plan: message.plan,
        }
        await offerChange([target], ALTERNATIVES_INSTRUCTION, 'meal')
      } finally {
        busy.current = false
      }
    },
    [offerChange],
  )

  const confirmChange = useCallback(
    async (messageId: string, onApplied: (plans: Plan[]) => void) => {
      const change = messagesRef.current.find((message) => message.id === messageId)?.change
      if (!change || change.status !== 'pending' || busy.current) return
      busy.current = true
      patchChange(messageId, { status: 'applying', error: null })

      try {
        const outcome = await applyChanges(change.days)
        if (outcome.saved.length) {
          onApplied(outcome.saved)
          const saved = new Map(outcome.saved.map((plan) => [plan.id, plan]))
          const fresh = (entry: ChangeTarget): ChangeTarget =>
            saved.has(entry.plan.id) ? { ...entry, plan: saved.get(entry.plan.id)! } : entry

          // Every card in the thread that shows one of these plans now shows
          // the saved version, so the conversation never contradicts itself.
          setMessages((current) =>
            current.map((message) => {
              let next = message
              if (message.plan && saved.has(message.plan.id)) {
                const plan = saved.get(message.plan.id)!
                next = { ...next, plan, text: answerText(plan, message.locationName ?? 'this hall') }
              }
              if (message.digest) {
                next = { ...next, digest: { ...message.digest, plans: message.digest.plans.map(fresh) } }
              }
              return next
            }),
          )
          focus.current = focus.current.map(fresh)
        }
        patchChange(messageId, settleChange(outcome))
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
    focus.current = []
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
  if (error instanceof ApiError && error.status === 404) {
    return `${locationName ?? 'That hall'} has not published a menu for this meal yet. Try the Dining tab for somewhere that is open.`
  }
  return describeChangeError(error)
}
