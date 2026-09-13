import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { Meal, Plan, PlannedItem } from '../api/types'
import { friendlyDate, todayISO, weekdayLabel } from '../lib/dates'
import { eatenKey } from '../state/meals'
import { MACRO_LABELS, macroValue, servingsLabel } from '../lib/format'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import { usePlanReview } from '../state/review'
import { MacroLine, MacroPills, TargetFit } from './Macros'
import { ScheduleChangeCard } from './ScheduleChangeCard'
import {
  IconAllergen,
  IconArrowRight,
  IconCalendar,
  IconCarbs,
  IconChat,
  IconCheck,
  IconClose,
  IconFat,
  IconPin,
  IconProtein,
  IconWarn,
  dietIcon,
  periodIcon,
} from './icons'
import type { Board, DayCell } from '../state/board'

/** Per-item macros as three labelled glyphs instead of "P … · C … · F …". */
function ItemMacros({ item }: { item: PlannedItem }) {
  const parts = [
    { Icon: IconProtein, field: 'protein_g' as const, value: item.protein_g },
    { Icon: IconCarbs, field: 'carbs_g' as const, value: item.carbs_g },
    { Icon: IconFat, field: 'fat_g' as const, value: item.fat_g },
  ]
  return (
    <span className="item-macro-line">
      {parts.map(({ Icon, field, value }) => (
        <span key={field} className="item-macro-part" title={MACRO_LABELS[field]}>
          <Icon size={13} label={MACRO_LABELS[field]} />
          {macroValue((value ?? 0) * item.servings, field)}
        </span>
      ))}
    </span>
  )
}

function ItemRow({ item }: { item: PlannedItem }) {
  const servings = servingsLabel(item.servings)
  const allergens = item.allergens.join(', ')

  return (
    <li className="item-row">
      <div className="item-main">
        <p className="item-name">
          {item.name ?? 'Item'}
          {servings && <span className="item-servings">{servings}</span>}
        </p>
        <p className="item-meta">
          {[item.category, item.portion].filter(Boolean).join(' · ')}
        </p>
        {item.reason && <p className="item-reason">{item.reason}</p>}
        {(item.tags.length > 0 || item.allergens.length > 0) && (
          <p className="item-tags">
            {item.tags.map((tag) => {
              const Icon = dietIcon(tag)
              return (
                <span key={tag} className="tag diet" title={tag}>
                  <Icon size={13} label={tag} />
                  {tag}
                </span>
              )
            })}
            {item.allergens.length > 0 && (
              <span className="tag allergen" title={`Contains ${allergens}`}>
                <IconAllergen size={13} label="Contains" />
                {item.allergens.slice(0, 3).join(', ')}
                {item.allergens.length > 3 ? '…' : ''}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="item-macros">
        <span className="item-cal">
          {macroValue((item.calories ?? 0) * item.servings, 'calories')}
        </span>
        <ItemMacros item={item} />
      </div>
    </li>
  )
}

function MealSection({
  meal,
  date,
  eaten,
  onToggleEaten,
}: {
  meal: Meal
  date: string
  eaten: boolean
  onToggleEaten: () => void
}) {
  const period = meal.period_name ?? 'Meal'
  const Icon = periodIcon(meal.period_name)
  const section = useRef<HTMLElement>(null)
  const shown = useRef(eaten)
  const upcoming = date > todayISO()

  // Marking plays forward (check pops, the section washes green); unmarking
  // plays the check back out. Nothing runs on mount, so opening a day that is
  // already eaten simply shows it.
  useGSAP(
    () => {
      if (shown.current === eaten) return
      shown.current = eaten
      if (eaten) {
        gsap
          .timeline()
          .fromTo('.eaten-check', { scale: 0, rotate: -120 }, { scale: 1, rotate: 0, duration: DUR.slow, ease: EASE.pop })
          .fromTo(
            section.current,
            { backgroundColor: 'rgba(123, 170, 100, 0.3)' },
            { backgroundColor: 'rgba(123, 170, 100, 0)', duration: DUR.slow * 1.6, ease: EASE.out, clearProps: 'backgroundColor' },
            '<',
          )
          .from('.item-row', { x: -6, duration: DUR.base, ease: EASE.out, stagger: 0.04 }, '<0.1')
      } else {
        gsap.fromTo('.eaten-toggle', { scale: 0.94 }, { scale: 1, duration: DUR.base, ease: EASE.pop })
      }
    },
    { scope: section, dependencies: [eaten] },
  )

  return (
    <section className={`meal-section${eaten ? ' eaten' : ''}`} data-detail-section ref={section}>
      <header className="meal-section-header">
        <span className="meal-section-glyph" title={period}>
          <Icon size={16} label={period} />
        </span>
        <h3>{period}</h3>
        <MacroLine
          className="meal-section-totals"
          calories={meal.totals.calories}
          protein={meal.totals.protein_g}
        />
      </header>
      {meal.items.length > 0 && (
        <div className="meal-section-actions">
          <button
            type="button"
            className={`eaten-toggle${eaten ? ' on' : ''}`}
            onClick={onToggleEaten}
            disabled={upcoming && !eaten}
            aria-pressed={eaten}
            title={
              eaten
                ? 'Logged in My Meals — press to undo'
                : upcoming
                  ? 'You can mark this once the day comes'
                  : `Log this ${period.toLowerCase()} in My Meals`
            }
          >
            <span className="eaten-check" aria-hidden="true">
              <IconCheck size={12} />
            </span>
            {eaten ? 'Eaten' : 'Mark as eaten'}
          </button>
        </div>
      )}
      {meal.notes && <p className="meal-notes">{meal.notes}</p>}
      {meal.items.length === 0 ? (
        <p className="meal-notes muted">Nothing selected.</p>
      ) : (
        <ul className="item-list">
          {meal.items.map((item, index) => (
            <ItemRow key={`${item.item_id ?? 'item'}-${index}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

interface DayDetailProps {
  day: DayCell
  board: Board
  busy: boolean
  onClose: () => void
  /** Plans the student confirmed a change to, for the board to swap in. */
  onPlansChanged: (plans: Plan[]) => void
  /** Logged week-plan meals, keyed by `eatenKey(planId, periodId)`. */
  eatenMeals: Map<string, string>
  onToggleEaten: (plan: Plan, meal: Meal, locationName: string) => void
}

export function DayDetail({
  day,
  board,
  busy,
  onClose,
  onPlansChanged,
  eatenMeals,
  onToggleEaten,
}: DayDetailProps) {
  const [instruction, setInstruction] = useState('')
  const scope = useRef<HTMLDivElement>(null)
  const review = usePlanReview(onPlansChanged)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Panel slides in over a fading scrim; the sections then deal themselves
  // in, so a long plan reads top-to-bottom instead of landing all at once.
  //
  // Explicit fromTo end states, not from(): a from-tween takes its destination
  // from the element's current style, so anything mid-transition (or a tween
  // StrictMode reverted a frame ago) would become the resting value and leave
  // the panel half-faded. Inline styles are cleared once each tween lands.
  useGSAP(
    () => {
      const tl = gsap.timeline()
      tl.fromTo('.scrim', { opacity: 0 }, { opacity: 1, duration: DUR.fast, ease: EASE.out, clearProps: 'opacity' })
        .fromTo(
          '.detail',
          { xPercent: 4, opacity: 0 },
          { xPercent: 0, opacity: 1, duration: DUR.base, ease: EASE.out, clearProps: 'opacity,transform' },
          '<',
        )
        .fromTo(
          '[data-detail-section]',
          { opacity: 0, y: 12 },
          {
            opacity: 1,
            y: 0,
            duration: DUR.base,
            ease: EASE.out,
            stagger: STAGGER.each,
            clearProps: 'opacity,transform',
          },
          '-=0.2',
        )
    },
    { scope, dependencies: [day.date] },
  )

  // A saved change re-deals the sections so the new plan visibly arrives.
  const shownRevision = useRef(day.plan?.revision_count ?? 0)
  useGSAP(
    () => {
      const revision = day.plan?.revision_count ?? 0
      const previous = shownRevision.current
      shownRevision.current = revision
      if (revision <= previous) return
      gsap.fromTo(
        '[data-detail-section]',
        { opacity: 0, y: 10 },
        {
          opacity: 1,
          y: 0,
          duration: DUR.base,
          ease: EASE.out,
          stagger: STAGGER.each,
          clearProps: 'opacity,transform',
        },
      )
    },
    { scope, dependencies: [day.plan?.revision_count] },
  )

  const plan = day.plan
  if (!plan) return null
  const { content } = plan
  const plannedDates = board.days.filter((entry) => entry.plan).map((entry) => entry.date)
  const reviewing = review.change?.status === 'pending' || review.change?.status === 'applying'

  async function submit(event: FormEvent, dates: string[]) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text) return
    const targets = board.days
      .filter((entry) => dates.includes(entry.date) && entry.plan)
      .map((entry) => ({ date: entry.date, locationName: board.locationName, plan: entry.plan! }))
    // Kept until there is a proposal, so a busy model does not eat the request.
    if (await review.propose(targets, text)) setInstruction('')
  }

  const disabled = busy || review.proposing || reviewing || !instruction.trim()

  return (
    <div ref={scope}>
      <div className="scrim" onClick={onClose} role="presentation" />
      <aside className="detail" aria-label={`Plan for ${day.date}`}>
        <header className="detail-header">
          <div>
            <p className="detail-eyebrow">
              <IconCalendar size={13} />
              {weekdayLabel(day.date, 'long')} · {friendlyDate(day.date)}
              <span className="detail-eyebrow-sep" />
              <IconPin size={13} />
              {board.locationName}
            </p>
            <h2>{content.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <IconClose size={18} />
          </button>
        </header>

        <div className="detail-body">
          {plan.model === 'fallback-greedy' && (
            <p className="banner">
              <IconWarn size={15} />
              Offline planner — no <code>GEMINI_API_KEY</code>, so picks are
              rule-based and refinement is off.
            </p>
          )}

          {content.summary && <p className="detail-summary">{content.summary}</p>}

          <MacroPills
            totals={content.totals}
            fields={['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg']}
          />

          <TargetFit fit={content.target_fit} />

          {content.meals.map((meal, index) => (
            <MealSection
              key={meal.period_id ?? index}
              meal={meal}
              date={day.date}
              eaten={eatenMeals.has(eatenKey(plan.id, meal.period_id))}
              onToggleEaten={() => onToggleEaten(plan, meal, board.locationName)}
            />
          ))}

          {content.constraint_notes.length > 0 && (
            <section className="detail-notes" data-detail-section>
              <h3>
                <IconCheck size={15} />
                Constraints
              </h3>
              <ul>
                {content.constraint_notes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          {content.warnings.length > 0 && (
            <section className="detail-notes warn" data-detail-section>
              <h3>
                <IconWarn size={15} />
                Caveats
              </h3>
              <ul>
                {content.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {plan.revisions.length > 1 && (
            <section className="detail-notes" data-detail-section>
              <h3>
                <IconChat size={15} />
                Revisions
              </h3>
              <ol className="revision-list">
                {[...plan.revisions]
                  .sort((a, b) => b.revision_number - a.revision_number)
                  .map((revision) => (
                    <li key={revision.id}>
                      <span className="revision-number">#{revision.revision_number}</span>
                      <span>
                        {revision.instruction ?? 'Initial plan'}
                        {revision.rationale && (
                          <em className="revision-rationale">{revision.rationale}</em>
                        )}
                      </span>
                    </li>
                  ))}
              </ol>
            </section>
          )}
        </div>

        <form className="refine" onSubmit={(event) => void submit(event, [day.date])}>
          {day.message && <p className="form-error">{day.message}</p>}

          {/* Keyed per proposal, so each new one plays its own arrival. */}
          {review.change && (
            <div className="refine-review">
              <ScheduleChangeCard
                key={review.change.days.map((change) => change.proposal.plan_id + change.proposal.base_revision).join()}
                change={review.change}
                onConfirm={() => void review.confirm()}
                onDecline={review.decline}
              />
            </div>
          )}
          {review.notice && (
            <p className="form-error">
              <IconWarn size={14} /> {review.notice}
            </p>
          )}

          <label className="field">
            <span className="field-label-icon">
              <IconChat size={14} />
              Change something
            </span>
            <textarea
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Swap the chicken for something vegetarian, and more fiber."
            />
          </label>
          <div className="refine-actions">
            <button
              type="submit"
              className="button primary"
              disabled={disabled}
              title="Preview a change to this day"
            >
              {review.proposing ? 'Working it out…' : 'This day'}
              <IconArrowRight size={15} />
            </button>
            {plannedDates.length > 1 && (
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={(event) => void submit(event, plannedDates)}
                title={`Preview a change to all ${plannedDates.length} planned days`}
              >
                <IconCalendar size={15} />
                All {plannedDates.length}
              </button>
            )}
          </div>
          <p className="refine-hint">
            You'll see exactly what changes before anything is saved. Macros are recomputed from the
            real menu.
          </p>
        </form>
      </aside>
    </div>
  )
}
