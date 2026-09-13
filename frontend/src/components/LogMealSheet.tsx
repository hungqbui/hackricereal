/**
 * The "log a meal" sheet.
 *
 * Two ways in: pick something off a live menu (the same `/dining` data the
 * Dining tab browses, so the macros are real), or type a name and a calorie
 * count for something eaten off campus. Off-campus entries are the one place
 * in the app where a number is not server-computed, and the sheet says so.
 */

import { useEffect, useMemo, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Location, MenuItem } from '../api/types'
import { todayISO } from '../lib/dates'
import {
  MEAL_SLOTS,
  itemFromMenuItem,
  slotForTime,
  type LoggedItem,
  type MealSlot,
} from '../state/meals'
import {
  IconCalories,
  IconCheck,
  IconClose,
  IconPlus,
  IconProtein,
  IconSearch,
  IconWarn,
  foodIcon,
  periodIcon,
} from './icons'
import { EmptyState, FilterChip, SegmentedControl, SkeletonRow } from './ui'

type Source = 'menu' | 'manual'

export interface LogMealSheetProps {
  locations: Location[]
  defaultLocationId: string | null
  onClose: () => void
  onLog: (entry: {
    slot: MealSlot
    title: string
    locationId: string | null
    locationName: string | null
    items: LoggedItem[]
  }) => void
}

export function LogMealSheet({
  locations,
  defaultLocationId,
  onClose,
  onLog,
}: LogMealSheetProps) {
  const [source, setSource] = useState<Source>('menu')
  const [slot, setSlot] = useState<MealSlot>(() => slotForTime())

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="scrim" role="presentation" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label="Log a meal" aria-modal="true">
        <header className="sheet-head">
          <h2>Log a meal</h2>
          <button type="button" className="icon-button ghost" onClick={onClose} aria-label="Close">
            <IconClose size={20} />
          </button>
        </header>

        <div className="sheet-body">
          <div className="field-block">
            <span className="eyebrow">Which meal?</span>
            <div className="chip-row wrap">
              {MEAL_SLOTS.map((entry) => {
                const Glyph = periodIcon(entry)
                return (
                  <FilterChip key={entry} active={slot === entry} onClick={() => setSlot(entry)}>
                    <Glyph size={15} aria-hidden="true" />
                    {entry}
                  </FilterChip>
                )
              })}
            </div>
          </div>

          <SegmentedControl
            label="Where the food came from"
            value={source}
            onChange={setSource}
            options={[
              { value: 'menu', label: 'From a dining hall' },
              { value: 'manual', label: 'Something else' },
            ]}
          />

          {source === 'menu' ? (
            <MenuPicker
              locations={locations}
              defaultLocationId={defaultLocationId}
              onPick={(item, location) => {
                onLog({
                  slot,
                  title: item.name ?? 'Meal',
                  locationId: location.id,
                  locationName: location.name,
                  items: [itemFromMenuItem(item)],
                })
                onClose()
              }}
            />
          ) : (
            <ManualEntry
              onSubmit={(entry) => {
                onLog({ slot, ...entry, locationId: null })
                onClose()
              }}
            />
          )}
        </div>
      </aside>
    </>
  )
}

/* ----------------------------------------------------------- menu picker */

function MenuPicker({
  locations,
  defaultLocationId,
  onPick,
}: {
  locations: Location[]
  defaultLocationId: string | null
  onPick: (item: MenuItem, location: Location) => void
}) {
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations[0]?.id ?? '')
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [periods, setPeriods] = useState<Array<{ id: string; name: string | null }>>([])
  const [items, setItems] = useState<MenuItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const date = todayISO()

  const location = locations.find((entry) => entry.id === locationId) ?? null

  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])
    api
      .periods(locationId, date)
      .then((payload) => {
        if (cancelled) return
        setPeriods(payload.periods)
        setPeriodId(payload.periods[0]?.id ?? null)
        if (payload.periods.length === 0) setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof ApiError ? cause.message : 'Could not load this hall.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [locationId, date])

  useEffect(() => {
    if (!locationId || !periodId) return
    let cancelled = false
    setLoading(true)
    api
      .menu(locationId, date, periodId)
      .then((payload) => {
        if (!cancelled) setItems(payload.items)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Could not load the menu.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [locationId, periodId, date])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    const rows = query
      ? items.filter((item) => (item.name ?? '').toLowerCase().includes(query))
      : items
    return rows.slice(0, 60)
  }, [items, search])

  return (
    <>
      <div className="field-block">
        <label className="eyebrow" htmlFor="log-location">
          Dining hall
        </label>
        <select
          id="log-location"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        >
          {locations.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>

      {periods.length > 0 && (
        <div className="chip-row scroll" role="group" aria-label="Meal period">
          {periods.map((period) => (
            <FilterChip
              key={period.id}
              active={period.id === periodId}
              onClick={() => setPeriodId(period.id)}
            >
              {period.name ?? 'Menu'}
            </FilterChip>
          ))}
        </div>
      )}

      <label className="search-field">
        <IconSearch size={17} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search this menu…"
          aria-label="Search this menu"
          type="search"
        />
      </label>

      {error && (
        <p className="form-error standalone">
          <IconWarn size={15} /> {error}
        </p>
      )}

      {loading ? (
        <div className="stack">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={IconSearch} title="Nothing to show">
          {periods.length === 0
            ? 'This hall has no menu published for today.'
            : 'No items match that search.'}
        </EmptyState>
      ) : (
        <ul className="pick-list">
          {filtered.map((item, index) => {
            const Glyph = foodIcon(item.name, item.category)
            return (
              <li key={`${item.id ?? item.name}-${index}`}>
                <button
                  type="button"
                  className="pick-row"
                  onClick={() => location && onPick(item, location)}
                >
                  <span className="food-tile" aria-hidden="true">
                    <Glyph size={20} />
                  </span>
                  <span className="pick-body">
                    <span className="pick-name">{item.name}</span>
                    <span className="pick-macros">
                      {item.calories !== null ? `${Math.round(item.calories)} kcal` : 'No nutrition'}
                      {item.protein_g !== null && ` · ${Math.round(item.protein_g)}g protein`}
                    </span>
                  </span>
                  <IconPlus size={18} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/* --------------------------------------------------------- manual entry */

function ManualEntry({
  onSubmit,
}: {
  onSubmit: (entry: { title: string; locationName: string | null; items: LoggedItem[] }) => void
}) {
  const [name, setName] = useState('')
  const [calories, setCalories] = useState('')
  const [protein, setProtein] = useState('')
  const [where, setWhere] = useState('')

  const valid = name.trim().length > 0 && Number(calories) > 0

  return (
    <form
      className="manual-entry"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        onSubmit({
          title: name.trim(),
          locationName: where.trim() || null,
          items: [
            {
              itemId: null,
              name: name.trim(),
              category: null,
              portion: null,
              servings: 1,
              calories: Number(calories),
              protein_g: protein ? Number(protein) : null,
              carbs_g: null,
              fat_g: null,
              fiber_g: null,
              sodium_mg: null,
            },
          ],
        })
      }}
    >
      <p className="setting-hint">
        <IconWarn size={14} aria-hidden="true" />
        These numbers are yours, not the dining hall's — everything logged from a menu is computed
        from the real nutrition payload.
      </p>

      <label className="field">
        <span>What did you eat?</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Chicken burrito"
          required
        />
      </label>

      <div className="field-pair">
        <label className="field">
          <span>
            <IconCalories size={14} aria-hidden="true" /> Calories
          </span>
          <input
            type="number"
            min={0}
            max={5000}
            value={calories}
            onChange={(event) => setCalories(event.target.value)}
            placeholder="650"
            required
          />
        </label>
        <label className="field">
          <span>
            <IconProtein size={14} aria-hidden="true" /> Protein (g)
          </span>
          <input
            type="number"
            min={0}
            max={400}
            value={protein}
            onChange={(event) => setProtein(event.target.value)}
            placeholder="35"
          />
        </label>
      </div>

      <label className="field">
        <span>Where? (optional)</span>
        <input
          value={where}
          onChange={(event) => setWhere(event.target.value)}
          placeholder="Off campus"
        />
      </label>

      <button type="submit" className="button primary block" disabled={!valid}>
        <IconCheck size={16} />
        Log it
      </button>
    </form>
  )
}
