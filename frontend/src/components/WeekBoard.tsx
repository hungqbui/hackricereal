import { useRef } from 'react'

import type { Meal } from '../api/types'
import { macroValue } from '../lib/format'
import { PERIOD_ORDER } from '../lib/parse'
import { monthDayLabel, todayISO, weekdayLabel } from '../lib/dates'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import { FitRing, MacroLine } from './Macros'
import { IconCalendarOff, IconCheck, IconMore, IconWarn, periodIcon } from './icons'
import type { Board, DayCell } from '../state/board'
import { eatenKey } from '../state/meals'

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

function MealCard({ meal, eaten }: { meal: Meal; eaten: boolean }) {
  const preview = meal.items.slice(0, MAX_PREVIEW_ITEMS)
  const hidden = meal.items.length - preview.length
  const period = meal.period_name ?? 'Meal'
  const Icon = periodIcon(meal.period_name)

  return (
    <div className={`meal-card${eaten ? ' eaten' : ''}`}>
      <div className="meal-card-head">
        <span className="meal-card-glyph" title={period}>
          <Icon size={16} label={period} />
        </span>
        <span className="meal-card-period">{period}</span>
        {eaten && (
          <span className="meal-card-eaten" title="Eaten">
            <IconCheck size={11} label="Eaten" />
          </span>
        )}
        {meal.items.length > 0 && (
          <span className="meal-card-kcal" title="Calories">
            {macroValue(meal.totals.calories, 'calories')}
          </span>
        )}
      </div>

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
                {item.servings !== 1 && (
                  <span className="meal-card-item-servings">×{item.servings}</span>
                )}
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <p className="meal-card-more" title={`${hidden} more item${hidden === 1 ? '' : 's'}`}>
              <IconMore size={14} />
              {hidden}
            </p>
          )}
          <MacroLine
            className="meal-card-totals"
            calories={meal.totals.calories}
            protein={meal.totals.protein_g}
          />
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
  eatenMeals,
}: {
  day: DayCell
  selected: boolean
  calorieTarget: number | undefined
  onSelect: (date: string) => void
  eatenMeals: Map<string, string>
}) {
  const scope = useRef<HTMLElement>(null)
  const today = todayISO()
  const isToday = day.date === today
  const totals = day.plan?.content.totals
  const meals = day.plan ? sortMeals(day.plan.content.meals) : []
  const busy = day.status === 'loading' || day.status === 'queued' || day.refining

  // Meals arrive as each day resolves, so stagger them in on the transition
  // into `ready` rather than once on mount.
  useGSAP(
    () => {
      if (day.status !== 'ready' || meals.length === 0) return
      gsap.from('.meal-card-button', {
        opacity: 0,
        y: 10,
        duration: DUR.base,
        ease: EASE.out,
        stagger: STAGGER.each,
      })
    },
    { scope, dependencies: [day.status, meals.length] },
  )

  return (
    <article
      ref={scope}
      className={`day-column${selected ? ' selected' : ''}${isToday ? ' today' : ''}`}
      data-day-column
    >
      <button
        type="button"
        className="day-header"
        onClick={() => onSelect(day.date)}
        disabled={!day.plan}
        title={day.plan ? `Open ${weekdayLabel(day.date)}` : undefined}
      >
        <span className="day-header-text">
          <span className="day-weekday">
            {isToday ? 'Today' : weekdayLabel(day.date)}
          </span>
          <span className="day-date">{monthDayLabel(day.date)}</span>
        </span>
        {day.plan ? (
          <>
            <MacroLine
              className="day-totals"
              calories={totals?.calories}
              protein={totals?.protein_g}
            />
            <FitRing actual={totals?.calories} target={calorieTarget} />
          </>
        ) : (
          day.status === 'empty' && (
            <span className="day-closed" title="No menu published for this day">
              <IconCalendarOff size={13} />
              Closed
            </span>
          )
        )}
      </button>

      <div className="day-body">
        {busy ? (
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
                <MealCard
                  meal={meal}
                  eaten={eatenMeals.has(eatenKey(day.plan!.id, meal.period_id))}
                />
              </button>
            ))}
            {day.message && (
              <p className="day-note warn">
                <IconWarn size={14} />
                {day.message}
              </p>
            )}
          </>
        ) : (
          // A hall that simply is not serving reads as "closed", not as a
          // failure; only a real error gets the alarm glyph.
          <div className={`day-placeholder ${day.status}`}>
            {day.status === 'error' ? (
              <IconWarn size={16} />
            ) : (
              <IconCalendarOff size={16} />
            )}
            <span>
              {day.message ??
                (day.status === 'empty' ? 'No menu published.' : 'Nothing here.')}
            </span>
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
  eatenMeals,
}: {
  board: Board
  selectedDate: string | null
  onSelect: (date: string) => void
  eatenMeals: Map<string, string>
}) {
  const scope = useRef<HTMLElement>(null)

  // Deal the columns in when a new board appears. Keyed on the board's
  // identity, not its contents, so a refinement does not re-deal the week.
  useGSAP(
    () => {
      gsap.from('[data-day-column]', {
        opacity: 0,
        y: 18,
        duration: DUR.base,
        ease: EASE.out,
        stagger: STAGGER.each,
      })
    },
    { scope, dependencies: [board.locationId, board.days.length, board.days[0]?.date] },
  )

  return (
    <section className="board" aria-label="Meal plan calendar" ref={scope}>
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
            eatenMeals={eatenMeals}
          />
        ))}
      </div>
    </section>
  )
}
