import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { Meal, PlannedItem } from '../api/types'
import { friendlyDate, weekdayLabel } from '../lib/dates'
import { MACRO_LABELS, macroValue, servingsLabel } from '../lib/format'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import { MacroLine, MacroPills, TargetFit } from './Macros'
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

function MealSection({ meal }: { meal: Meal }) {
  const period = meal.period_name ?? 'Meal'
  const Icon = periodIcon(meal.period_name)

  return (
    <section className="meal-section" data-detail-section>
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
  onRefine: (dates: string[], instruction: string) => void
}

export function DayDetail({ day, board, busy, onClose, onRefine }: DayDetailProps) {
  const [instruction, setInstruction] = useState('')
  const scope = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Panel slides in over a fading scrim; the sections then deal themselves
  // in, so a long plan reads top-to-bottom instead of landing all at once.
  useGSAP(
    () => {
      const tl = gsap.timeline()
      tl.from('.scrim', { opacity: 0, duration: DUR.fast, ease: EASE.out })
        .from(
          '.detail',
          { xPercent: 4, opacity: 0, duration: DUR.base, ease: EASE.out },
          '<',
        )
        .from(
          '[data-detail-section]',
          {
            opacity: 0,
            y: 12,
            duration: DUR.base,
            ease: EASE.out,
            stagger: STAGGER.each,
          },
          '-=0.2',
        )
    },
    { scope, dependencies: [day.date] },
  )

  const plan = day.plan
  if (!plan) return null
  const { content } = plan
  const plannedDates = board.days.filter((entry) => entry.plan).map((entry) => entry.date)

  function submit(event: FormEvent, dates: string[]) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text) return
    onRefine(dates, text)
    setInstruction('')
  }

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
            <MealSection key={meal.period_id ?? index} meal={meal} />
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

        <form className="refine" onSubmit={(event) => submit(event, [day.date])}>
          {day.message && <p className="form-error">{day.message}</p>}
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
              disabled={busy || !instruction.trim()}
              title="Apply to this day"
            >
              {day.refining ? 'Refining…' : 'This day'}
              <IconArrowRight size={15} />
            </button>
            {plannedDates.length > 1 && (
              <button
                type="button"
                className="button"
                disabled={busy || !instruction.trim()}
                onClick={(event) => submit(event, plannedDates)}
                title={`Apply to all ${plannedDates.length} planned days`}
              >
                <IconCalendar size={15} />
                All {plannedDates.length}
              </button>
            )}
          </div>
          <p className="refine-hint">
            Macros are recomputed server-side from the real menu.
          </p>
        </form>
      </aside>
    </div>
  )
}
