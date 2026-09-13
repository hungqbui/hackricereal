import type { MacroField, PlanContent } from '../api/types'
import { MACRO_LABELS, fitTone, macroValue } from '../lib/format'

export function MacroPills({
  totals,
  fields,
}: {
  totals: Partial<Record<MacroField, number>>
  fields: MacroField[]
}) {
  return (
    <div className="macro-pills">
      {fields.map((field) => (
        <span key={field} className="macro-pill">
          <span className="macro-pill-value">{macroValue(totals[field], field)}</span>
          <span className="macro-pill-label">{MACRO_LABELS[field]}</span>
        </span>
      ))}
    </div>
  )
}

/** Horizontal bars comparing the day's totals with the stated targets. */
export function TargetFit({ fit }: { fit: PlanContent['target_fit'] }) {
  const entries = Object.entries(fit) as Array<
    [MacroField, { target: number; actual: number; delta: number; pct_of_target: number | null }]
  >
  if (entries.length === 0) return null

  return (
    <div className="target-fit">
      {entries.map(([field, entry]) => {
        const pct = entry.pct_of_target
        const tone = fitTone(pct)
        const width = Math.max(2, Math.min(pct ?? 0, 130))
        return (
          <div key={field} className="target-fit-row">
            <span className="target-fit-label">{MACRO_LABELS[field]}</span>
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

/** Thin calorie bar used inside a day column header. */
export function CalorieMeter({
  actual,
  target,
}: {
  actual: number | undefined
  target: number | undefined
}) {
  if (!target || !actual) return null
  const pct = (actual / target) * 100
  return (
    <span className="calorie-meter" title={`${Math.round(pct)}% of calorie target`}>
      <span
        className={`calorie-meter-fill tone-${fitTone(pct)}`}
        style={{ width: `${Math.max(3, Math.min(pct, 100))}%` }}
      />
    </span>
  )
}
