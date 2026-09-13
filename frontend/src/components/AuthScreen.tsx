/**
 * Sign in / create account — the only screen a signed-out visitor sees.
 *
 * Two panels: a forest-green pitch panel that says what UniBite is, and the
 * form itself. The pitch panel is the app's only chance to explain itself
 * (there is no marketing site), so it carries the three things the product
 * actually does rather than decoration. Below 900px it collapses to a brand
 * header and the points drop away — on a phone the form is what you came for.
 */

import { useRef, useState, type FormEvent } from 'react'

import { DUR, EASE, STAGGER, gsap, useGSAP } from '../lib/motion'
import { useAuth } from '../state/auth'
import { SegmentedControl } from './ui'
import {
  IconDining,
  IconEye,
  IconEyeOff,
  IconSpark,
  IconTarget,
  LogoUniBite,
} from './icons'

type Mode = 'login' | 'register'

const MODES = [
  { value: 'login' as const, label: 'Sign in' },
  { value: 'register' as const, label: 'Create account' },
]

const POINTS = [
  {
    icon: IconSpark,
    title: 'Ask, don’t scroll',
    body: 'Say “high protein, under 600 calories” and get a plan built from tonight’s real menu.',
  },
  {
    icon: IconDining,
    title: 'Every hall, every period',
    body: 'Live University of Houston menus, breakfast through dinner, with what’s open right now.',
  },
  {
    icon: IconTarget,
    title: 'Know where you stand',
    body: 'Calories and protein add up as you log, so the next meal is an informed one.',
  },
]

export function AuthScreen() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const scope = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      gsap
        .timeline()
        .from('.auth-pitch', { x: -16, opacity: 0, duration: DUR.base, ease: EASE.out })
        .from(
          '.auth-point',
          { y: 12, opacity: 0, duration: DUR.base, ease: EASE.out, stagger: STAGGER },
          '-=0.25',
        )
        .from('.auth-card', { y: 16, opacity: 0, duration: DUR.base, ease: EASE.out }, '-=0.45')
    },
    { scope },
  )

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign you in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen" ref={scope}>
      <div className="auth-layout">
        <aside className="auth-pitch">
          <div className="auth-pitch-body">
            <p className="brand brand-lg auth-pitch-brand">
              <span className="brand-tile">
                <LogoUniBite size={30} label="UniBite" />
              </span>
              UniBite
            </p>

            <h1 className="auth-headline">
              Eat smarter.
              <br />
              Live better.
            </h1>
            <p className="auth-sub">
              Your personal dining advisor — it knows what you’ve eaten and what
              campus is serving right now.
            </p>

            <ul className="auth-points">
              {POINTS.map(({ icon: Icon, title, body }) => (
                <li key={title} className="auth-point">
                  <span className="auth-point-icon">
                    <Icon size={19} />
                  </span>
                  <span className="auth-point-text">
                    <strong>{title}</strong>
                    {body}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div className="auth-card">
          <p className="brand auth-card-brand">
            <LogoUniBite size={26} label="UniBite" />
            UniBite
          </p>

          <div className="auth-card-head">
            <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
            <p>
              {mode === 'login'
                ? 'Sign in to pick up where you left off.'
                : 'Takes a moment — no meal history needed to start.'}
            </p>
          </div>

          <SegmentedControl
            options={MODES}
            value={mode}
            onChange={(next) => {
              setMode(next)
              setError(null)
            }}
            label="Sign in or create an account"
          />

          <form onSubmit={onSubmit} className="auth-form">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@uh.edu"
              />
            </label>

            <div className="field">
              <span id="auth-password-label">Password</span>
              <div className="input-with-affix">
                <input
                  id="auth-password"
                  aria-labelledby="auth-password-label"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'register' ? 'At least 8 characters' : ''}
                />
                <button
                  type="button"
                  className="input-affix-button"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-controls="auth-password"
                  aria-pressed={showPassword}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <IconEyeOff size={19} label="Hide password" />
                  ) : (
                    <IconEye size={19} label="Show password" />
                  )}
                </button>
              </div>
            </div>

            {error && <p className="form-error">{error}</p>}

            <button type="submit" className="button primary auth-submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="auth-fineprint">
            Menu data comes from University of Houston dining. UniBite is a
            student project, not affiliated with UH.
          </p>
        </div>
      </div>
    </div>
  )
}
