/**
 * A proposed edit to the week's plan, shown as a diff the student confirms.
 *
 * The motion carries the meaning. Removed items are struck through, added ones
 * slide in, and each day's totals count from the old number to the new one, so
 * the size of the change reads before any text does. Confirming collapses the
 * struck rows away and settles the card; keeping the plan runs the diff
 * backwards and folds it shut. Nothing is saved before the student confirms —
 * see `state/changes.ts`, which the chat, the day panel and "See alternatives"
 * all share.
 *
 * A card that mounts already settled (the student left the tab and came back)
 * is drawn in its final state rather than replayed.
 */

import { useRef, type MouseEvent, type ReactNode } from 'react'

import { friendlyDate } from '../lib/dates'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import type { ItemChange, MacroShift, MealChange } from '../lib/planDiff'
import type { DayChange, ScheduleChange } from '../state/changes'
import {
  IconCalendar,
  IconCalories,
  IconCheck,
  IconPin,
  IconProtein,
  IconWarn,
  periodIcon,
  type IconProps,
} from './icons'

/* Washes are the sage accent at three strengths; GSAP needs literal colours
   to interpolate, so these mirror --sage rather than reading the variable. */
const WASH_STRONG = 'rgba(123, 170, 100, 0.3)'
const WASH_SOFT = 'rgba(123, 170, 100, 0.1)'
const WASH_NONE = 'rgba(123, 170, 100, 0)'

type Unit = 'kcal' | 'g'

const FORMAT: Record<Unit, (value: number) => string> = {
  kcal: (value) => Math.round(value).toLocaleString(),
  g: (value) => `${Math.round(value)}g`,
}

const MARK: Record<ItemChange['kind'], string> = {
  added: '+',
  removed: '−',
  servings: '↻',
  kept: '',
}

const KIND_LABEL: Record<ItemChange['kind'], string> = {
  added: 'Added',
  removed: 'Removed',
  servings: 'Portion changed',
  kept: 'Unchanged',
}

export function ScheduleChangeCard({
  change,
  onConfirm,
  onDecline,
}: {
  change: ScheduleChange
  onConfirm: () => void
  onDecline: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const { status } = change
  const mountedStatus = useRef(status)
  const lastStatus = useRef(status)
  const settledOnMount = mountedStatus.current === 'applied' || mountedStatus.current === 'declined'

  const pick = (selector: string) => gsap.utils.toArray<HTMLElement>(selector, root.current)

  /** Count every day's totals between two ends of the diff, on a timeline. */
  const countTotals = (tl: gsap.core.Timeline, direction: 'forward' | 'back', at: string | number) => {
    for (const node of pick('[data-count]')) {
      const format = FORMAT[(node.dataset.unit as Unit) ?? 'kcal']
      const before = Number(node.dataset.from)
      const after = Number(node.dataset.to)
      const [from, to] = direction === 'forward' ? [before, after] : [after, before]
      const proxy = { value: from }
      tl.call(() => { node.textContent = format(from) }, [], direction === 'forward' ? 0 : at)
      tl.to(
        proxy,
        {
          value: to,
          duration: DUR.slow,
          ease: EASE.meter,
          onUpdate: () => { node.textContent = format(proxy.value) },
        },
        at,
      )
    }
  }

  // Arrival: deal the days in, then play the diff itself.
  const { contextSafe } = useGSAP(
    () => {
      if (settledOnMount) return
      const tl = gsap.timeline({ defaults: { ease: EASE.out } })
      tl.from(root.current, { y: 18, opacity: 0, scale: 0.98, duration: DUR.base })
        .from(pick('[data-change-day]'), { y: 12, opacity: 0, duration: DUR.base, stagger: STAGGER.each }, '-=0.2')
        .addLabel('diff')
        .to(pick('.change-item.removed .change-strike'), {
          scaleX: 1,
          duration: DUR.base,
          ease: 'power2.inOut',
          stagger: 0.05,
        }, 'diff')
        .to(pick('.change-item.removed'), { opacity: 0.55, duration: DUR.base, stagger: 0.05 }, 'diff+=0.15')
        .from(pick('.change-item.added'), {
          x: 16,
          opacity: 0,
          duration: DUR.base,
          ease: EASE.pop,
          stagger: 0.06,
        }, 'diff+=0.25')
        .fromTo(
          pick('.change-item.added, .change-item.servings'),
          { backgroundColor: WASH_STRONG },
          { backgroundColor: WASH_SOFT, duration: DUR.slow * 1.5 },
          'diff+=0.35',
        )
        .from(pick('.change-servings'), {
          scale: 0.6,
          opacity: 0,
          duration: DUR.base,
          ease: EASE.pop,
          stagger: 0.05,
        }, 'diff+=0.3')
        .addLabel('totals', 'diff+=0.35')
      countTotals(tl, 'forward', 'totals')
      tl.from(pick('.change-delta'), {
        scale: 0.4,
        opacity: 0,
        duration: DUR.base,
        ease: EASE.pop,
        stagger: 0.05,
      }, 'totals+=0.35')
        .from(pick('.change-actions > *'), { y: 8, opacity: 0, duration: DUR.fast, stagger: 0.06 }, '-=0.25')
    },
    { scope: root },
  )

  // Transitions the student caused: confirm, keep, or a failed save.
  useGSAP(
    () => {
      const previous = lastStatus.current
      lastStatus.current = status
      if (previous === status) return

      if (status === 'applied') {
        const tl = gsap.timeline()
        tl.to(pick('.change-item.removed'), {
          height: 0,
          paddingTop: 0,
          paddingBottom: 0,
          marginTop: 0,
          opacity: 0,
          duration: DUR.base,
          ease: EASE.in,
          stagger: 0.04,
        })
          .to(pick('.change-item.added, .change-item.servings'), { backgroundColor: WASH_NONE, duration: DUR.base }, '<')
          .to(pick('.change-mark'), { scale: 0, opacity: 0, duration: DUR.fast, stagger: 0.02 }, '<0.1')
          .fromTo(
            root.current,
            { boxShadow: '0 0 0 0 rgba(31, 93, 70, 0.4)' },
            { boxShadow: '0 0 0 12px rgba(31, 93, 70, 0)', duration: DUR.slow, ease: EASE.out, clearProps: 'boxShadow' },
            '-=0.1',
          )
          .from(pick('.change-result'), { y: 10, opacity: 0, scale: 0.92, duration: DUR.base, ease: EASE.pop }, '<')
          .from(pick('.change-result-icon'), { scale: 0, rotate: -120, duration: DUR.slow, ease: EASE.pop }, '<0.08')
        return
      }

      if (status === 'declined') {
        const tl = gsap.timeline()
        tl.to(pick('.change-item.added'), {
          x: 16,
          opacity: 0,
          height: 0,
          paddingTop: 0,
          paddingBottom: 0,
          marginTop: 0,
          duration: DUR.base,
          ease: EASE.in,
          stagger: 0.04,
        })
          .to(pick('.change-item.removed .change-strike'), {
            scaleX: 0,
            transformOrigin: 'right center',
            duration: DUR.base,
            ease: 'power2.inOut',
          }, '<')
          .to(pick('.change-item.removed'), { opacity: 1, duration: DUR.fast }, '<')
          .to(pick('.change-item.servings'), { backgroundColor: WASH_NONE, duration: DUR.base }, '<')
          .addLabel('rewind', '<')
        countTotals(tl, 'back', 'rewind')
        tl.to(pick('.change-body'), { height: 0, opacity: 0, duration: DUR.base, ease: EASE.in }, '+=0.35')
          .from(pick('.change-result'), { y: 8, opacity: 0, duration: DUR.base, ease: EASE.out }, '-=0.1')
        return
      }

      if (status === 'pending' && previous === 'applying' && change.error) {
        gsap.fromTo(pick('.change-error'), { x: -8 }, { x: 0, duration: DUR.slow, ease: 'elastic.out(1, 0.35)' })
      }
    },
    { scope: root, dependencies: [status] },
  )

  const press = contextSafe((event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    gsap.fromTo(event.currentTarget, { scale: 0.95 }, { scale: 1, duration: DUR.base, ease: EASE.pop })
    action()
  })

  const collapsed = settledOnMount && status === 'declined'
  const hideRemoved = settledOnMount && status === 'applied'
  const days = change.days.map((day) => friendlyDate(day.date))
  const meal = change.kind === 'meal'
  const labels = meal
    ? { pending: 'Another option', applied: 'Swapped in', declined: 'Kept the original' }
    : { pending: 'Proposed plan change', applied: 'Plan updated', declined: 'Change not applied' }

  return (
    <div className={`change-card ${status}`} ref={root}>
      <p className="recommendation-eyebrow">
        <IconCalendar size={14} aria-hidden="true" />
        {status === 'applied' ? labels.applied : status === 'declined' ? labels.declined : labels.pending}
      </p>

      {!collapsed && (
        <div className="change-body" aria-busy={status === 'applying'}>
          {change.days.map((day) => (
            <DayDiff key={day.date} day={day} settled={hideRemoved} />
          ))}
        </div>
      )}

      {status === 'applied' && (
        <p className="change-result applied" role="status">
          <span className="change-result-icon" aria-hidden="true">
            <IconCheck size={14} />
          </span>
          {meal ? 'Swapped in — the card above shows it now.' : `Saved your plan for ${days.join(', ')}.`}
        </p>
      )}

      {status === 'declined' && (
        <p className="change-result declined" role="status">
          {meal ? 'Kept the original recommendation.' : `Kept your current plan for ${days.join(', ')}.`}
        </p>
      )}

      {change.error && (
        <p className="change-error" role="alert">
          <IconWarn size={14} aria-hidden="true" />
          {change.error}
        </p>
      )}

      {(status === 'pending' || status === 'applying') && (
        <div className="change-actions">
          <button
            type="button"
            className="button primary block"
            disabled={status === 'applying'}
            onClick={(event) => press(event, onConfirm)}
          >
            {status === 'applying' ? (
              <>
                <span className="spinner" aria-hidden="true" /> Updating…
              </>
            ) : (
              <>
                <IconCheck size={16} /> {meal ? 'Swap it in' : 'Save this change'}
              </>
            )}
          </button>
          <button
            type="button"
            className="button block"
            disabled={status === 'applying'}
            onClick={(event) => press(event, onDecline)}
          >
            {meal ? 'Keep the original' : 'Keep current plan'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ parts */

function DayDiff({ day, settled }: { day: DayChange; settled: boolean }) {
  const meals = day.diff.meals.filter((meal) => meal.changed)
  return (
    <section className="change-day" data-change-day>
      <header className="change-day-head">
        <div className="change-day-title">
          <strong>{friendlyDate(day.date)}</strong>
          <span>
            <IconPin size={12} aria-hidden="true" />
            {day.locationName}
          </span>
        </div>
        <div className="change-macros">
          <MacroCounter icon={IconCalories} shift={day.diff.calories} unit="kcal" label="Calories" />
          <MacroCounter icon={IconProtein} shift={day.diff.protein} unit="g" label="Protein" />
        </div>
      </header>

      {day.proposal.rationale && <p className="change-rationale">{day.proposal.rationale}</p>}

      {meals.map((meal) => (
        <MealDiff key={meal.key} meal={meal} settled={settled} />
      ))}
    </section>
  )
}

function MacroCounter({
  icon: Icon,
  shift,
  unit,
  label,
}: {
  icon: (p: IconProps) => ReactNode
  shift: MacroShift
  unit: Unit
  label: string
}) {
  const format = FORMAT[unit]
  const { before, after, delta } = shift
  const moved = delta !== null && Math.round(delta) !== 0
  const title =
    before !== null && after !== null
      ? `${label}: ${format(before)} → ${format(after)}`
      : `${label}: ${after === null ? 'not listed' : format(after)}`

  return (
    <span className="change-macro" title={title}>
      <Icon size={14} aria-hidden="true" />
      {after === null ? (
        <b>—</b>
      ) : before === null ? (
        <b>{format(after)}</b>
      ) : (
        <b data-count data-from={before} data-to={after} data-unit={unit}>
          {format(after)}
        </b>
      )}
      <span className="sr-only">{title}</span>
      {moved && (
        <em className={`change-delta ${delta > 0 ? 'up' : 'down'}`} aria-hidden="true">
          {delta > 0 ? '+' : '−'}
          {format(Math.abs(delta))}
        </em>
      )}
    </span>
  )
}

function MealDiff({ meal, settled }: { meal: MealChange; settled: boolean }) {
  const Glyph = periodIcon(meal.periodName)
  const shown = meal.items.filter(
    (item) => item.kind !== 'kept' && !(settled && item.kind === 'removed'),
  )
  const kept = meal.items.length - meal.items.filter((item) => item.kind !== 'kept').length

  return (
    <div className="change-meal">
      <p className="change-meal-name">
        <Glyph size={14} aria-hidden="true" />
        {meal.periodName}
      </p>
      <ul className="change-items">
        {shown.map((item) => {
          const row = item.after ?? item.before
          const calories =
            row && typeof row.calories === 'number' ? Math.round(row.calories * row.servings) : null
          return (
            <li key={item.key} className={`change-item ${item.kind}`}>
              {!settled && (
                <span className="change-mark" aria-hidden="true">
                  {MARK[item.kind]}
                </span>
              )}
              <span className="change-name">
                <span className="change-name-text">
                  <span className="sr-only">{KIND_LABEL[item.kind]}: </span>
                  {item.name}
                  {item.kind === 'removed' && <span className="change-strike" aria-hidden="true" />}
                </span>
              </span>
              {item.kind === 'servings' && item.before && item.after && (
                <em className="change-servings">
                  ×{item.before.servings} → ×{item.after.servings}
                </em>
              )}
              <strong>{calories === null ? '—' : `${calories.toLocaleString()} kcal`}</strong>
            </li>
          )
        })}
      </ul>
      {kept > 0 && (
        <p className="change-kept">
          {kept} {kept === 1 ? 'item' : 'items'} unchanged
        </p>
      )}
    </div>
  )
}
