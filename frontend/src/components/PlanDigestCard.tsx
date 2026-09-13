/**
 * Saved plans, shown in the chat when the student asks for them.
 *
 * Days deal in one after another, their items cascade, and each day's totals
 * count up, so a week reads top to bottom. When a plan in the card is later
 * changed and confirmed, that day washes and its totals count to the new
 * numbers instead of the whole card replaying.
 *
 * The chips underneath are follow-ups about exactly these plans ("make them
 * lighter"). They go through the same propose → diff → confirm path as
 * anything typed.
 */

import { useRef } from 'react'

import type { Meal } from '../api/types'
import { friendlyDate } from '../lib/dates'
import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import type { PeriodName } from '../lib/parse'
import type { PlanDigest } from '../state/advisor'
import type { ChangeTarget } from '../state/changes'
import { IconCalendar, IconCalories, IconPin, IconProtein, periodIcon } from './icons'

const MAX_ITEMS_PER_MEAL = 4
const WASH = 'rgba(123, 170, 100, 0.28)'
const WASH_NONE = 'rgba(123, 170, 100, 0)'

const kcal = (value: number) => Math.round(value).toLocaleString()
const grams = (value: number) => `${Math.round(value)}g`

function inPeriods(meal: Meal, periods: PeriodName[]): boolean {
  if (periods.length === 0) return true
  const name = (meal.period_name ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return periods.some((period) => name.includes(period.toLowerCase().replace(/[^a-z]/g, '')))
}

export function PlanDigestCard({
  digest,
  onAsk,
  busy,
}: {
  digest: PlanDigest
  onAsk: (question: string) => void
  busy: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const one = digest.plans.length === 1
  const pronoun = one ? 'it' : 'them'
  const followUps = [
    `Make ${pronoun} higher protein`,
    `Make ${pronoun} lighter`,
    `Swap something in ${pronoun} for a vegetarian option`,
  ]

  useGSAP(
    () => {
      const pick = (selector: string) => gsap.utils.toArray<HTMLElement>(selector, root.current)
      const tl = gsap.timeline({ defaults: { ease: EASE.out } })
      tl.from(root.current, { y: 16, opacity: 0, scale: 0.985, duration: DUR.base })
        .from(pick('[data-digest-day]'), { y: 14, opacity: 0, duration: DUR.base, stagger: STAGGER.each * 2 }, '-=0.2')
        .from(pick('[data-digest-item]'), { x: -8, opacity: 0, duration: DUR.fast, stagger: 0.025 }, '-=0.3')
        .addLabel('totals', '-=0.2')

      for (const node of pick('[data-count-up]')) {
        const to = Number(node.dataset.to)
        const format = node.dataset.unit === 'g' ? grams : kcal
        const proxy = { value: 0 }
        tl.call(() => { node.textContent = format(0) }, [], 0)
        tl.to(proxy, {
          value: to,
          duration: DUR.slow,
          ease: EASE.meter,
          onUpdate: () => { node.textContent = format(proxy.value) },
        }, 'totals')
      }

      tl.from(pick('.digest-followups > *'), { y: 6, opacity: 0, duration: DUR.fast, stagger: 0.05 }, '-=0.3')
    },
    { scope: root },
  )

  return (
    <div className="digest-card" ref={root}>
      <p className="recommendation-eyebrow">
        <IconCalendar size={14} aria-hidden="true" />
        {one ? 'Your plan' : `Your plans · ${digest.plans.length} days`}
      </p>

      <div className="digest-days">
        {digest.plans.map((entry) => (
          <DigestDay key={entry.plan.id} entry={entry} periods={digest.periods} />
        ))}
      </div>

      <div className="digest-followups">
        <span>Change {pronoun}</span>
        {followUps.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="suggestion-chip"
            onClick={() => onAsk(prompt)}
            disabled={busy}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}

function DigestDay({ entry, periods }: { entry: ChangeTarget; periods: PeriodName[] }) {
  const scope = useRef<HTMLElement>(null)
  const { plan } = entry
  const calories = plan.content.totals.calories
  const protein = plan.content.totals.protein_g
  const meals = plan.content.meals.filter((meal) => inPeriods(meal, periods))

  // A confirmed change elsewhere in the chat lands here as a new revision.
  const shown = useRef({ revision: plan.revision_count, calories, protein })

  useGSAP(
    () => {
      const previous = shown.current
      shown.current = { revision: plan.revision_count, calories, protein }
      if (plan.revision_count <= previous.revision) return

      gsap.fromTo(scope.current, { backgroundColor: WASH }, { backgroundColor: WASH_NONE, duration: DUR.slow * 2, ease: EASE.out, clearProps: 'backgroundColor' })
      gsap.from(gsap.utils.toArray('[data-digest-item]', scope.current), { x: -8, opacity: 0, duration: DUR.fast, stagger: 0.03, ease: EASE.out })
      for (const node of gsap.utils.toArray<HTMLElement>('[data-count-up]', scope.current)) {
        const from = node.dataset.unit === 'g' ? previous.protein : previous.calories
        const to = Number(node.dataset.to)
        if (typeof from !== 'number') continue
        const format = node.dataset.unit === 'g' ? grams : kcal
        const proxy = { value: from }
        gsap.to(proxy, {
          value: to,
          duration: DUR.slow,
          ease: EASE.meter,
          onUpdate: () => { node.textContent = format(proxy.value) },
        })
      }
    },
    { scope, dependencies: [plan.revision_count] },
  )

  return (
    <section className="digest-day" data-digest-day ref={scope}>
      <header className="change-day-head">
        <div className="change-day-title">
          <strong>{friendlyDate(entry.date)}</strong>
          <span>
            <IconPin size={12} aria-hidden="true" />
            {entry.locationName}
          </span>
        </div>
        <div className="change-macros">
          <span className="change-macro" title="Calories">
            <IconCalories size={14} aria-hidden="true" />
            {typeof calories === 'number' ? (
              <b data-count-up data-to={calories} data-unit="kcal">{kcal(calories)}</b>
            ) : (
              <b>—</b>
            )}
          </span>
          <span className="change-macro" title="Protein">
            <IconProtein size={14} aria-hidden="true" />
            {typeof protein === 'number' ? (
              <b data-count-up data-to={protein} data-unit="g">{grams(protein)}</b>
            ) : (
              <b>—</b>
            )}
          </span>
        </div>
      </header>

      {plan.content.title && <p className="digest-title">{plan.content.title}</p>}

      {meals.length === 0 ? (
        <p className="change-kept">
          {periods.length ? `No ${periods.join(' or ').toLowerCase()} planned.` : 'Nothing planned.'}
        </p>
      ) : (
        meals.map((meal, index) => {
          const Glyph = periodIcon(meal.period_name)
          const hidden = meal.items.length - MAX_ITEMS_PER_MEAL
          return (
            <div className="digest-meal" key={meal.period_id ?? index}>
              <p className="change-meal-name">
                <Glyph size={14} aria-hidden="true" />
                {meal.period_name ?? 'Meal'}
                {typeof meal.totals.calories === 'number' && (
                  <em>{kcal(meal.totals.calories)} kcal</em>
                )}
              </p>
              <ul className="digest-items">
                {meal.items.slice(0, MAX_ITEMS_PER_MEAL).map((item, itemIndex) => (
                  <li key={`${item.item_id ?? item.name}-${itemIndex}`} data-digest-item>
                    <span>{item.name ?? 'Item'}</span>
                    {item.servings !== 1 && <em>×{item.servings}</em>}
                  </li>
                ))}
                {hidden > 0 && (
                  <li className="more" data-digest-item>
                    <span>+{hidden} more</span>
                  </li>
                )}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}
