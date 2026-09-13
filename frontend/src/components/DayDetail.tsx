import { useEffect, useState, type FormEvent } from 'react'

import type { Meal, PlannedItem } from '../api/types'
import { friendlyDate, weekdayLabel } from '../lib/dates'
import { MACRO_LABELS, macroValue, servingsLabel } from '../lib/format'
import { MacroPills, TargetFit } from './Macros'
import type { Board, DayCell } from '../state/board'

function ItemRow({ item }: { item: PlannedItem }) {
  const servings = servingsLabel(item.servings)
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
            {item.tags.map((tag) => (
              <span key={tag} className="tag diet">
                {tag}
              </span>
            ))}
            {item.allergens.length > 0 && (
              <span className="tag allergen" title={item.allergens.join(', ')}>
                contains {item.allergens.slice(0, 3).join(', ')}
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
        <span className="item-macro-line">
          P {macroValue((item.protein_g ?? 0) * item.servings, 'protein_g')} · C{' '}
          {macroValue((item.carbs_g ?? 0) * item.servings, 'carbs_g')} · F{' '}
          {macroValue((item.fat_g ?? 0) * item.servings, 'fat_g')}
        </span>
      </div>
    </li>
  )
}

function MealSection({ meal }: { meal: Meal }) {
  return (
    <section className="meal-section">
      <header className="meal-section-header">
        <h3>{meal.period_name ?? 'Meal'}</h3>
        <span className="meal-section-totals">
          {macroValue(meal.totals.calories, 'calories')} cal ·{' '}
          {macroValue(meal.totals.protein_g, 'protein_g')} protein
        </span>
      </header>
      {meal.notes && <p className="meal-notes">{meal.notes}</p>}
      {meal.items.length === 0 ? (
        <p className="meal-notes muted">No items selected for this period.</p>
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <aside className="detail" aria-label={`Plan for ${day.date}`}>
        <header className="detail-header">
          <div>
            <p className="detail-eyebrow">
              {weekdayLabel(day.date, 'long')} · {friendlyDate(day.date)} ·{' '}
              {board.locationName}
            </p>
            <h2>{content.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="detail-body">
          {plan.model === 'fallback-greedy' && (
            <p className="banner">
              Built by the offline planner — the backend has no{' '}
              <code>GEMINI_API_KEY</code>, so selections are rule-based and
              refinement is unavailable.
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
            <section className="detail-notes">
              <h3>How your constraints were handled</h3>
              <ul>
                {content.constraint_notes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          {content.warnings.length > 0 && (
            <section className="detail-notes warn">
              <h3>Caveats</h3>
              <ul>
                {content.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {plan.revisions.length > 1 && (
            <section className="detail-notes">
              <h3>Revisions</h3>
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
            <span>Change something</span>
            <textarea
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="e.g. swap the chicken for a vegetarian option and add more fiber"
            />
          </label>
          <div className="refine-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !instruction.trim()}
            >
              {day.refining ? 'Refining…' : 'Update this day'}
            </button>
            {plannedDates.length > 1 && (
              <button
                type="button"
                className="button"
                disabled={busy || !instruction.trim()}
                onClick={(event) => submit(event, plannedDates)}
              >
                Apply to all {plannedDates.length} days
              </button>
            )}
          </div>
          <p className="refine-hint">
            Macros are recomputed server-side from the real menu, so totals
            always match what you would actually eat. {MACRO_LABELS.calories} and
            protein are prioritised first.
          </p>
        </form>
      </aside>
    </>
  )
}
