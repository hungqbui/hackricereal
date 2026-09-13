/**
 * My Meals — what you ate, and what you plan to eat.
 *
 * Three periods behind one segmented control:
 *
 * - **Today**    the logged-meal timeline and the day's totals
 * - **This Week** the multi-day planner — `Composer` + `WeekBoard` + `DayDetail`,
 *                 the original UniBite surface, kept whole and moved here so the
 *                 Advisor tab stays a single idea (see DECISIONS.md)
 * - **This Month** rolling averages over the log
 *
 * Today and This Month read the local meal log; This Week is entirely backed by
 * `POST /plans/generate` and `POST /plans/{id}/refine`.
 */

import { useMemo, useRef, useState } from 'react'

import type { Location, Meal, Plan } from '../api/types'
import { addDays, friendlyDate, todayISO, weekdayLabel } from '../lib/dates'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import type { Interpretation } from '../lib/parse'
import type { Availability } from '../state/availability'
import type { Board } from '../state/board'
import {
  MEAL_SLOTS,
  sumMeals,
  type DayTotals,
  type LoggedMeal,
  type MealLog,
  type MealSlot,
} from '../state/meals'
import type { StudentProfile } from '../state/profile'
import { Composer } from './Composer'
import { DayDetail } from './DayDetail'
import { WeekBoard } from './WeekBoard'
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconLeaf,
  IconPin,
  IconPlus,
  IconTrash,
  IconTrend,
  IconWarn,
  foodIcon,
  periodIcon,
} from './icons'
import { Card, EmptyState, InsightCard, ProgressRing, SegmentedControl, StatTile } from './ui'

type Period = 'today' | 'week' | 'month'

const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
]

export interface MealsScreenProps {
  profile: StudentProfile
  log: MealLog
  onAddManual: () => void
  /* --- the week planner, passed straight through to the original components */
  board: Board | null
  busy: boolean
  query: string
  onQueryChange: (value: string) => void
  spec: Interpretation
  locations: Location[]
  onSpecChange: (patch: Partial<Interpretation>) => void
  onGenerate: () => void
  onResetSpec: () => void
  specEdited: boolean
  availability: Availability
  onClearBoard: () => void
  /** Plans whose change was reviewed and confirmed in the day panel. */
  onPlansChanged: (plans: Plan[]) => void
  /** Logged week-plan meals, keyed by `eatenKey(planId, periodId)`. */
  eatenMeals: Map<string, string>
  onToggleEaten: (plan: Plan, meal: Meal, locationName: string) => void
}

export function MealsScreen(props: MealsScreenProps) {
  const [period, setPeriod] = useState<Period>('today')

  return (
    <div className="screen meals-screen">
      <header className="screen-head">
        <h1>My Meals</h1>
        {period === 'today' && (
          <button
            type="button"
            className="icon-button ghost"
            onClick={props.onAddManual}
            aria-label="Log a meal"
            title="Log a meal"
          >
            <IconPlus size={20} />
          </button>
        )}
      </header>

      <SegmentedControl
        options={PERIOD_OPTIONS}
        value={period}
        onChange={setPeriod}
        label="Time period"
      />

      {period === 'today' && <TodayView {...props} />}
      {period === 'week' && <WeekView {...props} />}
      {period === 'month' && <MonthView {...props} />}
    </div>
  )
}

/* ------------------------------------------------------------------ today */

function TodayView({ profile, log, onAddManual }: MealsScreenProps) {
  const [date, setDate] = useState(todayISO())
  const meals = log.onDate(date)
  const totals = log.totalsFor(date)
  const timeline = useRef<HTMLUListElement>(null)
  const isToday = date === todayISO()

  useGSAP(
    () => {
      gsap.from('li', { y: 10, opacity: 0, duration: DUR.base, ease: EASE.out, stagger: STAGGER })
    },
    { dependencies: [date, meals.length], scope: timeline },
  )

  const bySlot = useMemo(() => {
    const map = new Map<MealSlot, LoggedMeal[]>()
    for (const meal of meals) {
      const bucket = map.get(meal.slot)
      if (bucket) bucket.push(meal)
      else map.set(meal.slot, [meal])
    }
    return map
  }, [meals])

  const caloriesLeft = profile.calorieGoal - totals.calories
  const proteinLeft = profile.proteinGoal - totals.protein_g

  return (
    <>
      <div className="date-nav">
        <button
          type="button"
          className="icon-button ghost"
          onClick={() => setDate(addDays(date, -1))}
          aria-label="Previous day"
        >
          <IconChevronLeft size={18} />
        </button>
        <p>
          <IconCalendar size={15} aria-hidden="true" />
          {friendlyDate(date)}
        </p>
        <button
          type="button"
          className="icon-button ghost"
          onClick={() => setDate(addDays(date, 1))}
          disabled={isToday}
          aria-label="Next day"
        >
          <IconChevronRight size={18} />
        </button>
      </div>

      <Card className="summary-card">
        <div className="summary-card-inner">
          <ProgressRing
            value={totals.calories}
            target={profile.calorieGoal}
            display={totals.calories.toLocaleString()}
            caption="kcal"
            size={96}
          />
          <ProgressRing
            value={totals.protein_g}
            target={profile.proteinGoal}
            display={`${totals.protein_g}g`}
            caption="protein"
            size={96}
            tone="accent"
          />
        </div>
        <p className="summary-meals">
          <strong>{totals.meals}</strong> of 3 meals logged
        </p>
      </Card>

      <ul className="timeline" ref={timeline}>
        {MEAL_SLOTS.map((slot) => {
          const entries = bySlot.get(slot) ?? []
          if (entries.length === 0) {
            return (
              <li key={slot}>
                <UnloggedRow slot={slot} onLog={onAddManual} disabled={!isToday} />
              </li>
            )
          }
          return entries.map((meal) => (
            <li key={meal.id}>
              <MealTimelineRow meal={meal} onRemove={() => log.remove(meal.id)} />
            </li>
          ))
        })}
      </ul>

      {/* No empty state here on purpose: the timeline above always renders a
          placeholder row per meal slot, each already reading "Not logged yet —
          ask your advisor for a recommendation". A card repeating that a fifth
          time was pure duplication. */}
      {meals.length > 0 && (
        <InsightCard
          icon={caloriesLeft >= 0 ? IconLeaf : IconWarn}
          tone={caloriesLeft >= 0 ? 'good' : 'warn'}
          title={progressTitle(totals, profile)}
        >
          {caloriesLeft >= 0
            ? `${caloriesLeft.toLocaleString()} calories and ${Math.max(0, proteinLeft)}g protein left to go.`
            : `You're ${Math.abs(caloriesLeft).toLocaleString()} calories over today's goal.`}
        </InsightCard>
      )}
    </>
  )
}

function progressTitle(totals: DayTotals, profile: StudentProfile): string {
  if (totals.calories > profile.calorieGoal) return 'Over for today'
  if (totals.meals >= 3) return 'Full day logged — nice work!'
  if (totals.protein_g < profile.proteinGoal * 0.4) return "You're a little low on protein"
  return "You're on track!"
}

function MealTimelineRow({ meal, onRemove }: { meal: LoggedMeal; onRemove: () => void }) {
  const totals = sumMeals([meal])
  const Glyph = foodIcon(meal.items[0]?.name, meal.items[0]?.category)
  const time = new Date(meal.loggedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="timeline-row">
      <div className="timeline-slot">
        <strong>{meal.slot}</strong>
        <span>{time}</span>
      </div>
      <span className="food-tile" aria-hidden="true">
        <Glyph size={22} />
      </span>
      <div className="timeline-body">
        <p className="timeline-title">{meal.title}</p>
        <p className="timeline-sub">
          {totals.calories} kcal · {totals.protein_g}g protein
          {meal.locationName && (
            <>
              <span className="dot" aria-hidden="true" />
              {meal.locationName}
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        className="icon-button ghost"
        onClick={onRemove}
        aria-label={`Remove ${meal.title}`}
        title="Remove"
      >
        <IconTrash size={17} />
      </button>
    </div>
  )
}

function UnloggedRow({
  slot,
  onLog,
  disabled,
}: {
  slot: MealSlot
  onLog: () => void
  disabled?: boolean
}) {
  const Glyph = periodIcon(slot)
  return (
    <div className="timeline-row unlogged">
      <div className="timeline-slot">
        <strong>{slot}</strong>
      </div>
      <span className="food-tile muted" aria-hidden="true">
        <Glyph size={22} />
      </span>
      <div className="timeline-body">
        <p className="timeline-title muted">Not logged yet</p>
        <p className="timeline-sub">Ask your advisor for a recommendation</p>
      </div>
      <button
        type="button"
        className="icon-button ghost"
        onClick={onLog}
        disabled={disabled}
        aria-label={`Log ${slot.toLowerCase()}`}
        title={`Log ${slot.toLowerCase()}`}
      >
        <IconPlus size={18} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------- week */

function WeekView({
  board,
  busy,
  query,
  onQueryChange,
  spec,
  locations,
  onSpecChange,
  onGenerate,
  onResetSpec,
  specEdited,
  availability,
  onClearBoard,
  onPlansChanged,
  eatenMeals,
  onToggleEaten,
}: MealsScreenProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const selectedDay = board?.days.find((day) => day.date === selectedDate) ?? null

  return (
    <div className="week-view">
      {board && (
        <div className="week-context">
          <p>
            <IconPin size={14} aria-hidden="true" />
            <strong>{board.locationName}</strong>
          </p>
          <button
            type="button"
            className="button small"
            onClick={() => {
              onClearBoard()
              setSelectedDate(null)
            }}
          >
            New plan
          </button>
        </div>
      )}

      <Composer
        query={query}
        onQueryChange={onQueryChange}
        spec={spec}
        locations={locations}
        onChange={onSpecChange}
        onSubmit={() => {
          setSelectedDate(null)
          onGenerate()
        }}
        onReset={onResetSpec}
        edited={specEdited}
        busy={busy}
        compact={Boolean(board)}
        availability={availability}
      />

      {board ? (
        <WeekBoard
          board={board}
          selectedDate={selectedDate}
          onSelect={setSelectedDate}
          eatenMeals={eatenMeals}
        />
      ) : (
        <EmptyState icon={IconCalendar} title="Plan a few days at once">
          Describe a day or a week in plain English — “high protein lunches at Moody Towers this
          week”. UniBite builds each day from the live menu.
        </EmptyState>
      )}

      {board && selectedDay?.plan && (
        <DayDetail
          day={selectedDay}
          board={board}
          busy={busy}
          onClose={() => setSelectedDate(null)}
          onPlansChanged={onPlansChanged}
          eatenMeals={eatenMeals}
          onToggleEaten={onToggleEaten}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ month */

function MonthView({ profile, log }: MealsScreenProps) {
  const today = todayISO()
  const totals = log.totalsOver(today, 30)
  const days = useMemo(
    () =>
      Array.from({ length: 14 }, (_, index) => {
        const date = addDays(today, -(13 - index))
        return { date, totals: log.totalsFor(date) }
      }),
    [today, log],
  )

  const loggedDays = days.filter((day) => day.totals.calories > 0).length
  const average = loggedDays > 0 ? Math.round(totals.calories / Math.max(1, loggedDays)) : 0
  const averageProtein =
    loggedDays > 0 ? Math.round(totals.protein_g / Math.max(1, loggedDays)) : 0
  const peak = Math.max(profile.calorieGoal, ...days.map((day) => day.totals.calories), 1)

  if (loggedDays === 0) {
    return (
      <EmptyState icon={IconTrend} title="No history yet">
        Log a few meals and this fills in with your daily averages and a two-week trend.
      </EmptyState>
    )
  }

  return (
    <>
      <div className="stat-row">
        <StatTile value={average.toLocaleString()} label="avg kcal / day" sub="last 30 days" />
        <StatTile value={`${averageProtein}g`} label="avg protein" sub="per logged day" />
        <StatTile value={String(loggedDays)} label="days logged" sub="of last 14" />
      </div>

      <Card>
        <h2 className="eyebrow">Last 14 days</h2>
        <div className="trend" role="img" aria-label={trendLabel(days, profile)}>
          {days.map((day) => (
            <div key={day.date} className="trend-col" title={`${friendlyDate(day.date)}: ${day.totals.calories} kcal`}>
              <div className="trend-track">
                <div
                  className={`trend-bar${day.totals.calories > profile.calorieGoal ? ' over' : ''}`}
                  style={{ height: `${Math.round((day.totals.calories / peak) * 100)}%` }}
                />
              </div>
              <span>{weekdayLabel(day.date).slice(0, 1)}</span>
            </div>
          ))}
        </div>
        <p className="trend-legend">
          Goal is {profile.calorieGoal.toLocaleString()} kcal — bars above it are shaded darker.
        </p>
      </Card>
    </>
  )
}

function trendLabel(
  days: Array<{ date: string; totals: DayTotals }>,
  profile: StudentProfile,
): string {
  const hit = days.filter(
    (day) => day.totals.calories > 0 && day.totals.calories <= profile.calorieGoal,
  ).length
  return `Daily calories over the last 14 days. ${hit} days were inside your ${profile.calorieGoal} calorie goal.`
}
