/**
 * What a chat message is asking for: a meal recommendation, a look at saved
 * plans, or a change to them.
 *
 * Verbs that only ever mean an edit ("remove the fries", "swap lunch",
 * "refine it") are edits wherever they appear. Softer ones ("make it lighter",
 * "less carbs") are edits only when there is something on screen or on the
 * week to edit — and never when the message is plainly asking for a new
 * suggestion ("something with more protein"). Turning an edit into actual
 * plans is the Advisor's job; it knows the board, the server, and which plans
 * the conversation is about.
 */

import { todayISO } from './dates'
import { interpret, type PeriodName } from './parse'

export type Intent =
  | { kind: 'recommend' }
  | { kind: 'retrieve'; dates: string[] | null; periods: PeriodName[] }
  | {
      kind: 'edit'
      dates: string[] | null
      periods: PeriodName[]
      /** About the plans the conversation is already showing. */
      followUp: boolean
      /** "my week", "all my plans": every planned day, not just one. */
      wholeSchedule: boolean
    }

const STRONG_EDIT = new RegExp(
  [
    /\b(change|swap|switch|replace|update|adjust|tweak|edit|remove|delete|drop|redo|rework|rebuild|rearrange|shuffle|refine|exclude|skip)\b/.source,
    /\btake (it |them |that |this )?(out|off)\b|\bget rid of\b|\bcut out\b|\bno more\b|\binstead of\b/.source,
    /\b(don't|dont|do not) want\b/.source,
  ].join('|'),
)
const SOFT_EDIT =
  /\b(make|add|more|less|fewer|lighter|heavier|lower|higher|raise|reduce|increase|cut|without|instead|healthier|bigger|smaller)\b/
/** Wording that asks for a new suggestion rather than a change. */
const RECOMMEND_CUE =
  /\b(something|anything|ideas?|options?|recommend|suggest|help me (get|find|hit)|where (can|should) i)\b|\bwhat (should|could|can) i (eat|get|have)\b/
const SCHEDULE_WORD = /\b(plans?|schedule|week|weekly|board|planned)\b/
const WHOLE_SCHEDULE = /\b(week|weekly|plans|schedule|all|every|each|whole)\b/
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
// "this"/"that" only as a pronoun, not "this week" or "that morning".
const PRONOUN =
  /\b(it|them|these|those)\b|\b(this|that)\b(?!\s+(week|weekend|morning|afternoon|evening|month|day|time))/
const RETRIEVE_VERB =
  /\b(show|see|view|list|open|display|pull up|bring up|find|get|remind me|check|look at|what's|whats|what is|what are|which)\b/
const MY_PLANS = /\bmy (meal )?(plans?|schedule|week)\b/
const EATING_QUESTION = /\bwhat (am i|do i|will i|i'm)\s+(eating|having|getting)\b/

function normalise(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      // "sat fat" is a nutrient, not Saturday.
      .replace(/\bsat(urated|\.)?\s+fat\b/g, 'saturated-fat')
  )
}

export function readIntent(
  text: string,
  options: {
    /** The conversation is already showing plans (a recommendation, a digest, a change). */
    hasFocus: boolean
    /** The week board has at least one plan. */
    hasPlans?: boolean
    today?: string
  },
): Intent {
  const today = options.today ?? todayISO()
  const lower = normalise(text)

  const namedDays = DAY_WORD.test(lower)
  const aboutSchedule = SCHEDULE_WORD.test(lower)
  const asksForSuggestion = RECOMMEND_CUE.test(lower)
  const strong = STRONG_EDIT.test(lower) && !/\b(recommend|suggest)\b|\bwhat should i\b/.test(lower)
  const soft = SOFT_EDIT.test(lower) && !asksForSuggestion
  const pointsBack = options.hasFocus && PRONOUN.test(lower)

  const spec = interpret(lower, [], { today })
  const periods = spec.periods
  const hasSomethingToEdit = options.hasFocus || Boolean(options.hasPlans)

  const isEdit =
    strong ||
    (aboutSchedule && soft) ||
    (namedDays && soft && POSSESSIVE_DAY.test(lower)) ||
    (options.hasFocus && soft) ||
    (hasSomethingToEdit && soft && (pointsBack || periods.length > 0))
  if (isEdit) {
    return {
      kind: 'edit',
      dates: namedDays ? spec.dates : null,
      periods,
      followUp: options.hasFocus && !namedDays && !aboutSchedule,
      wholeSchedule: WHOLE_SCHEDULE.test(lower),
    }
  }

  const eating = EATING_QUESTION.test(lower)
  const isRetrieve =
    (aboutSchedule && (RETRIEVE_VERB.test(lower) || MY_PLANS.test(lower))) || eating
  if (isRetrieve) {
    return {
      kind: 'retrieve',
      dates: namedDays ? spec.dates : eating ? [today] : null,
      periods,
    }
  }

  return { kind: 'recommend' }
}
