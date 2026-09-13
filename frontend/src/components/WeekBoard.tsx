import type { Meal } from '../api/types'
import { macroValue } from '../lib/format'
import { PERIOD_ORDER } from '../lib/parse'
import { monthDayLabel, todayISO, weekdayLabel } from '../lib/dates'
import { CalorieMeter } from './Macros'
import type { Board, DayCell } from '../state/board'

const MAX_PREVIEW_ITEMS = 3

function periodRank(name: string | null): number {
  const index = PERIOD_ORDER.findIndex(
    (period) => period.toLowerCase() === (name ?? '').trim().toLowerCase(),
  )
  return index === -1 ? PERIOD_ORDER.length : index
}

function sortMeals(meals: Meal[]): Meal[] {
  return [...meals].sort((a, b) => periodRank(a.period_name) - periodRank(b.period_name))
}

function MealCard({ meal }: { meal: Meal }) {
  const preview = meal.items.slice(0, MAX_PREVIEW_ITEMS)
  const hidden = meal.items.length - preview.length

  return (
    <div className="meal-card">
      <p className="meal-card-period">{meal.period_name ?? 'Meal'}</p>
      {meal.items.length === 0 ? (
        <p className="meal-card-empty">{meal.notes ?? 'Nothing planned.'}</p>
      ) : (
        <>
          <ul className="meal-card-items">
            {/* A hall can list one dish under two categories, so the item
                id alone is not unique within a meal. */}
            {preview.map((item, index) => (
              <li key={`${item.item_id ?? 'item'}-${index}`}>
                <span className="meal-card-item-name">{item.name ?? 'Item'}</span>
                <span className="meal-card-item-cal">
                  {macroValue((item.calories ?? 0) * item.servings, 'calories')}
                </span>
              </li>
            ))}
          </ul>
          {hidden > 0 && <p className="meal-card-more">+{hidden} more</p>}
          <p className="meal-card-totals">
            {macroValue(meal.totals.calories, 'calories')} cal ·{' '}
            {macroValue(meal.totals.protein_g, 'protein_g')} protein
          </p>
        </>
      )}
    </div>
  )
}

function DayColumn({
  day,
  selected,
  calorieTarget,
  onSelect,
}: {
  day: DayCell
  selected: boolean
  calorieTarget: number | undefined
  onSelect: (date: string) => void
}) {
  const today = todayISO()
  const totals = day.plan?.content.totals
  const meals = day.plan ? sortMeals(day.plan.content.meals) : []

  return (
    <article className={`day-column${selected ? ' selected' : ''}`}>
      <button
        type="button"
        className="day-header"
        onClick={() => onSelect(day.date)}
        disabled={!day.plan}
      >
        <span className="day-header-top">
          <span className="day-weekday">
            {day.date === today ? 'Today' : weekdayLabel(day.date)}
          </span>
          <span className="day-date">{monthDayLabel(day.date)}</span>
        </span>
        {day.plan && (
          <>
            <span className="day-totals">
              {macroValue(totals?.calories, 'calories')} cal ·{' '}
              {macroValue(totals?.protein_g, 'protein_g')} protein
            </span>
            <CalorieMeter actual={totals?.calories} target={calorieTarget} />
          </>
        )}
      </button>

      <div className="day-body">
        {day.status === 'loading' || day.status === 'queued' || day.refining ? (
          <div className="day-placeholder">
            <span className="spinner" aria-hidden="true" />
            {day.refining ? 'Refining…' : day.status === 'queued' ? 'Queued' : 'Planning…'}
          </div>
        ) : day.status === 'ready' && day.plan ? (
          <>
            {meals.map((meal, index) => (
              <button
                key={meal.period_id ?? index}
                type="button"
                className="meal-card-button"
                onClick={() => onSelect(day.date)}
              >
                <MealCard meal={meal} />
              </button>
            ))}
            {day.message && <p className="day-note warn">{day.message}</p>}
          </>
        ) : (
          <div className={`day-placeholder ${day.status}`}>
            {day.message ?? 'Nothing here.'}
          </div>
        )}
      </div>
    </article>
  )
}

export function WeekBoard({
  board,
  selectedDate,
  onSelect,
}: {
  board: Board
  selectedDate: string | null
  onSelect: (date: string) => void
}) {
  return (
    <section className="board" aria-label="Meal plan calendar">
      {/* A one- or two-day plan should not stretch a column across the
          whole page the way a full week fills it. */}
      <div className={board.days.length <= 3 ? 'board-scroll sparse' : 'board-scroll'}>
        {board.days.map((day) => (
          <DayColumn
            key={day.date}
            day={day}
            selected={day.date === selectedDate}
            calorieTarget={board.targets.calories}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}
