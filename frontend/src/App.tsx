import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from './api/client'
import type { Location, MenuItem, Plan } from './api/types'
import { AdvisorScreen } from './components/AdvisorScreen'
import { AppShell, useTab } from './components/AppShell'
import { AuthScreen } from './components/AuthScreen'
import { DiningScreen } from './components/DiningScreen'
import { LogMealSheet } from './components/LogMealSheet'
import { MealsScreen } from './components/MealsScreen'
import { ProfileScreen } from './components/ProfileScreen'
import { todayISO } from './lib/dates'
import { interpret, type Interpretation } from './lib/parse'
import { useAdvisor } from './state/advisor'
import { AuthProvider, useAuth } from './state/auth'
import { useAvailability } from './state/availability'
import { usePlanBoard } from './state/board'
import { useDining, type Hall } from './state/dining'
import {
  itemFromMenuItem,
  itemFromPlannedItem,
  useMealLog,
  type LoggedItem,
  type MealSlot,
} from './state/meals'
import { useProfile } from './state/profile'

interface Health {
  gemini: { configured: boolean; model: string | null }
  database: { connected: boolean; error: string | null }
}

/** Dining commons publish full menus; retail stands often publish one period. */
function defaultLocationId(locations: Location[]): string | null {
  const commons = locations.find((location) => /dining commons/i.test(location.name))
  return commons?.id ?? locations[0]?.id ?? null
}

function UniBite() {
  const { user } = useAuth()
  const [tab, setTab] = useTab()

  const [locations, setLocations] = useState<Location[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [pendingHallId, setPendingHallId] = useState<string | null>(null)

  // Week-planner state, still owned here so the board survives a tab switch.
  const [query, setQuery] = useState('')
  const [overrides, setOverrides] = useState<Partial<Interpretation>>({})

  const { profile, ...profileRest } = useProfile(user?.id ?? null, user?.email ?? null)
  const profileStore = { profile, ...profileRest }
  const log = useMealLog(user?.id ?? null)
  const advisor = useAdvisor()
  const dining = useDining(locations, loadError)
  const { board, busy, generate, refine, clear } = usePlanBoard(user?.id ?? null)

  useEffect(() => {
    api
      .locations()
      .then((payload) => {
        setLocations(payload)
        setLoadError(null)
      })
      .catch((error: unknown) =>
        setLoadError(
          error instanceof Error ? error.message : 'Could not load dining locations.',
        ),
      )
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  const today = todayISO()
  const consumed = log.totalsFor(today)

  /* ----------------------------------------------------------- advisor */

  const onAsk = useCallback(
    (question: string) => {
      void advisor.ask(question, {
        profile,
        consumed,
        locations,
        fallbackLocationId: defaultLocationId(locations),
      })
    },
    [advisor, profile, consumed, locations],
  )

  /** Plans already written into the log, so the button can read "Added". */
  const loggedPlanIds = useMemo(
    () => new Set(log.meals.map((meal) => meal.planId).filter((id): id is string => Boolean(id))),
    [log.meals],
  )

  const onLogPlan = useCallback(
    (plan: Plan, locationName: string | null, slot: MealSlot) => {
      const meal = plan.content.meals[0]
      if (!meal) return
      log.log({
        date: plan.plan_date,
        slot,
        title: plan.content.title,
        locationId: plan.sources.location_id ?? null,
        locationName: locationName ?? plan.sources.location_name ?? null,
        items: meal.items.map(itemFromPlannedItem),
        note: null,
        planId: plan.id,
      })
    },
    [log],
  )

  /* ------------------------------------------------------------ dining */

  /** Menu items logged today, keyed so a quick-add button can show its state. */
  const loggedItemKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const meal of log.meals) {
      if (meal.date !== today || !meal.locationId) continue
      for (const item of meal.items) {
        keys.add(`${meal.locationId}:${item.itemId ?? item.name}`)
      }
    }
    return keys
  }, [log.meals, today])

  const onQuickAdd = useCallback(
    (item: MenuItem, hall: Hall, slot: MealSlot) => {
      log.log({
        date: today,
        slot,
        title: item.name ?? 'Item',
        locationId: hall.id,
        locationName: hall.name,
        items: [itemFromMenuItem(item)],
        note: null,
        planId: null,
      })
    },
    [log, today],
  )

  const onManualLog = useCallback(
    (entry: {
      slot: MealSlot
      title: string
      locationId: string | null
      locationName: string | null
      items: LoggedItem[]
    }) => {
      log.log({ date: today, note: null, planId: null, ...entry })
    },
    [log, today],
  )

  /* ------------------------------------------------------ week planner */

  const auto = useMemo<Interpretation>(
    () =>
      interpret(query, locations, {
        fallbackLocationId:
          board?.locationId ?? profile.favoriteLocationIds[0] ?? defaultLocationId(locations),
      }),
    [query, locations, board?.locationId, profile.favoriteLocationIds],
  )

  const spec = useMemo<Interpretation>(() => ({ ...auto, ...overrides }), [auto, overrides])

  const onGenerate = useCallback(() => {
    const location = locations.find((entry) => entry.id === spec.locationId)
    if (!location || spec.dates.length === 0) return
    void generate({ ...spec, locationId: location.id, locationName: location.name })
  }, [generate, locations, spec])

  const availability = useAvailability(spec.locationId, spec.dates, spec.periods)

  /* --------------------------------------------------------------- ui */

  return (
    <AppShell tab={tab} onTabChange={setTab} displayName={profile.displayName || user?.email || '?'}>
      {tab === 'advisor' && (
        <AdvisorScreen
          profile={profile}
          consumed={consumed}
          locations={locations}
          halls={dining.halls}
          advisor={advisor}
          onAsk={onAsk}
          onLogPlan={onLogPlan}
          loggedPlanIds={loggedPlanIds}
        />
      )}

      {tab === 'dining' && (
        <DiningScreen
          dining={dining}
          profile={profile}
          onQuickAdd={onQuickAdd}
          loggedItemKeys={loggedItemKeys}
          openHallId={pendingHallId}
          onOpenHallHandled={() => setPendingHallId(null)}
        />
      )}

      {tab === 'meals' && (
        <MealsScreen
          profile={profile}
          log={log}
          onAddManual={() => setSheetOpen(true)}
          board={board}
          busy={busy}
          query={query}
          onQueryChange={setQuery}
          spec={spec}
          locations={locations}
          onSpecChange={(patch) => setOverrides((current) => ({ ...current, ...patch }))}
          onGenerate={onGenerate}
          onResetSpec={() => setOverrides({})}
          specEdited={Object.keys(overrides).length > 0}
          availability={availability}
          onClearBoard={clear}
          onRefine={(dates, instruction) => void refine(dates, instruction)}
        />
      )}

      {tab === 'profile' && (
        <ProfileScreen store={profileStore} locations={locations} gemini={health?.gemini ?? null} />
      )}

      {sheetOpen && (
        <LogMealSheet
          locations={locations}
          defaultLocationId={profile.favoriteLocationIds[0] ?? defaultLocationId(locations)}
          onClose={() => setSheetOpen(false)}
          onLog={onManualLog}
        />
      )}
    </AppShell>
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
  return user ? <UniBite /> : <AuthScreen />
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  )
}
