/**
 * Shared primitives for the four tabs.
 *
 * Everything here follows the rule the icon family already sets: where a glyph
 * or a shape replaces a word, the word still ships as an accessible name. The
 * progress ring is the clearest case — the arc is decorative, the sentence
 * under `aria-label` is the real content.
 */

import { useRef, type HTMLAttributes, type ReactNode } from 'react'

import { DUR, EASE, gsap, useGSAP } from '../lib/motion'
import { IconCheck, IconChevronDown, type IconProps } from './icons'

/* ------------------------------------------------------------ progress ring */

export interface ProgressRingProps {
  value: number
  target: number
  /** Big number in the middle. Defaults to a rounded `value`. */
  display?: string
  caption?: string
  unit?: string
  size?: number
  thickness?: number
  tone?: 'primary' | 'accent'
}

/**
 * An arc that fills toward a target, capped at one full turn so an overshoot
 * reads as "full" rather than wrapping around and looking low.
 */
export function ProgressRing({
  value,
  target,
  display,
  caption,
  unit,
  size = 92,
  thickness = 8,
  tone = 'primary',
}: ProgressRingProps) {
  const arc = useRef<SVGCircleElement>(null)
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = target > 0 ? Math.min(1, Math.max(0, value / target)) : 0
  const pct = target > 0 ? Math.round((value / target) * 100) : 0

  useGSAP(
    () => {
      gsap.to(arc.current, {
        strokeDashoffset: circumference * (1 - ratio),
        duration: DUR.base,
        ease: EASE.meter,
      })
    },
    { dependencies: [ratio, circumference] },
  )

  const label = `${Math.round(value).toLocaleString()}${unit ?? ''} of ${target.toLocaleString()}${unit ?? ''}${
    caption ? ` ${caption.toLowerCase()}` : ''
  } — ${pct}% of goal`

  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={label}>
        <title>{label}</title>
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={thickness}
          fill="none"
        />
        <circle
          ref={arc}
          className="ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={thickness}
          fill="none"
          /* An empty ring must draw nothing at all: a round cap leaves a dot,
             and even a butt cap leaves a hairline tick at the dash seam where
             offset meets dasharray. Hiding the stroke outright is the only
             thing that renders clean at every size. */
          strokeLinecap="round"
          strokeOpacity={ratio > 0 ? 1 : 0}
          strokeDasharray={circumference}
          strokeDashoffset={circumference}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-label" aria-hidden="true">
        <strong>{display ?? Math.round(value).toLocaleString()}</strong>
        <span>of {target.toLocaleString()}</span>
        {caption && <em>{caption}</em>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ stat tiles */

export function StatTile({
  icon: Icon,
  value,
  label,
  sub,
}: {
  icon?: (p: IconProps) => ReactNode
  value: string
  label: string
  sub?: string
}) {
  return (
    <div className="stat-tile">
      {Icon && (
        <span className="stat-icon" aria-hidden="true">
          <Icon size={18} />
        </span>
      )}
      <strong>{value}</strong>
      <span>{label}</span>
      {sub && <em>{sub}</em>}
    </div>
  )
}

/* ------------------------------------------------------- segmented control */

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  label: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedControlProps<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segment${option.value === value ? ' active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ chips */

export function FilterChip({
  active,
  onClick,
  children,
  disabled,
  title,
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      className={`filter-chip${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

export function SuggestionChip({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className="suggestion-chip" onClick={onClick}>
      {children}
    </button>
  )
}

/* ----------------------------------------------------------------- avatar */

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

/* ------------------------------------------------------------- containers */

export function Card({
  children,
  className = '',
  tone,
  ...rest
}: {
  children: ReactNode
  className?: string
  tone?: 'soft' | 'plain'
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card${tone ? ` card-${tone}` : ''} ${className}`.trim()} {...rest}>
      {children}
    </div>
  )
}

export function SectionHeading({
  children,
  action,
}: {
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="section-heading">
      <h2>{children}</h2>
      {action}
    </div>
  )
}

/** A short, plain-language nudge. Never the only place a number appears. */
export function InsightCard({
  icon: Icon,
  title,
  children,
  tone = 'good',
}: {
  icon?: (p: IconProps) => ReactNode
  title: string
  children?: ReactNode
  tone?: 'good' | 'warn'
}) {
  return (
    <div className={`insight insight-${tone}`}>
      <span className="insight-icon" aria-hidden="true">
        {Icon ? <Icon size={20} /> : <IconCheck size={20} />}
      </span>
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: (p: IconProps) => ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      {Icon && (
        <span className="empty-icon" aria-hidden="true">
          <Icon size={26} />
        </span>
      )}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

/* -------------------------------------------------------------- skeletons */

export function Skeleton({
  height = 16,
  width = '100%',
  radius = 8,
}: {
  height?: number
  width?: number | string
  radius?: number
}) {
  return (
    <span
      className="skeleton"
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

export function SkeletonRow() {
  return (
    <div className="skeleton-row" aria-hidden="true">
      <Skeleton height={44} width={44} radius={12} />
      <div className="skeleton-stack">
        <Skeleton height={13} width="58%" />
        <Skeleton height={11} width="38%" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- disclosure */

export function Disclosure({
  summary,
  children,
  open,
  onToggle,
}: {
  summary: ReactNode
  children: ReactNode
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className={`disclosure${open ? ' open' : ''}`}>
      <button
        type="button"
        className="disclosure-summary"
        onClick={onToggle}
        aria-expanded={open}
      >
        {summary}
        <IconChevronDown size={18} />
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  )
}
