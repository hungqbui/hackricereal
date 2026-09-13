/**
 * Dining — browse what campus is actually serving.
 *
 * Two levels in one screen, since the app has no router: a hall list, and the
 * menu for one hall. Everything shown is live — `GET /dining/locations`,
 * `/details` for the open/closed sentence, `/periods` for the meal tabs and
 * `/menu` for the items and their macros.
 *
 * Every item row carries a quick-add that writes straight into the meal log,
 * so browsing to logging is two taps.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api/client'
import type { Menu, MenuItem, Period } from '../api/types'
import { todayISO } from '../lib/dates'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import { byOpenness, type DiningStore, type Hall, type OpenState } from '../state/dining'
import { slotForPeriod, type MealSlot } from '../state/meals'
import type { StudentProfile } from '../state/profile'
import {
  IconAllergen,
  IconCalories,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconPin,
  IconPlus,
  IconProtein,
  IconSearch,
  IconWarn,
  dietIcon,
  foodIcon,
  periodIcon,
} from './icons'
import { EmptyState, FilterChip, SkeletonRow } from './ui'

type HallFilter = 'now' | 'later' | 'all'

const HALL_FILTERS: Array<{ value: HallFilter; label: string }> = [
  { value: 'now', label: 'Now' },
  { value: 'later', label: 'Later' },
  { value: 'all', label: 'All Dining Halls' },
]

export interface DiningScreenProps {
  dining: DiningStore
  profile: StudentProfile
  onQuickAdd: (item: MenuItem, hall: Hall, slot: MealSlot) => void
  loggedItemKeys: Set<string>
  /** Set when another tab asked to open a specific hall. */
  openHallId: string | null
  onOpenHallHandled: () => void
}

export function DiningScreen({
  dining,
  profile,
  onQuickAdd,
  loggedItemKeys,
  openHallId,
  onOpenHallHandled,
}: DiningScreenProps) {
  const [filter, setFilter] = useState<HallFilter>('now')
  const [building, setBuilding] = useState<string>('all')
  const [openHall, setOpenHall] = useState<Hall | null>(null)

  // Another tab ("see the menu") can push a hall open.
  useEffect(() => {
    if (!openHallId) return
    const hall = dining.halls.find((entry) => entry.id === openHallId)
    if (hall) setOpenHall(hall)
    onOpenHallHandled()
  }, [openHallId, dining.halls, onOpenHallHandled])

  const visible = useMemo(() => {
    let halls = [...dining.halls]
    if (building !== 'all') halls = halls.filter((hall) => hall.building === building)
    if (filter === 'now') {
      halls = halls.filter(
        (hall) => hall.status.state === 'open' || hall.status.state === 'closing',
      )
    } else if (filter === 'later') {
      halls = halls.filter((hall) => hall.status.state === 'closed')
    }
    return halls.sort(byOpenness)
  }, [dining.halls, filter, building])

  if (openHall) {
    return (
      <HallMenu
        hall={openHall}
        profile={profile}
        onBack={() => setOpenHall(null)}
        onQuickAdd={onQuickAdd}
        loggedItemKeys={loggedItemKeys}
      />
    )
  }

  return (
    <div className="screen dining-screen">
      <header className="screen-head">
        <h1>Dining</h1>
        <label className="campus-select">
          <IconPin size={15} aria-hidden="true" />
          <select
            value={building}
            onChange={(event) => setBuilding(event.target.value)}
            aria-label="Filter by building"
          >
            <option value="all">All of campus</option>
            {dining.buildings.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="chip-row scroll" role="group" aria-label="Availability filter">
        {HALL_FILTERS.map((option) => (
          <FilterChip
            key={option.value}
            active={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </FilterChip>
        ))}
      </div>

      {dining.error && (
        <p className="form-error standalone">
          <IconWarn size={15} /> {dining.error}
        </p>
      )}

      {dining.halls.length === 0 && !dining.error ? (
        <div className="stack">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={IconClock}
          title={filter === 'now' ? 'Nothing is open right now' : 'No halls here'}
        >
          {filter === 'now'
            ? 'Try “Later” to see what opens next, or pick another building.'
            : 'Try another building, or switch the filter.'}
        </EmptyState>
      ) : (
        <ul className="hall-list">
          {visible.map((hall) => (
            <li key={hall.id}>
              <DiningHallCard
                hall={hall}
                favourite={profile.favoriteLocationIds.includes(hall.id)}
                onOpen={() => setOpenHall(hall)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * First *letter*, not first character. Several UH halls are named "24/7 Cougar
 * Woods…", and a tile reading "2" tells the student nothing.
 */
function hallInitial(name: string): string {
  const letter = name.match(/[a-z]/i)
  return letter ? letter[0].toUpperCase() : '?'
}

/* ------------------------------------------------------------- hall card */

export function DiningHallCard({
  hall,
  favourite,
  onOpen,
}: {
  hall: Hall
  favourite: boolean
  onOpen: () => void
}) {
  return (
    <button type="button" className="hall-card" onClick={onOpen}>
      <span className="hall-mark" aria-hidden="true">
        {hallInitial(hall.name)}
      </span>
      <span className="hall-body">
        <span className="hall-title">
          {hall.name}
          {favourite && <em className="hall-fav">Favourite</em>}
        </span>
        {hall.building && <span className="hall-building">{hall.building}</span>}
        <StatusChip state={hall.status.state} text={hall.status.chip} loading={hall.loading} />
      </span>
      <IconChevronRight size={18} aria-hidden="true" />
    </button>
  )
}

/**
 * Open/closing/closed, carried by a dot **and** the words — never colour
 * alone, which the acceptance spec calls out explicitly.
 */
function StatusChip({
  state,
  text,
  loading,
}: {
  state: OpenState
  text: string
  loading?: boolean
}) {
  if (loading) {
    return (
      <span className="status-chip loading">
        <span className="status-dot" aria-hidden="true" />
        Checking hours…
      </span>
    )
  }
  return (
    <span className={`status-chip ${state}`}>
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  )
}

/* ------------------------------------------------------------- hall menu */

function HallMenu({
  hall,
  profile,
  onBack,
  onQuickAdd,
  loggedItemKeys,
}: {
  hall: Hall
  profile: StudentProfile
  onBack: () => void
  onQuickAdd: (item: MenuItem, hall: Hall, slot: MealSlot) => void
  loggedItemKeys: Set<string>
}) {
  const [periods, setPeriods] = useState<Period[] | null>(null)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [category, setCategory] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const list = useRef<HTMLUListElement>(null)
  const date = todayISO()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .periods(hall.id, date)
      .then((payload) => {
        if (cancelled) return
        setPeriods(payload.periods)
        setPeriodId((current) => current ?? payload.periods[0]?.id ?? null)
        if (payload.periods.length === 0) setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof ApiError ? cause.message : 'Could not load meal periods.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hall.id, date])

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setCategory('all')
    api
      .menu(hall.id, date, periodId)
      .then((payload) => {
        if (!cancelled) setMenu(payload)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : 'Could not load this menu.')
          setMenu(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hall.id, date, periodId])

  useGSAP(
    () => {
      if (loading) return
      gsap.from('li', { y: 10, opacity: 0, duration: DUR.base, ease: EASE.out, stagger: STAGGER })
    },
    { dependencies: [loading, menu, category], scope: list },
  )

  const categories = useMemo(() => {
    const names = (menu?.categories ?? []).filter((name): name is string => Boolean(name))
    return [...new Set(names)]
  }, [menu])

  const items = useMemo(() => {
    let rows = menu?.items ?? []
    if (category !== 'all') rows = rows.filter((item) => item.category === category)
    const query = search.trim().toLowerCase()
    if (query) {
      rows = rows.filter((item) => (item.name ?? '').toLowerCase().includes(query))
    }
    return rows
  }, [menu, category, search])

  const slot = slotForPeriod(menu?.period_name ?? periods?.find((p) => p.id === periodId)?.name)

  /** Allergens the student listed, matched against the item's own tags. */
  const conflicts = (item: MenuItem): string[] =>
    item.allergens.filter((allergen) =>
      profile.allergies.some(
        (listed) => listed.toLowerCase() === allergen.toLowerCase(),
      ),
    )

  return (
    <div className="screen hall-menu-screen">
      <header className="screen-head with-back">
        <button type="button" className="icon-button ghost" onClick={onBack} aria-label="Back to dining halls">
          <IconChevronLeft size={20} />
        </button>
        <div className="screen-head-titles">
          <h1>{hall.name}</h1>
          <StatusChip state={hall.status.state} text={hall.status.chip} />
        </div>
      </header>

      {periods && periods.length > 0 && (
        <div className="chip-row scroll" role="group" aria-label="Meal period">
          {periods.map((period) => {
            const Glyph = periodIcon(period.name)
            return (
              <FilterChip
                key={period.id}
                active={period.id === periodId}
                onClick={() => setPeriodId(period.id)}
              >
                <Glyph size={15} aria-hidden="true" />
                {period.name ?? 'Menu'}
              </FilterChip>
            )
          })}
        </div>
      )}

      {categories.length > 1 && (
        <div className="chip-row scroll" role="group" aria-label="Menu category">
          <FilterChip active={category === 'all'} onClick={() => setCategory('all')}>
            All
          </FilterChip>
          {categories.map((name) => (
            <FilterChip key={name} active={category === name} onClick={() => setCategory(name)}>
              {name}
            </FilterChip>
          ))}
        </div>
      )}

      {menu && menu.items.length > 8 && (
        <label className="search-field">
          <IconSearch size={17} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${menu.period_name ?? 'this menu'}…`}
            aria-label="Search this menu"
            type="search"
          />
        </label>
      )}

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
          <SkeletonRow />
        </div>
      ) : menu?.closed ? (
        /* Upstream still lists the period on a day the hall is shut, so this
           has to be checked before "nothing matches" would claim it. */
        <EmptyState icon={IconClock} title="Closed this day">
          {hall.name} is not serving on {date}.
        </EmptyState>
      ) : periods && periods.length === 0 ? (
        <EmptyState icon={IconClock} title="No menu published for today">
          {hall.name} has not posted anything for {date}. Menus usually appear a couple of weeks
          ahead.
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={IconSearch} title="Nothing matches">
          {search ? `No items match “${search}”.` : 'This category is empty right now.'}
        </EmptyState>
      ) : (
        <ul className="menu-list" ref={list}>
          {items.map((item, index) => (
            <li key={`${item.id ?? item.name}-${index}`}>
              <MenuItemRow
                item={item}
                allergenConflicts={conflicts(item)}
                logged={loggedItemKeys.has(itemKey(item, hall.id))}
                onAdd={() => onQuickAdd(item, hall, slot)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Stable identity for "already logged today", since menu ids can be null. */
export function itemKey(item: MenuItem, locationId: string): string {
  return `${locationId}:${item.id ?? item.name ?? 'unknown'}`
}

/* -------------------------------------------------------------- item row */

export function MenuItemRow({
  item,
  onAdd,
  logged,
  allergenConflicts,
}: {
  item: MenuItem
  onAdd: () => void
  logged: boolean
  allergenConflicts: string[]
}) {
  const Glyph = foodIcon(item.name, item.category)
  const unavailable = item.calories === null && item.protein_g === null

  return (
    <div className={`menu-item${logged ? ' logged' : ''}${unavailable ? ' unavailable' : ''}`}>
      <span className="food-tile" aria-hidden="true">
        <Glyph size={22} />
      </span>

      <div className="menu-item-body">
        <p className="menu-item-name">{item.name ?? 'Unnamed item'}</p>
        <p className="menu-item-macros">
          {item.calories !== null ? (
            <>
              <IconCalories size={13} aria-hidden="true" />
              {Math.round(item.calories)} kcal
            </>
          ) : (
            <span className="muted">Nutrition not published</span>
          )}
          {item.protein_g !== null && (
            <>
              <span className="dot" aria-hidden="true" />
              <IconProtein size={13} aria-hidden="true" />
              {Math.round(item.protein_g)}g protein
            </>
          )}
          {item.portion && (
            <>
              <span className="dot" aria-hidden="true" />
              {/* Labelled: a bare "552g" next to a calorie count reads as protein. */}
              <span className="portion">{item.portion} serving</span>
            </>
          )}
        </p>

        {(item.tags.length > 0 || allergenConflicts.length > 0) && (
          <p className="menu-item-tags">
            {item.tags.slice(0, 3).map((tag) => {
              const TagGlyph = dietIcon(tag)
              return (
                <span key={tag} className="tag">
                  <TagGlyph size={12} aria-hidden="true" />
                  {tag}
                </span>
              )
            })}
            {allergenConflicts.length > 0 && (
              <span
                className="tag danger"
                title={`You listed ${allergenConflicts.join(', ')} as an allergy`}
              >
                <IconAllergen size={12} aria-hidden="true" />
                Contains {allergenConflicts.join(', ')}
              </span>
            )}
          </p>
        )}
      </div>

      <button
        type="button"
        className={`icon-button add${logged ? ' done' : ''}`}
        onClick={onAdd}
        disabled={logged}
        aria-label={logged ? `${item.name} already logged` : `Log ${item.name}`}
        title={logged ? 'Already logged today' : 'Add to my meals'}
      >
        {logged ? <IconCheck size={18} /> : <IconPlus size={18} />}
      </button>
    </div>
  )
}
