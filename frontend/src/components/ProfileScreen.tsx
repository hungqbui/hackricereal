/**
 * Profile — the settings that steer every recommendation.
 *
 * Each row says, in the copy itself, how it reaches the advisor: goals become
 * the `targets` on `POST /plans/generate`, and the backend adds diet, allergies
 * and dislikes to every planning prompt. Nothing here is decoration.
 *
 * Saved to `PUT /profile` as the student edits; see `state/profile.ts`.
 */

import { useState } from 'react'

import type { Location } from '../api/types'
import { useAuth } from '../state/auth'
import {
  COMMON_ALLERGENS,
  DIET_LABELS,
  type DietPreference,
  type ProfileStore,
  type ProfileSync,
} from '../state/profile'
import {
  IconAllergen,
  IconCalories,
  IconCheck,
  IconClock,
  IconLeaf,
  IconLive,
  IconLogout,
  IconOffline,
  IconPin,
  IconPlus,
  IconProtein,
  IconTarget,
  IconUser,
} from './icons'
import { Avatar, Card, FilterChip, SectionHeading } from './ui'

export interface ProfileScreenProps {
  store: ProfileStore
  locations: Location[]
  gemini: { configured: boolean; model: string | null } | null
}

const SYNC_LABELS: Record<ProfileSync, string> = {
  loading: 'Loading…',
  saving: 'Saving…',
  saved: 'Saved to your account',
  offline: 'Offline — kept on this device',
}

export function ProfileScreen({ store, locations, gemini }: ProfileScreenProps) {
  const { profile, update, reset, sync } = store
  const { user, logout } = useAuth()
  const [avoidDraft, setAvoidDraft] = useState('')

  const toggleAllergy = (allergen: string) => {
    const has = profile.allergies.includes(allergen)
    update({
      allergies: has
        ? profile.allergies.filter((entry) => entry !== allergen)
        : [...profile.allergies, allergen],
    })
  }

  const toggleFavourite = (id: string) => {
    const has = profile.favoriteLocationIds.includes(id)
    update({
      favoriteLocationIds: has
        ? profile.favoriteLocationIds.filter((entry) => entry !== id)
        : [...profile.favoriteLocationIds, id],
    })
  }

  const addAvoid = () => {
    const value = avoidDraft.trim()
    if (!value || profile.avoid.includes(value)) return
    update({ avoid: [...profile.avoid, value] })
    setAvoidDraft('')
  }

  return (
    <div className="screen profile-screen">
      <header className="screen-head">
        <h1>Profile</h1>
        <span className={`sync-status ${sync}`} role="status">
          {SYNC_LABELS[sync]}
        </span>
      </header>

      <Card className="profile-identity">
        <Avatar name={profile.displayName || user?.email || '?'} size={52} />
        <div>
          <label className="inline-field">
            <span className="sr-only">Your name</span>
            <input
              className="name-input"
              value={profile.displayName}
              onChange={(event) => update({ displayName: event.target.value })}
              placeholder="Your name"
              aria-label="Your name"
            />
          </label>
          <p className="profile-email">{user?.email}</p>
        </div>
      </Card>

      <p className="settings-note">
        <IconTarget size={15} aria-hidden="true" />
        Saved to your account. The Advisor reads it for every recommendation and schedule change —
        goals as numeric targets, the rest as rules the planner has to respect.
      </p>

      {/* ------------------------------------------------------------ goals */}
      <section>
        <SectionHeading>Daily goals</SectionHeading>
        <Card className="setting-group">
          <NumberRow
            icon={IconCalories}
            label="Calorie goal"
            hint="Recommendations aim at what's left of this after your logged meals."
            value={profile.calorieGoal}
            unit="kcal"
            min={1000}
            max={6000}
            step={50}
            onChange={(value) => update({ calorieGoal: value })}
          />
          <NumberRow
            icon={IconProtein}
            label="Protein goal"
            hint="Drives the “you're low on protein” nudges."
            value={profile.proteinGoal}
            unit="g"
            min={20}
            max={400}
            step={5}
            onChange={(value) => update({ proteinGoal: value })}
          />
        </Card>
      </section>

      {/* -------------------------------------------------------------- diet */}
      <section>
        <SectionHeading>Dietary preference</SectionHeading>
        <Card className="setting-group">
          <div className="chip-row wrap">
            {(Object.keys(DIET_LABELS) as DietPreference[]).map((diet) => (
              <FilterChip
                key={diet}
                active={profile.diet === diet}
                onClick={() => update({ diet })}
              >
                {profile.diet === diet && <IconCheck size={14} aria-hidden="true" />}
                {DIET_LABELS[diet]}
              </FilterChip>
            ))}
          </div>
        </Card>
      </section>

      {/* --------------------------------------------------------- allergies */}
      <section>
        <SectionHeading>Allergies</SectionHeading>
        <Card className="setting-group">
          <p className="setting-hint">
            <IconAllergen size={14} aria-hidden="true" />
            Items tagged with these are flagged in Dining and excluded from recommendations.
          </p>
          <div className="chip-row wrap">
            {COMMON_ALLERGENS.map((allergen) => (
              <FilterChip
                key={allergen}
                active={profile.allergies.includes(allergen)}
                onClick={() => toggleAllergy(allergen)}
              >
                {profile.allergies.includes(allergen) && (
                  <IconCheck size={14} aria-hidden="true" />
                )}
                {allergen}
              </FilterChip>
            ))}
          </div>
        </Card>
      </section>

      {/* ------------------------------------------------------------- avoid */}
      <section>
        <SectionHeading>Foods to avoid</SectionHeading>
        <Card className="setting-group">
          <p className="setting-hint">
            <IconLeaf size={14} aria-hidden="true" />
            Preferences, not allergies — “mushrooms”, “anything fried”.
          </p>
          <div className="chip-row wrap">
            {profile.avoid.map((entry) => (
              <FilterChip key={entry} active onClick={() => update({ avoid: profile.avoid.filter((v) => v !== entry) })}>
                {entry}
                <span aria-hidden="true">×</span>
              </FilterChip>
            ))}
          </div>
          <div className="inline-add">
            <input
              value={avoidDraft}
              onChange={(event) => setAvoidDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addAvoid()
                }
              }}
              placeholder="Add something to avoid"
              aria-label="Add a food to avoid"
              maxLength={100}
            />
            <button type="button" className="button" onClick={addAvoid} disabled={!avoidDraft.trim()}>
              <IconPlus size={15} />
              Add
            </button>
          </div>
        </Card>
      </section>

      {/* --------------------------------------------------------- favourites */}
      <section>
        <SectionHeading>Favourite dining halls</SectionHeading>
        <Card className="setting-group">
          <p className="setting-hint">
            <IconPin size={14} aria-hidden="true" />
            The first one that's open is where the Advisor looks by default.
          </p>
          {locations.length === 0 ? (
            <p className="muted">Campus dining list unavailable.</p>
          ) : (
            <div className="chip-row wrap">
              {locations.map((location) => (
                <FilterChip
                  key={location.id}
                  active={profile.favoriteLocationIds.includes(location.id)}
                  onClick={() => toggleFavourite(location.id)}
                  title={location.building ?? undefined}
                >
                  {profile.favoriteLocationIds.includes(location.id) && (
                    <IconCheck size={14} aria-hidden="true" />
                  )}
                  {location.name}
                </FilterChip>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* ---------------------------------------------------------- schedule */}
      <section>
        <SectionHeading>Typical meal times</SectionHeading>
        <Card className="setting-group">
          <p className="setting-hint">
            <IconClock size={14} aria-hidden="true" />
            Used to guess which meal you mean when you just ask “what should I eat?”.
          </p>
          <div className="time-grid">
            {(['breakfast', 'lunch', 'dinner'] as const).map((slot) => (
              <label key={slot} className="time-field">
                <span>{slot[0].toUpperCase() + slot.slice(1)}</span>
                <input
                  type="time"
                  value={profile.schedule[slot]}
                  onChange={(event) =>
                    update({ schedule: { ...profile.schedule, [slot]: event.target.value } })
                  }
                />
              </label>
            ))}
          </div>
        </Card>
      </section>

      {/* ----------------------------------------------------------- account */}
      <section>
        <SectionHeading>Account</SectionHeading>
        <Card className="setting-group">
          <div className="setting-row">
            <span className="setting-label">
              <IconUser size={17} aria-hidden="true" />
              Signed in as
            </span>
            <span className="setting-value">{user?.email}</span>
          </div>
          {gemini && (
            <div className="setting-row">
              <span className="setting-label">
                {gemini.configured ? (
                  <IconLive size={17} aria-hidden="true" />
                ) : (
                  <IconOffline size={17} aria-hidden="true" />
                )}
                Planner
              </span>
              <span className="setting-value">
                {gemini.configured ? `Live — ${gemini.model}` : 'Offline planner (no Gemini key)'}
              </span>
            </div>
          )}
          <div className="setting-actions">
            <button type="button" className="button" onClick={reset}>
              Reset preferences
            </button>
            <button type="button" className="button danger" onClick={logout}>
              <IconLogout size={16} />
              Sign out
            </button>
          </div>
        </Card>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------- number row */

function NumberRow({
  icon: Icon,
  label,
  hint,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  icon: (p: { size?: number; 'aria-hidden'?: boolean }) => React.ReactNode
  label: string
  hint: string
  value: number
  unit: string
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div className="setting-row stacked">
      <div className="setting-row-head">
        <span className="setting-label">
          <Icon size={17} aria-hidden />
          {label}
        </span>
        <span className="number-field">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
            }}
            aria-label={label}
          />
          <em>{unit}</em>
        </span>
      </div>
      <input
        type="range"
        className="slider"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label} slider`}
      />
      <p className="setting-hint">{hint}</p>
    </div>
  )
}
