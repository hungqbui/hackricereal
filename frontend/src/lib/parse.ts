/** Turn one sentence of plain English into a plan request.
 *
 * The backend already hands the user's full sentence to Gemini as
 * `constraints`, so nothing here needs to understand *taste* - "no
 * cilantro", "something light after the gym". This only lifts out the
 * four things the API needs as structured fields: which dining hall,
 * which dates, which meal periods, and any numeric macro targets. The
 * original text is always forwarded untouched.
 *
 * Everything it infers is shown back to the user as an editable chip, so
 * a miss is a correction rather than a dead end.
 */

import type { Location, NutritionTargets, Period } from '../api/types'
import { addDays, dayOfWeek, nextWeekday, rangeFrom, todayISO } from './dates'

export const PERIOD_ORDER = [
  'Breakfast',
  'Brunch',
  'Lunch',
  'Dinner',
  'Late Night',
  'Everyday',
] as const

export type PeriodName = (typeof PERIOD_ORDER)[number]

export interface Interpretation {
  text: string
  locationId: string | null
  dates: string[]
  /** Empty means "every period the hall serves that day". */
  periods: PeriodName[]
  targets: NutritionTargets
}

const MAX_DAYS = 14

// ---------------------------------------------------------------- periods

const PERIOD_PATTERNS: Array<[PeriodName, RegExp]> = [
  ['Breakfast', /\bbreakfasts?\b|\bmorning meal\b/],
  ['Brunch', /\bbrunch(es)?\b/],
  ['Lunch', /\blunch(es)?\b|\bmidday\b|\bnoon\b/],
  ['Dinner', /\bdinners?\b|\bsuppers?\b|\bevening meal\b/],
  ['Late Night', /\blate[- ]night\b|\bmidnight\b/],
  ['Everyday', /\bsnacks?\b|\ball[- ]day\b/],
]

function parsePeriods(text: string): PeriodName[] {
  const found = PERIOD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([name]) => name,
  )
  // "all three meals" / "every meal" means the whole day, i.e. no filter.
  if (/\b(all|every|each)\s+(three\s+)?meals?\b|\bfull day\b|\bwhole day\b/.test(text)) {
    return []
  }
  return found
}

/** Resolve requested period names against what the hall actually serves. */
export function matchPeriods(available: Period[], wanted: PeriodName[]): Period[] {
  if (wanted.length === 0) return []
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '')
  return available.filter((period) => {
    const haystack = `${normalise(period.name ?? '')} ${normalise(period.slug ?? '')}`
    return wanted.some((name) => haystack.includes(normalise(name)))
  })
}

// ------------------------------------------------------------------ dates

const WEEKDAY_PATTERNS: Array<[number, RegExp]> = [
  [0, /\bsun(day)?\b/],
  [1, /\bmon(day)?\b/],
  [2, /\btues?(day)?\b/],
  [3, /\bwed(nesday)?\b/],
  [4, /\bthur?s?(day)?\b/],
  [5, /\bfri(day)?\b/],
  [6, /\bsat(urday)?\b/],
]

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14,
}

function explicitDates(text: string, today: string): string[] {
  const found = new Set<string>()
  const thisYear = Number(today.slice(0, 4))

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    found.add(`${match[1]}-${match[2]}-${match[3]}`)
  }

  // "sep 15", "september 15th"
  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g
  for (const match of text.matchAll(monthDay)) {
    const month = MONTHS[match[1]]
    const day = Number(match[2])
    if (day >= 1 && day <= 31) {
      const iso = `${thisYear}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`
      // A month already past this year almost certainly means next year.
      found.add(iso < today ? `${thisYear + 1}${iso.slice(4)}` : iso)
    }
  }

  // "9/15" — US order, the only one a campus audience writes.
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    const month = Number(match[1])
    const day = Number(match[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = `${thisYear}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`
      found.add(iso < today ? `${thisYear + 1}${iso.slice(4)}` : iso)
    }
  }

  return [...found]
}

function parseCount(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern)
  if (!match) return null
  const raw = match[1]
  const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]
  return value && value > 0 ? Math.min(value, MAX_DAYS) : null
}

function parseDates(text: string, today: string): string[] {
  const explicit = explicitDates(text, today)
  if (explicit.length) return explicit.sort()

  const nextN = parseCount(
    text,
    /\b(?:next|coming|for)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)\s+days?\b/,
  )
  if (nextN) return rangeFrom(today, nextN)

  if (/\bnext week\b/.test(text)) {
    // Monday of next week through Sunday.
    const monday = addDays(nextWeekday(today, 1), dayOfWeek(today) === 1 ? 7 : 0)
    return rangeFrom(monday, 7)
  }

  if (/\bweekends?\b/.test(text)) {
    const saturday = nextWeekday(today, 6)
    return [saturday, addDays(saturday, 1)]
  }

  if (/\bweekdays?\b|\bmon(day)?\s*(-|through|to|thru)\s*fri(day)?\b/.test(text)) {
    return rangeFrom(today, 7).filter((iso) => {
      const day = dayOfWeek(iso)
      return day >= 1 && day <= 5
    })
  }

  if (/\b(this|the|whole|entire|rest of the|coming)\s+week\b|\bweekly\b|\bfor the week\b/.test(text)) {
    return rangeFrom(today, 7)
  }

  // Named days combine freely: "tomorrow and sunday" is two days.
  const named = new Set<string>()
  for (const [weekday, pattern] of WEEKDAY_PATTERNS) {
    if (pattern.test(text)) named.add(nextWeekday(today, weekday))
  }
  if (/\btomorrow\b/.test(text)) named.add(addDays(today, 1))
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(text)) {
    named.add(today)
  }
  if (named.size) return [...named].sort()

  return [today]
}

// ---------------------------------------------------------------- targets

interface TargetRule {
  field: keyof NutritionTargets
  patterns: RegExp[]
  max: number
}

// Both orders show up in practice: "150g protein" and "protein: 150".
const TARGET_RULES: TargetRule[] = [
  {
    field: 'calories',
    patterns: [
      /\b(\d{3,5})\s*(?:k?cals?|calories|kcal)\b/,
      /\bcalories?\b[^\d]{0,12}(\d{3,5})\b/,
      /\b(?:around|about|roughly|under|below|max|up to|~)\s*(\d{3,5})\s*(?:k?cal|calories)?\b/,
    ],
    max: 10000,
  },
  {
    field: 'protein_g',
    patterns: [
      /\b(\d{2,3})\s*g(?:rams?)?\s*(?:of\s+)?protein\b/,
      /\bprotein\b[^\d]{0,12}(\d{2,3})\s*g?\b/,
    ],
    max: 500,
  },
  {
    field: 'carbs_g',
    patterns: [
      /\b(\d{2,4})\s*g(?:rams?)?\s*(?:of\s+)?(?:carbs?|carbohydrates?)\b/,
      /\bcarbs?\b[^\d]{0,12}(\d{2,4})\s*g?\b/,
    ],
    max: 1000,
  },
  {
    field: 'fat_g',
    patterns: [
      /\b(\d{2,3})\s*g(?:rams?)?\s*(?:of\s+)?fat\b/,
      /\bfat\b[^\d]{0,12}(\d{2,3})\s*g?\b/,
    ],
    max: 500,
  },
  {
    field: 'fiber_g',
    patterns: [
      /\b(\d{1,3})\s*g(?:rams?)?\s*(?:of\s+)?fib(?:er|re)\b/,
      /\bfib(?:er|re)\b[^\d]{0,12}(\d{1,3})\s*g?\b/,
    ],
    max: 200,
  },
  {
    field: 'sodium_mg',
    patterns: [
      /\b(\d{3,5})\s*mg\s*(?:of\s+)?sodium\b/,
      /\bsodium\b[^\d]{0,12}(\d{3,5})\s*mg?\b/,
    ],
    max: 20000,
  },
]

function parseTargets(text: string): NutritionTargets {
  const targets: NutritionTargets = {}
  for (const rule of TARGET_RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern)
      if (!match) continue
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0 && value <= rule.max) {
        targets[rule.field] = value
        break
      }
    }
  }
  return targets
}

// --------------------------------------------------------------- location

// Words that appear across many halls and so identify none of them.
const GENERIC_TOKENS = new Set([
  'dining', 'commons', 'hall', 'halls', 'the', 'at', 'of', 'and', 'a',
  'college', 'campus', 'university', 'houston', 'uh', 'cafe', 'market',
  'kitchen', 'food', 'bros', 'co', 'inc',
])

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token))
}

/** Pick the dining hall whose distinctive words appear in the sentence. */
export function matchLocation(text: string, locations: Location[]): Location | null {
  if (!locations.length) return null

  const frequency = new Map<string, number>()
  const tokensFor = new Map<string, string[]>()
  for (const location of locations) {
    const tokens = [
      ...new Set([...tokenize(location.name), ...tokenize(location.building ?? '')]),
    ]
    tokensFor.set(location.id, tokens)
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  }

  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `

  let best: Location | null = null
  let bestScore = 0
  for (const location of locations) {
    let score = 0
    for (const token of tokensFor.get(location.id) ?? []) {
      if (!haystack.includes(` ${token} `)) continue
      const shared = frequency.get(token) ?? 1
      // A word used by one hall identifies it; one used by five does not.
      score += token.length / shared
    }
    if (score > bestScore) {
      best = location
      bestScore = score
    }
  }

  // Roughly "one distinctive five-letter word" — enough to beat a stray
  // match on a short shared word like "south".
  return bestScore >= 4 ? best : null
}

// ------------------------------------------------------------------ entry

export function interpret(
  text: string,
  locations: Location[],
  options: { today?: string; fallbackLocationId?: string | null } = {},
): Interpretation {
  const today = options.today ?? todayISO()
  const lower = text.toLowerCase()
  const location = matchLocation(lower, locations)

  return {
    text: text.trim(),
    locationId: location?.id ?? options.fallbackLocationId ?? null,
    dates: parseDates(lower, today).slice(0, MAX_DAYS),
    periods: parsePeriods(lower),
    targets: parseTargets(lower),
  }
}

export const EXAMPLE_PROMPTS = [
  'High-protein vegetarian lunch and dinner at Moody Towers this week, 2200 calories and 150g protein',
  'No pork, no shellfish — plan tomorrow at Cougar Woods around 1800 calories',
  'Light breakfasts and big dinners for the next 3 days, 40g fiber, low sodium',
]
