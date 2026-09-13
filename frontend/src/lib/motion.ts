/**
 * Shared GSAP setup.
 *
 * Every animation in the app pulls its duration and ease from here, so the
 * whole surface moves with one rhythm. `prefers-reduced-motion` is honoured
 * globally: GSAP still runs, but every tween resolves in a single frame, so
 * components never need to branch on it.
 */

import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

gsap.registerPlugin(useGSAP)

export const DUR = {
  /** Hover states, dot pulses, anything under the cursor. */
  fast: 0.18,
  /** The default: cards arriving, panels opening. */
  base: 0.42,
  /** Meters and counters, which read better a little slower. */
  slow: 0.7,
} as const

export const EASE = {
  /** Arrivals: quick out of the gate, soft landing. */
  out: 'power3.out',
  /** Departures. */
  in: 'power2.in',
  /** Meters filling toward a target. */
  meter: 'power2.out',
  /** The one springy ease, kept for things the user just did. */
  pop: 'back.out(1.7)',
} as const

/** Stagger for a row of day columns or a list of meal cards. */
export const STAGGER = { each: 0.055, from: 'start' } as const

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

let configured = false

/** Call once at startup. Safe to call again. */
export function initMotion(): void {
  if (configured || typeof window === 'undefined') return
  configured = true

  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const apply = () => {
    // timeScale on the global timeline keeps every tween's onComplete and
    // stagger ordering intact while collapsing the visible motion.
    gsap.globalTimeline.timeScale(media.matches ? 200 : 1)
  }
  apply()
  media.addEventListener('change', apply)
}

/**
 * Tween a number into a DOM node's text.
 *
 * Used for macro readouts so a refinement visibly moves the number rather
 * than swapping it. `format` runs on every frame.
 */
export function countTo(
  node: HTMLElement | null,
  to: number,
  format: (value: number) => string,
  from?: number,
): gsap.core.Tween | null {
  if (!node) return null
  const start = from ?? Number(node.dataset.value ?? 0)
  const proxy = { value: Number.isFinite(start) ? start : 0 }

  return gsap.to(proxy, {
    value: to,
    duration: DUR.slow,
    ease: EASE.meter,
    onUpdate: () => {
      node.textContent = format(proxy.value)
    },
    onComplete: () => {
      node.dataset.value = String(to)
      node.textContent = format(to)
    },
  })
}

export { gsap, useGSAP }
