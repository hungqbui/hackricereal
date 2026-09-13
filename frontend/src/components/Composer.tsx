import { useMemo, type KeyboardEvent } from 'react'

import type { Location, NutritionTargets } from '../api/types'
import { friendlyDate, monthDayLabel, todayISO, weekdayLabel } from '../lib/dates'
import { MACRO_LABELS, MACRO_UNITS, TARGET_FIELDS } from '../lib/format'
import { EXAMPLE_PROMPTS, PERIOD_ORDER, type Interpretation, type PeriodName } from '../lib/parse'

interface ComposerProps {
  query: string
  onQueryChange: (value: string) => void
  spec: Interpretation
  locations: Location[]
  onChange: (patch: Partial<Interpretation>) => void
  onSubmit: () => void
  onReset: () => void
  edited: boolean
  busy: boolean
  compact: boolean
}

export function Composer({
  query,
  onQueryChange,
  spec,
  locations,
  onChange,
  onSubmit,
  onReset,
  edited,
  busy,
  compact,
}: ComposerProps) {
  const today = todayISO()
  const grouped = useMemo(() => {
    const buckets = new Map<string, Location[]>()
    for (const location of locations) {
      const key = location.building || 'Other'
      const list = buckets.get(key) ?? []
      list.push(location)
      buckets.set(key, list)
    }
    return [...buckets.entries()]
  }, [locations])

  const canSubmit = Boolean(spec.locationId) && spec.dates.length > 0 && !busy

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (canSubmit) onSubmit()
    }
  }

  function togglePeriod(period: PeriodName) {
    const next = spec.periods.includes(period)
      ? spec.periods.filter((entry) => entry !== period)
      : [...spec.periods, period]
    onChange({ periods: next })
  }

  function removeDate(date: string) {
    onChange({ dates: spec.dates.filter((entry) => entry !== date) })
  }

  function addDate(date: string) {
    if (!date || spec.dates.includes(date)) return
    onChange({ dates: [...spec.dates, date].sort() })
  }

  function setTarget(field: keyof NutritionTargets, raw: string) {
    const next: NutritionTargets = { ...spec.targets }
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value) || value <= 0) delete next[field]
    else next[field] = value
    onChange({ targets: next })
  }

  const setTargets = TARGET_FIELDS.filter((field) => spec.targets[field] != null)

  return (
    <section className={compact ? 'composer compact' : 'composer'}>
      <div className="composer-input">
        <textarea
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="What do you want to eat? e.g. “High-protein vegetarian lunch and dinner at Moody Towers this week, 2200 calories and 150g protein”"
          aria-label="Describe the meal plan you want"
        />
        <button
          type="button"
          className="button primary composer-go"
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          {busy ? 'Planning…' : 'Build plan'}
        </button>
      </div>

      {!compact && (
        <div className="examples">
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example}
              type="button"
              className="chip ghost"
              onClick={() => onQueryChange(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}

      <div className="interpretation">
        <div className="interpretation-group">
          <label className="interpretation-label" htmlFor="location-select">
            Dining hall
          </label>
          <select
            id="location-select"
            className="select"
            value={spec.locationId ?? ''}
            onChange={(event) => onChange({ locationId: event.target.value || null })}
          >
            <option value="">Choose a location…</option>
            {grouped.map(([building, entries]) => (
              <optgroup key={building} label={building}>
                {entries.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="interpretation-group">
          <span className="interpretation-label">Days</span>
          <div className="chip-row">
            {spec.dates.map((date) => (
              <button
                key={date}
                type="button"
                className="chip removable"
                onClick={() => removeDate(date)}
                title="Remove this day"
              >
                {date === today ? 'Today' : `${weekdayLabel(date)} ${monthDayLabel(date)}`}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <label className="chip add">
              +
              <input
                type="date"
                value=""
                min={today}
                onChange={(event) => addDate(event.target.value)}
                aria-label="Add a day"
              />
            </label>
          </div>
        </div>

        <div className="interpretation-group">
          <span className="interpretation-label">
            Meals{spec.periods.length === 0 && <em> · everything served</em>}
          </span>
          <div className="chip-row">
            {PERIOD_ORDER.map((period) => (
              <button
                key={period}
                type="button"
                className={spec.periods.includes(period) ? 'chip on' : 'chip'}
                onClick={() => togglePeriod(period)}
              >
                {period}
              </button>
            ))}
          </div>
        </div>

        <details className="interpretation-group targets" open={setTargets.length > 0}>
          <summary>
            <span className="interpretation-label">Daily targets</span>
            <span className="targets-summary">
              {setTargets.length
                ? setTargets
                    .map(
                      (field) =>
                        `${spec.targets[field]}${MACRO_UNITS[field]} ${MACRO_LABELS[
                          field
                        ].toLowerCase()}`,
                    )
                    .join(' · ')
                : 'none set'}
            </span>
          </summary>
          <div className="target-inputs">
            {TARGET_FIELDS.map((field) => (
              <label key={field} className="target-input">
                <span>
                  {MACRO_LABELS[field]}
                  {MACRO_UNITS[field] && ` (${MACRO_UNITS[field]})`}
                </span>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={spec.targets[field] ?? ''}
                  onChange={(event) => setTarget(field, event.target.value)}
                />
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="composer-footer">
        <p className="composer-hint">
          {spec.dates.length > 0
            ? `Planning ${spec.dates.length} day${spec.dates.length > 1 ? 's' : ''}, ${friendlyDate(
                spec.dates[0],
                today,
              )} onward.`
            : 'Pick at least one day.'}
          {' '}⌘↵ to build.
        </p>
        {edited && (
          <button type="button" className="link" onClick={onReset}>
            Reset to what I typed
          </button>
        )}
      </div>
    </section>
  )
}
