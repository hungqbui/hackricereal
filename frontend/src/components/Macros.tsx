import { useRef } from 'react'

import type { MacroField, PlanContent } from '../api/types'
import { MACRO_LABELS, fitTone, macroValue } from '../lib/format'
import { DUR, EASE, gsap, useGSAP } from '../lib/motion'
import { MACRO_ICONS, IconCalories, IconProtein, IconTarget } from './icons'

/**
 * Macro readouts.
 *
 * Each macro is identified by its icon rather than its name; the name stays
 * on the element as an accessible label and a tooltip, so nothing is lost by
 * dropping the word.
 */

/**
 * Calories and protein as an icon pair.
 *
 * This repeats several times per column, so spelling out "cal" and "protein"
 * each time costs more room than it earns; the icons carry it and the title
 * attribute keeps the words one hover away.
 */
export function MacroLine({
  calories,
  protein,
  className = '',
}: {
  calories: number | undefined
  protein: number | undefined
  className?: string
}) {
  return (
    <span className={`macro-line ${className}`.trim()}>
      <span className="macro-line-part" title="Calories">
        <IconCalories size={14} label="Calories" />
        {macroValue(calories, 'calories')}
      </span>
      <span className="macro-line-part" title="Protein">
        <IconProtein size={14} label="Protein" />
        {macroValue(protein, 'protein_g')}
      </span>
    </span>
  )
}

export function MacroPills({
  totals,
  fields,
}: {
  totals: Partial<Record<MacroField, number>>
  fields: MacroField[]
}) {
  const scope = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      gsap.from('.macro-pill', {
        opacity: 0,
        y: 6,
        duration: DUR.base,
        ease: EASE.out,
        stagger: 0.04,
      })
    },
    { scope, dependencies: [fields.join(), JSON.stringify(totals)] },
  )

  return (
    <div className="macro-pills" ref={scope}>
      {fields.map((field) => {
        const Icon = MACRO_ICONS[field]
        return (
          <span key={field} className="macro-pill" title={MACRO_LABELS[field]}>
            <Icon size={15} className="macro-pill-icon" label={MACRO_LABELS[field]} />
            <span className="macro-pill-value">{macroValue(totals[field], field)}</span>
          </span>
        )
      })}
    </div>
  )
}

/**
 * A ring showing how close one day landed to its calorie target.
 *
 * Replaces the "78% of target" caption: the arc carries the ratio, the
 * tooltip carries the sentence.
 */
export function FitRing({
  actual,
  target,
  size = 40,
}: {
  actual: number | undefined
  target: number | undefined
  size?: number
}) {
  const arc = useRef<SVGCircleElement>(null)
  const pct = target && actual ? (actual / target) * 100 : null
  const tone = fitTone(pct)

  const stroke = 3.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  // Past 100% the ring is full; the tone colour carries the overshoot.
  const filled = Math.max(0, Math.min(pct ?? 0, 100)) / 100

  useGSAP(
    () => {
      if (!arc.current) return
      gsap.fromTo(
        arc.current,
        { strokeDashoffset: circumference },
        {
          strokeDashoffset: circumference * (1 - filled),
          duration: DUR.slow,
          ease: EASE.meter,
        },
      )
    },
    { dependencies: [filled, circumference] },
  )

  const title =
    pct === null
      ? 'No calorie target set'
      : `${Math.round(pct)}% of the ${Math.round(target ?? 0).toLocaleString()} cal target`

  return (
    <span className={`fit-ring tone-${tone}`} title={title}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title}>
        <circle
          className="fit-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
        />
        {pct !== null && (
          <circle
            ref={arc}
            className="fit-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <IconTarget size={size * 0.4} className="fit-ring-glyph" />
    </span>
  )
}

/** Horizontal bars comparing the day's totals with the stated targets. */
export function TargetFit({ fit }: { fit: PlanContent['target_fit'] }) {
  const scope = useRef<HTMLDivElement>(null)
  const entries = Object.entries(fit) as Array<
    [MacroField, { target: number; actual: number; delta: number; pct_of_target: number | null }]
  >

  useGSAP(
    () => {
      gsap.from('.target-fit-bar', {
        scaleX: 0,
        transformOrigin: 'left center',
        duration: DUR.slow,
        ease: EASE.meter,
        stagger: 0.06,
      })
    },
    { scope, dependencies: [entries.length, JSON.stringify(fit)] },
  )

  if (entries.length === 0) return null

  return (
    <div className="target-fit" ref={scope}>
      {entries.map(([field, entry]) => {
        const pct = entry.pct_of_target
        const tone = fitTone(pct)
        const width = Math.max(2, Math.min(pct ?? 0, 130))
        const Icon = MACRO_ICONS[field]
        return (
          <div key={field} className="target-fit-row" title={MACRO_LABELS[field]}>
            <Icon size={16} className="target-fit-icon" label={MACRO_LABELS[field]} />
            <span className="target-fit-track">
              <span
                className={`target-fit-bar tone-${tone}`}
                style={{ width: `${(width / 130) * 100}%` }}
              />
              <span className="target-fit-marker" style={{ left: `${(100 / 130) * 100}%` }} />
            </span>
            <span className="target-fit-value">
              {macroValue(entry.actual, field)}
              <span className="target-fit-target"> / {macroValue(entry.target, field)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Thin calorie bar, kept for tight rows where a ring will not fit. */
export function CalorieMeter({
  actual,
  target,
}: {
  actual: number | undefined
  target: number | undefined
}) {
  const bar = useRef<HTMLSpanElement>(null)
  const pct = target && actual ? (actual / target) * 100 : 0

  useGSAP(
    () => {
      if (!bar.current) return
      gsap.from(bar.current, {
        scaleX: 0,
        transformOrigin: 'left center',
        duration: DUR.slow,
        ease: EASE.meter,
      })
    },
    { dependencies: [pct] },
  )

  if (!target || !actual) return null

  return (
    <span className="calorie-meter" title={`${Math.round(pct)}% of calorie target`}>
      <span
        ref={bar}
        className={`calorie-meter-fill tone-${fitTone(pct)}`}
        style={{ width: `${Math.max(3, Math.min(pct, 100))}%` }}
      />
    </span>
  )
}
