/**
 * Reviewable plan changes — the one path every refinement takes.
 *
 * A change is proposed with `POST /plans/{id}/propose` (nothing saved), shown
 * to the student as a diff, and saved with `POST /plans/{id}/apply` only after
 * they confirm. The Advisor chat, the This Week day panel and "See
 * alternatives" all go through here, so no surface can rewrite a plan without
 * that review.
 */

import { ApiError, api } from '../api/client'
import type { Plan, PlanProposal } from '../api/types'
import { friendlyDate } from '../lib/dates'
import { diffPlan, type PlanDiff } from '../lib/planDiff'
import { pooled } from './board'
import { listSentence } from './profile'

export type ChangeStatus = 'pending' | 'applying' | 'applied' | 'declined'

/** `meal` is a swap on a single recommendation; `schedule` edits saved plans. */
export type ChangeKind = 'schedule' | 'meal'

/** A saved plan and where it is served, as the chat and the board both know it. */
export interface ChangeTarget {
  date: string
  locationName: string
  plan: Plan
}

export interface DayChange {
  date: string
  locationName: string
  before: Plan
  proposal: PlanProposal
  diff: PlanDiff
}

export interface ScheduleChange {
  kind: ChangeKind
  instruction: string
  days: DayChange[]
  status: ChangeStatus
  /** Why the last save failed, or which days could not be reworked. */
  error: string | null
}

/** Each proposal is a Gemini call; two at a time keeps a week under rate limits. */
const CONCURRENCY = 2

export interface ProposalOutcome {
  changes: DayChange[]
  unchanged: ChangeTarget[]
  failures: Array<{ date: string; error: unknown }>
}

export async function proposeChanges(
  targets: ChangeTarget[],
  instruction: string,
): Promise<ProposalOutcome> {
  const changes: DayChange[] = []
  const unchanged: ChangeTarget[] = []
  const failures: ProposalOutcome['failures'] = []

  await pooled(targets, CONCURRENCY, async (target) => {
    try {
      const proposal = await api.proposeRefinement(target.plan.id, instruction)
      const diff = diffPlan(target.plan.content, proposal.content)
      if (diff.changed) {
        changes.push({
          date: target.date,
          locationName: target.locationName,
          before: target.plan,
          proposal,
          diff,
        })
      } else {
        unchanged.push(target)
      }
    } catch (error) {
      failures.push({ date: target.date, error })
    }
  })

  changes.sort((a, b) => a.date.localeCompare(b.date))
  return { changes, unchanged, failures }
}

export interface ApplyOutcome {
  saved: Plan[]
  failures: Array<{ date: string; error: unknown }>
}

export async function applyChanges(days: DayChange[]): Promise<ApplyOutcome> {
  const saved: Plan[] = []
  const failures: ApplyOutcome['failures'] = []
  await pooled(days, CONCURRENCY, async (day) => {
    try {
      saved.push(await api.applyProposal(day.proposal))
    } catch (error) {
      failures.push({ date: day.date, error })
    }
  })
  return { saved, failures }
}

/** Where a change card lands after an apply attempt. */
export function settleChange(outcome: ApplyOutcome): Pick<ScheduleChange, 'status' | 'error'> {
  if (outcome.failures.length === 0) return { status: 'applied', error: null }
  const reason = describeChangeError(outcome.failures[0].error)
  // Nothing saved, so the same card can be confirmed again.
  if (outcome.saved.length === 0) return { status: 'pending', error: reason }
  return {
    status: 'applied',
    error: `${dayList(outcome.failures.map((entry) => entry.date))} did not save — ${reason}`,
  }
}

/** The sentence a student sees when proposing or saving fails. */
export function describeChangeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return 'Changing a plan needs Gemini, and the backend has no GEMINI_API_KEY set.'
    }
    // Gemini's own "high demand" 503 arrives wrapped in the backend's 502.
    if (/UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|\b429\b/i.test(error.message)) {
      return 'Gemini is busy right now. Give it a moment and try again.'
    }
    if (error.status === 404) return 'That plan, or the menu it came from, is no longer available.'
    return error.message
  }
  return 'Something went wrong. Try again.'
}

/** "today, Tue Sep 15 and Wed Sep 16". */
export function dayList(dates: string[]): string {
  return listSentence(
    dates.map((date) => {
      const label = friendlyDate(date)
      return label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : label
    }),
  )
}
