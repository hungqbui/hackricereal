/**
 * Propose → review → confirm for one surface outside the chat — the This Week
 * day panel. The chat keeps a change per message instead; both share
 * `state/changes.ts`, so they behave identically.
 */

import { useCallback, useRef, useState } from 'react'

import type { Plan } from '../api/types'
import {
  applyChanges,
  dayList,
  describeChangeError,
  proposeChanges,
  settleChange,
  type ChangeTarget,
  type ScheduleChange,
} from './changes'

export interface PlanReview {
  /** The change on screen, in whatever state it has reached. */
  change: ScheduleChange | null
  proposing: boolean
  /** Why a proposal produced nothing to review. */
  notice: string | null
  /** Resolves true when there is a change to review. */
  propose: (targets: ChangeTarget[], instruction: string) => Promise<boolean>
  confirm: () => Promise<void>
  decline: () => void
}

export function usePlanReview(onApplied: (plans: Plan[]) => void): PlanReview {
  const [change, setChange] = useState<ScheduleChange | null>(null)
  const [proposing, setProposing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const busy = useRef(false)
  const changeRef = useRef(change)
  changeRef.current = change

  const propose = useCallback(async (targets: ChangeTarget[], instruction: string) => {
    if (busy.current || targets.length === 0) return false
    busy.current = true
    setProposing(true)
    setNotice(null)
    setChange(null)
    try {
      const outcome = await proposeChanges(targets, instruction)
      if (outcome.changes.length === 0) {
        setNotice(
          outcome.failures.length
            ? describeChangeError(outcome.failures[0].error)
            : 'That already fits — the planner would not change anything.',
        )
        return false
      }
      setChange({
        kind: 'schedule',
        instruction,
        days: outcome.changes,
        status: 'pending',
        error: outcome.failures.length
          ? `${dayList(outcome.failures.map((entry) => entry.date))} could not be reworked and will stay as planned.`
          : null,
      })
      return true
    } finally {
      busy.current = false
      setProposing(false)
    }
  }, [])

  const confirm = useCallback(async () => {
    const current = changeRef.current
    if (!current || current.status !== 'pending' || busy.current) return
    busy.current = true
    setChange({ ...current, status: 'applying', error: null })
    try {
      const outcome = await applyChanges(current.days)
      if (outcome.saved.length) onApplied(outcome.saved)
      setChange((latest) => (latest ? { ...latest, ...settleChange(outcome) } : latest))
    } finally {
      busy.current = false
    }
  }, [onApplied])

  const decline = useCallback(() => {
    setChange((current) =>
      current && current.status === 'pending' ? { ...current, status: 'declined', error: null } : current,
    )
  }, [])

  return { change, proposing, notice, propose, confirm, decline }
}
