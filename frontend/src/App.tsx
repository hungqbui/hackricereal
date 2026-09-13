import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from './api/client'
import type { Location } from './api/types'
import { AuthScreen } from './components/AuthScreen'
import { Composer } from './components/Composer'
import { DayDetail } from './components/DayDetail'
import { WeekBoard } from './components/WeekBoard'
import { describeRange } from './lib/dates'
import { interpret, type Interpretation } from './lib/parse'
import { AuthProvider, useAuth } from './state/auth'
import { usePlanBoard } from './state/board'

interface Health {
  gemini: { configured: boolean; model: string | null }
  database: { connected: boolean; error: string | null }
}

/** Dining commons publish full menus; retail stands often publish one period. */
function defaultLocationId(locations: Location[]): string | null {
  const commons = locations.find((location) => /dining commons/i.test(location.name))
  return commons?.id ?? locations[0]?.id ?? null
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  const { user, logout } = useAuth()

  return (
    <div className="profile-menu">
      <p className="profile-email">{user?.email}</p>
      <div className="profile-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
        <button type="button" className="link danger" onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  )
}

function Planner() {
  const { user } = useAuth()
  const [locations, setLocations] = useState<Location[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [query, setQuery] = useState('')
  const [overrides, setOverrides] = useState<Partial<Interpretation>>({})
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)

  const { board, busy, generate, refine, clear } = usePlanBoard(user?.id ?? null)

  useEffect(() => {
    api
      .locations()
      .then(setLocations)
      .catch((error: unknown) =>
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Could not load dining locations.',
        ),
      )
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  const auto = useMemo<Interpretation>(
    () =>
      interpret(query, locations, {
        fallbackLocationId: board?.locationId ?? defaultLocationId(locations),
      }),
    [query, locations, board?.locationId],
  )

  const spec = useMemo<Interpretation>(() => ({ ...auto, ...overrides }), [auto, overrides])
  const edited = Object.keys(overrides).length > 0

  const onSubmit = useCallback(() => {
    const location = locations.find((entry) => entry.id === spec.locationId)
    if (!location || spec.dates.length === 0) return
    setSelectedDate(null)
    void generate({ ...spec, locationId: location.id, locationName: location.name })
  }, [generate, locations, spec])

  const selectedDay = board?.days.find((day) => day.date === selectedDate) ?? null

  return (
    <div className="app">
      <header className="topbar">
        <p className="brand">
          Cougar<span>Grub</span>
        </p>

        {board && (
          <p className="topbar-context">
            <strong>{board.locationName}</strong>
            <span>{describeRange(board.days.map((day) => day.date))}</span>
          </p>
        )}

        <div className="topbar-actions">
          {board && (
            <button
              type="button"
              className="button"
              onClick={() => {
                clear()
                setSelectedDate(null)
              }}
            >
              New plan
            </button>
          )}
          <button
            type="button"
            className="button ghost"
            onClick={() => setProfileOpen((open) => !open)}
            aria-expanded={profileOpen}
          >
            {user?.email?.split('@')[0] || 'Account'}
          </button>
          {profileOpen && <ProfileMenu onClose={() => setProfileOpen(false)} />}
        </div>
      </header>

      {health && !health.gemini.configured && (
        <p className="banner topbanner">
          The backend has no <code>GEMINI_API_KEY</code>, so plans come from the
          deterministic offline planner and refinement is disabled. Menus and
          macros are still live.
        </p>
      )}

      <main className="main">
        {loadError && <p className="form-error standalone">{loadError}</p>}

        <Composer
          query={query}
          onQueryChange={setQuery}
          spec={spec}
          locations={locations}
          onChange={(patch) => setOverrides((current) => ({ ...current, ...patch }))}
          onSubmit={onSubmit}
          onReset={() => setOverrides({})}
          edited={edited}
          busy={busy}
          compact={Boolean(board)}
        />

        {board ? (
          <WeekBoard
            board={board}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
          />
        ) : (
          <section className="hero">
            <h1>Eat well on the meal plan, without reading a menu.</h1>
            <p>
              Describe a day or a week in plain English. CougarGrub reads the
              live University of Houston dining menus, picks real items that fit
              your macros, and lets you talk it into something better.
            </p>
          </section>
        )}
      </main>

      {board && selectedDay?.plan && (
        <DayDetail
          day={selectedDay}
          board={board}
          busy={busy}
          onClose={() => setSelectedDate(null)}
          onRefine={(dates, instruction) => void refine(dates, instruction)}
        />
      )}
    </div>
  )
}

function Root() {
  const { user, ready } = useAuth()
  if (!ready) {
    return (
      <div className="splash">
        <span className="spinner" aria-hidden="true" />
      </div>
    )
  }
  return user ? <Planner /> : <AuthScreen />
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  )
}
