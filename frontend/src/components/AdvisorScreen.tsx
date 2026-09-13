/**
 * Advisor — the home tab.
 *
 * Deliberately uncluttered: a greeting, today's numbers, what campus is
 * serving right now, four prompts, and the composer. Nothing else. The
 * multi-day planner lives under My Meals → This Week, so this screen never has
 * to explain two ideas at once.
 *
 * Idle shows the snapshot; asking a question replaces it with the conversation
 * and the recommendation card.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { Location, Plan } from '../api/types'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import type { AdvisorMessage, AdvisorStore } from '../state/advisor'
import { quickPrompts } from '../state/advisor'
import type { Board } from '../state/board'
import type { DayTotals, MealSlot } from '../state/meals'
import { slotForPeriod } from '../state/meals'
import type { Hall } from '../state/dining'
import { preferenceTags, type StudentProfile } from '../state/profile'
import { ScheduleChangeCard } from './ScheduleChangeCard'
import {
  IconCalories,
  IconClock,
  IconDining,
  IconLeaf,
  IconMic,
  IconPin,
  IconPlus,
  IconProtein,
  IconSend,
  IconSpark,
  IconWarn,
  foodIcon,
  periodIcon,
} from './icons'
import { Card, InsightCard, ProgressRing, SuggestionChip } from './ui'

export interface AdvisorScreenProps {
  profile: StudentProfile
  consumed: DayTotals
  locations: Location[]
  halls: Hall[]
  advisor: AdvisorStore
  onAsk: (question: string) => void
  onLogPlan: (plan: Plan, locationName: string | null, slot: MealSlot) => void
  loggedPlanIds: Set<string>
  /** The week's plan, so suggestions can offer to edit it. */
  board: Board | null
  onConfirmChange: (messageId: string) => void
  onDeclineChange: (messageId: string) => void
}

/** The recommendation card lists at most this many items before summarising. */
const MAX_CARD_ITEMS = 5

/**
 * The heading on the recommendation card.
 *
 * Gemini titles a plan with something a student would say. The offline planner
 * titles every plan "Balanced day (offline planner)", which says nothing about
 * a card for one meal. In that case a single pick is named after itself, and a
 * tray of several is named after the period. The hall is not repeated here —
 * the line underneath already carries it.
 */
function cardTitle(plan: Plan, periodName: string | null): string {
  const title = plan.content.title ?? ''
  if (plan.model !== 'fallback-greedy' && !/offline planner/i.test(title) && title.trim()) {
    return title
  }
  const items = plan.content.meals[0]?.items ?? []
  if (items.length === 1 && items[0].name) return items[0].name
  if (periodName) return `Your ${periodName.toLowerCase()}`
  return 'Your next meal'
}

/** "Good morning" / "Good afternoon" / "Good evening", by the clock. */
function greeting(at = new Date()): string {
  const hour = at.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function AdvisorScreen({
  profile,
  consumed,
  locations,
  halls,
  advisor,
  onAsk,
  onLogPlan,
  loggedPlanIds,
  board,
  onConfirmChange,
  onDeclineChange,
}: AdvisorScreenProps) {
  const [draft, setDraft] = useState('')
  const thread = useRef<HTMLDivElement>(null)
  const snapshot = useRef<HTMLDivElement>(null)
  const conversing = advisor.messages.length > 0

  // The hall to name in the context card: a favourite that is open, else any
  // open hall, else the first favourite so the card still says something.
  const contextHall = useMemo(() => {
    const favourites = profile.favoriteLocationIds
      .map((id) => halls.find((hall) => hall.id === id))
      .filter((hall): hall is Hall => Boolean(hall))
    return (
      favourites.find((hall) => hall.status.state === 'open') ??
      halls.find((hall) => hall.status.state === 'open' && /dining commons/i.test(hall.name)) ??
      halls.find((hall) => hall.status.state === 'open') ??
      favourites[0] ??
      null
    )
  }, [halls, profile.favoriteLocationIds])

  // useGSAP, not a bare useEffect: it reverts its tweens on cleanup, so
  // StrictMode's double-invoked effect cannot read a half-faded element as the
  // start value and strand the section at opacity 0.
  useGSAP(
    () => {
      if (conversing) return
      gsap.from('[data-stagger]', {
        y: 14,
        opacity: 0,
        duration: DUR.base,
        ease: EASE.out,
        stagger: STAGGER,
      })
    },
    { dependencies: [conversing], scope: snapshot },
  )

  useEffect(() => {
    if (!thread.current) return
    thread.current.scrollTop = thread.current.scrollHeight
  }, [advisor.messages.length, advisor.state])

  const submit = () => {
    const text = draft.trim()
    if (!text || advisor.state === 'thinking') return
    setDraft('')
    onAsk(text)
  }

  const caloriesLeft = Math.max(0, profile.calorieGoal - consumed.calories)
  const proteinLeft = Math.max(0, profile.proteinGoal - consumed.protein_g)

  return (
    <div className={`screen advisor-screen${conversing ? '' : ' idle'}`}>
      {!conversing ? (
        <div className="advisor-idle" ref={snapshot}>
          <header className="greeting" data-stagger>
            <h1>
              {greeting()}, {profile.displayName || 'there'} <span aria-hidden="true">👋</span>
            </h1>
            <p>Here's your dining snapshot for today.</p>
          </header>

          {/* On desktop this column becomes the sticky context sidebar. */}
          <aside className="advisor-aside" aria-label="Today at a glance">
            <Card className="summary-card" data-stagger>
              <div className="summary-card-inner">
                <ProgressRing
                  value={consumed.calories}
                  target={profile.calorieGoal}
                  display={consumed.calories.toLocaleString()}
                  caption="kcal"
                  size={96}
                />
                <div className="summary-stats">
                  <div>
                    <span className="summary-stat-label">
                      <IconProtein size={15} aria-hidden="true" />
                      Protein
                    </span>
                    <strong>
                      {consumed.protein_g} <span>/ {profile.proteinGoal}g</span>
                    </strong>
                  </div>
                  <div>
                    <span className="summary-stat-label">
                      <IconDining size={15} aria-hidden="true" />
                      Meals
                    </span>
                    <strong>
                      {consumed.meals} <span>/ 3</span>
                    </strong>
                  </div>
                </div>
              </div>
            </Card>

            {contextHall && (
              <Card tone="soft" className="context-card" data-stagger>
                <span className="context-icon" aria-hidden="true">
                  <IconPin size={20} />
                </span>
                <div>
                  <strong>
                    {contextHall.name} — {contextHall.status.chip.toLowerCase()}.
                  </strong>
                  <p>Want me to help you plan your meal?</p>
                </div>
              </Card>
            )}

            {consumed.meals > 0 && (
              <div data-stagger>
                <InsightCard icon={IconLeaf} title="You're on track!">
                  {caloriesLeft} calories and {proteinLeft}g protein left to hit today's goals.
                </InsightCard>
              </div>
            )}
          </aside>

          <section className="quick-prompts" data-stagger>
            <h2 className="eyebrow">Suggested for you</h2>
            {preferenceTags(profile).length > 0 && (
              <p className="pref-tags">
                <span>Planning around</span>
                {preferenceTags(profile).map((tag) => (
                  <em key={tag}>{tag}</em>
                ))}
              </p>
            )}
            <div className="chip-row wrap">
              {quickPrompts(profile, consumed, board).map((prompt) => (
                <SuggestionChip key={prompt} onClick={() => onAsk(prompt)}>
                  {prompt}
                </SuggestionChip>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="advisor-thread" ref={thread}>
          {advisor.messages.map((message) => (
            <MessageTurn
              key={message.id}
              message={message}
              consumed={consumed}
              profile={profile}
              onLog={onLogPlan}
              onAlternatives={() => void advisor.alternatives(message)}
              onConfirmChange={() => onConfirmChange(message.id)}
              onDeclineChange={() => onDeclineChange(message.id)}
              logged={message.plan ? loggedPlanIds.has(message.plan.id) : false}
              busy={advisor.state === 'thinking'}
            />
          ))}
          {advisor.state === 'thinking' && <TypingBubble />}
        </div>
      )}

      <form
        className="composer-bar"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="composer-field">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={conversing ? 'Ask a follow up…' : 'Ask about your next meal…'}
            aria-label="Ask the advisor about your next meal"
            enterKeyHint="send"
          />
          <button
            type="button"
            className="icon-button ghost"
            title="Voice input is not wired up yet"
            aria-label="Voice input (unavailable)"
            disabled
          >
            <IconMic size={19} />
          </button>
        </div>
        <button
          type="submit"
          className="icon-button primary"
          disabled={!draft.trim() || advisor.state === 'thinking'}
          aria-label="Send"
        >
          <IconSend size={19} />
        </button>
      </form>

      {locations.length === 0 && (
        <p className="form-error standalone">
          <IconWarn size={15} /> Campus dining list unavailable — is the backend running?
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ turns */

function MessageTurn({
  message,
  consumed,
  profile,
  onLog,
  onAlternatives,
  onConfirmChange,
  onDeclineChange,
  logged,
  busy,
}: {
  message: AdvisorMessage
  consumed: DayTotals
  profile: StudentProfile
  onLog: (plan: Plan, locationName: string | null, slot: MealSlot) => void
  onAlternatives: () => void
  onConfirmChange: () => void
  onDeclineChange: () => void
  logged: boolean
  busy: boolean
}) {
  if (message.role === 'user') {
    return (
      <div className="bubble-row user">
        <p className="bubble user">{message.text}</p>
      </div>
    )
  }

  return (
    <div className="bubble-row assistant">
      <span className="bubble-avatar" aria-hidden="true">
        <IconSpark size={16} />
      </span>
      <div className="bubble-stack">
        <p className={`bubble assistant${message.error ? ' error' : ''}`}>{message.text}</p>
        {message.plan && (
          <MealRecommendationCard
            plan={message.plan}
            locationName={message.locationName}
            consumed={consumed}
            profile={profile}
            onLog={onLog}
            onAlternatives={onAlternatives}
            logged={logged}
            busy={busy}
          />
        )}
        {message.change && (
          <ScheduleChangeCard
            change={message.change}
            onConfirm={onConfirmChange}
            onDecline={onDeclineChange}
          />
        )}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="bubble-row assistant">
      <span className="bubble-avatar" aria-hidden="true">
        <IconSpark size={16} />
      </span>
      <p className="bubble assistant typing" role="status" aria-label="Reading today's menu">
        <span />
        <span />
        <span />
      </p>
    </div>
  )
}

/* --------------------------------------------------- recommendation card */

export function MealRecommendationCard({
  plan,
  locationName,
  consumed,
  profile,
  onLog,
  onAlternatives,
  logged,
  busy,
}: {
  plan: Plan
  locationName: string | null
  consumed: DayTotals
  profile: StudentProfile
  onLog: (plan: Plan, locationName: string | null, slot: MealSlot) => void
  onAlternatives: () => void
  logged: boolean
  busy: boolean
}) {
  const card = useRef<HTMLDivElement>(null)
  const meal = plan.content.meals[0] ?? null
  const calories = Math.round(plan.content.totals.calories ?? 0)
  const protein = Math.round(plan.content.totals.protein_g ?? 0)
  /* `null` means no item in the meal published protein — UH omits it at a
     couple of locations. The API used to sum those omissions to 0.0, so the
     card had to inspect the items to tell "unpublished" from a real zero;
     `sum_macros` now reports it honestly and the total is signal enough. */
  const proteinKnown = plan.content.totals.protein_g != null
  const Glyph = foodIcon(meal?.items[0]?.name, meal?.items[0]?.category)
  const PeriodGlyph = periodIcon(meal?.period_name)
  const slot = slotForPeriod(meal?.period_name)

  useGSAP(
    () => {
      gsap.from(card.current, { y: 16, opacity: 0, duration: DUR.base, ease: EASE.out })
    },
    { dependencies: [plan.id], scope: card },
  )

  const projectedCalories = consumed.calories + calories
  const projectedProtein = consumed.protein_g + protein

  return (
    <div className="recommendation" ref={card}>
      <p className="recommendation-eyebrow">
        <PeriodGlyph size={14} aria-hidden="true" />
        Recommended for you
      </p>

      <div className="recommendation-head">
        <span className="food-tile large" aria-hidden="true">
          <Glyph size={30} />
        </span>
        <div>
          <h3>{cardTitle(plan, meal?.period_name ?? null)}</h3>
          {locationName && (
            <p className="recommendation-where">
              <IconPin size={13} aria-hidden="true" />
              {locationName}
            </p>
          )}
        </div>
      </div>

      {meal && meal.items.length > 0 && (
        <ul className="recommendation-items">
          {meal.items.slice(0, MAX_CARD_ITEMS).map((item, index) => (
            <li key={`${item.item_id ?? item.name}-${index}`}>
              <span>{item.name}</span>
              {item.servings !== 1 && <em>×{item.servings}</em>}
              <strong>{Math.round(item.calories ?? 0)} kcal</strong>
            </li>
          ))}
          {meal.items.length > MAX_CARD_ITEMS && (
            <li className="more">
              <span>+{meal.items.length - MAX_CARD_ITEMS} more on this tray</span>
            </li>
          )}
        </ul>
      )}

      <div className="recommendation-macros">
        <div>
          <IconCalories size={16} aria-hidden="true" />
          <strong>≈ {calories.toLocaleString()}</strong>
          <span>kcal</span>
        </div>
        <div>
          <IconProtein size={16} aria-hidden="true" />
          <strong>{proteinKnown ? `${protein}g` : '—'}</strong>
          <span>{proteinKnown ? 'protein' : 'protein not listed'}</span>
        </div>
        <div>
          <IconClock size={16} aria-hidden="true" />
          <strong>{meal?.period_name ?? 'Today'}</strong>
          <span>serving now</span>
        </div>
      </div>

      <p className="recommendation-projection">
        That would put you at about {projectedCalories.toLocaleString()} calories
        {proteinKnown ? ` and ${projectedProtein}g protein` : ''} for the day
        {projectedCalories <= profile.calorieGoal ? ', inside your goal.' : '.'}
      </p>

      {plan.model === 'fallback-greedy' && (
        <p className="recommendation-note">
          <IconWarn size={14} aria-hidden="true" />
          Picked by the offline planner — set a Gemini key for reasoned choices.
        </p>
      )}

      <div className="recommendation-actions">
        <button
          type="button"
          className="button primary block"
          onClick={() => onLog(plan, locationName, slot)}
          disabled={logged}
        >
          {logged ? 'Added to your meals' : <><IconPlus size={16} /> Add to my meals</>}
        </button>
        <button
          type="button"
          className="button block"
          onClick={onAlternatives}
          disabled={busy}
        >
          {busy ? 'Looking…' : 'See alternatives'}
        </button>
      </div>
    </div>
  )
}
