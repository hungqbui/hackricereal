/**
 * One stroked icon family, 24x24, drawn on a single grid.
 *
 * Every icon inherits `currentColor` and a 1.9 stroke so a row of them reads
 * as one weight. Anywhere an icon replaces a word, the word still ships as
 * `aria-label`/`title` so the meaning survives for screen readers and on hover.
 */

import type { JSX, SVGProps } from 'react'

import type { MacroField } from '../api/types'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
  /** Accessible name. Omit for icons that only decorate labelled text. */
  label?: string
}

function Svg({ size = 18, label, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {label && <title>{label}</title>}
      {children}
    </svg>
  )
}

/* ------------------------------------------------------------------ brand */

/**
 * The UniBite mark: a mortarboard over a bowl with a bite out of the rim.
 * Solid rather than stroked, so it holds up at favicon size.
 */
export const LogoUniBite = ({ size = 28, label, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="currentColor"
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    focusable="false"
    {...rest}
  >
    {label && <title>{label}</title>}
    {/* mortarboard */}
    <path d="M24 5.5 2.5 13.4 24 21.3l21.5-7.9z" />
    {/* tassel: cord down the right side, bead at the end */}
    <rect x="42.3" y="14.2" width="2.1" height="8.4" rx="1.05" />
    <circle cx="43.35" cy="25.1" r="2.4" />
    {/* bowl, with a bite taken out of the upper-right rim */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.5 25.2h39a19.5 19.5 0 0 1-39 0z M46.4 31a5.6 5.6 0 1 0-11.2 0 5.6 5.6 0 0 0 11.2 0z"
    />
  </svg>
)

/* ------------------------------------------------------------ meal periods */

export const IconBreakfast = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v2" />
    <path d="M5.2 8.2 3.8 6.8" />
    <path d="M18.8 8.2l1.4-1.4" />
    <path d="M3 17h18" />
    <path d="M6.5 17a5.5 5.5 0 0 1 11 0" />
    <path d="M2.5 21h19" />
  </Svg>
)

export const IconLunch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2" />
    <path d="M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </Svg>
)

export const IconDinner = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </Svg>
)

export const IconSnack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21c-4 0-7-3.5-7-8 0-3 2-5.5 4.5-5.5 1.2 0 1.9.5 2.5.5s1.3-.5 2.5-.5C17 7.5 19 10 19 13c0 4.5-3 8-7 8z" />
    <path d="M12 7.5c0-2 1.4-3.5 3.2-3.7" />
  </Svg>
)

const PERIOD_ICONS: Array<[RegExp, (p: IconProps) => JSX.Element]> = [
  [/breakfast|brunch|morning/i, IconBreakfast],
  [/lunch|noon|midday/i, IconLunch],
  [/dinner|supper|evening|night/i, IconDinner],
]

/** Pick the icon for a period name, falling back to the all-day snack glyph. */
export function periodIcon(name: string | null | undefined) {
  const match = PERIOD_ICONS.find(([pattern]) => pattern.test(name ?? ''))
  return match ? match[1] : IconSnack
}

/* ----------------------------------------------------------------- macros */

export const IconCalories = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.9-3.3-6-4.8-9.8-.3-.8-1.4-.9-1.8-.1C10.4 8 9 8.6 9 11c0 1.2.5 2 .5 2S8.8 12 7.7 12c-1.4 1-2.2 2.4-2.2 4.3C5.5 19 8.1 21 12 21z" />
  </Svg>
)

export const IconProtein = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 6.5l11 11" />
    <path d="M3.5 9.5l2-2M5 11l-1.5 1.5a1.5 1.5 0 0 0 0 2.1l3.9 3.9a1.5 1.5 0 0 0 2.1 0L11 17" />
    <path d="M20.5 14.5l-2 2M19 13l1.5-1.5a1.5 1.5 0 0 0 0-2.1l-3.9-3.9a1.5 1.5 0 0 0-2.1 0L13 7" />
  </Svg>
)

export const IconCarbs = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v18" />
    <path d="M12 8c0-2 1.5-3.5 3.5-3.5C15.5 6.5 14 8 12 8z" />
    <path d="M12 8c0-2-1.5-3.5-3.5-3.5C8.5 6.5 10 8 12 8z" />
    <path d="M12 13c0-2 1.5-3.5 3.5-3.5C15.5 11.5 14 13 12 13z" />
    <path d="M12 13c0-2-1.5-3.5-3.5-3.5C8.5 11.5 10 13 12 13z" />
    <path d="M12 18c0-2 1.5-3.5 3.5-3.5C15.5 16.5 14 18 12 18z" />
    <path d="M12 18c0-2-1.5-3.5-3.5-3.5C8.5 16.5 10 18 12 18z" />
  </Svg>
)

export const IconFat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c3.5 4 5.5 6.6 5.5 9.4A5.5 5.5 0 0 1 6.5 13c0-2.8 2-5.4 5.5-9.5z" />
  </Svg>
)

export const IconFiber = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21c0-6 2-10 8-12-1 7-4 9-8 9z" />
    <path d="M12 21C12 14 9.5 10.5 4 9c1 6 3.5 8 8 8z" />
    <path d="M12 21v-4" />
  </Svg>
)

export const IconSodium = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3h6l1.6 18H7.4z" />
    <path d="M8.1 10h7.8" />
  </Svg>
)

export const IconSugar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="8.5" width="17" height="7" rx="1.6" />
    <path d="M12 8.5v7" />
  </Svg>
)

export const IconSatFat = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12h7" />
  </Svg>
)

export const MACRO_ICONS: Record<MacroField, (p: IconProps) => JSX.Element> = {
  calories: IconCalories,
  protein_g: IconProtein,
  carbs_g: IconCarbs,
  fat_g: IconFat,
  saturated_fat_g: IconSatFat,
  fiber_g: IconFiber,
  sugar_g: IconSugar,
  sodium_mg: IconSodium,
}

/* ------------------------------------------------------------------- diet */

export const IconVegan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 20c-4.5 0-7.5-3-7.5-7.5C3.5 7 8 4 20.5 3.5 20 16 17 20 11 20z" />
    <path d="M4.5 20.5c3-6 7-9.5 12-12" />
  </Svg>
)

export const IconVegetarian = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21v-7" />
    <path d="M12 14c0-3 2-5 6-5.5-.4 3.7-2.4 5.5-6 5.5z" />
    <path d="M12 14c0-3.5-2.2-5.6-6.5-6C6 12 8.2 14 12 14z" />
  </Svg>
)

export const IconAllergen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.6 3.9 2.5 18a1.6 1.6 0 0 0 1.4 2.4h16.2A1.6 1.6 0 0 0 21.5 18L13.4 3.9a1.6 1.6 0 0 0-2.8 0z" />
    <path d="M12 9.5v4" />
    <path d="M12 17.2h.01" />
  </Svg>
)

export const IconGlutenFree = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21V9" />
    <path d="M12 12c0-2.2 1.7-4 4-4.4C16 9.8 14.3 12 12 12z" />
    <path d="M12 17c0-2.2 1.7-4 4-4.4C16 14.8 14.3 17 12 17z" />
    <path d="M12 12c0-2.2-1.7-4-4-4.4C8 9.8 9.7 12 12 12z" />
    <path d="M4 4l16 16" />
  </Svg>
)

const DIET_ICONS: Array<[RegExp, (p: IconProps) => JSX.Element]> = [
  [/vegan/i, IconVegan],
  [/vegetarian/i, IconVegetarian],
  [/gluten/i, IconGlutenFree],
  [/protein/i, IconProtein],
]

/** Glyph for a dining-hall diet tag ("Vegan", "Avoiding Gluten", ...). */
export function dietIcon(tag: string) {
  const match = DIET_ICONS.find(([pattern]) => pattern.test(tag))
  return match ? match[1] : IconCheck
}

/* ------------------------------------------------------------------- UI */

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
    <path d="M3.5 10h17" />
    <path d="M8 3v4M16 3v4" />
  </Svg>
)

export const IconCalendarOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12V7.5a2.5 2.5 0 0 0-2.5-2.5H6a2.5 2.5 0 0 0-2.5 2.5V18A2.5 2.5 0 0 0 6 20.5h6" />
    <path d="M3.5 10h17" />
    <path d="M8 3v4M16 3v4" />
    <path d="M15 18l5 4M20 18l-5 4" />
  </Svg>
)

export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z" />
    <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </Svg>
)

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 11.8a7.8 7.8 0 0 1-8.4 7.8 9 9 0 0 1-3.4-.7L4 20.5l1.6-3.6a7.8 7.8 0 0 1-.9-3.3 7.8 7.8 0 0 1 8.4-7.8 7.8 7.8 0 0 1 7.4 6z" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Svg>
)

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h13" />
    <path d="M12 5l7 7-7 7" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Svg>
)

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" />
    <circle cx="12" cy="10" r="2.6" />
  </Svg>
)

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.6" />
    <circle cx="12" cy="12" r="0.6" fill="currentColor" />
  </Svg>
)

export const IconWarn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v4.5" />
    <path d="M12 16h.01" />
  </Svg>
)

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20a7.4 7.4 0 0 1 14.4 0" />
  </Svg>
)

export const IconLive = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M7.4 16.6a6.5 6.5 0 0 1 0-9.2" />
    <path d="M16.6 7.4a6.5 6.5 0 0 1 0 9.2" />
  </Svg>
)

export const IconOffline = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 18.5h.01" />
    <path d="M8.8 15.4a4.6 4.6 0 0 1 6.4 0" />
    <path d="M5.5 12.1a9.2 9.2 0 0 1 13 0" />
    <path d="M3 4l18 16" />
  </Svg>
)

/* ------------------------------------------------------------ navigation */

export const IconAdvisor = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 11.8a7.8 7.8 0 0 1-8.4 7.8 9 9 0 0 1-3.4-.7L4 20.5l1.6-3.6a7.8 7.8 0 0 1-.9-3.3 7.8 7.8 0 0 1 8.4-7.8 7.8 7.8 0 0 1 7.4 6z" />
    <path d="M12.6 14.2 11.8 12l-2.2-.8 2.2-.8.8-2.2.8 2.2 2.2.8-2.2.8z" />
  </Svg>
)

/**
 * Fork and spoon. The spoon bowl is a *closed* path — an open curve renders as
 * a hook with a gap down its right side, which reads as a broken glyph at the
 * 20px the nav draws it at.
 */
export const IconDining = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3v6a2.5 2.5 0 0 0 5 0V3" />
    <path d="M8.5 3v6" />
    <path d="M8.5 11.5V21" />
    <path d="M18 13V3a5 5 0 0 0-3.5 4.8v3.2c0 1.1.9 2 2 2H18z" />
    <path d="M18 13v8" />
  </Svg>
)

export const IconMyMeals = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
    <path d="M3.5 9h17" />
    <path d="M8 2.8v3.4M16 2.8v3.4" />
    <path d="M7.5 13h5M7.5 16.5h8" />
  </Svg>
)

/* ------------------------------------------------------------------- more */

export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="2.8" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3.2" />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5" />
    <path d="M5.5 11.5 12 5l6.5 6.5" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Svg>
)

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
)

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 9.5 12 16l6.5-6.5" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
)

export const IconTrend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19.5V14M9.3 19.5v-9M14.7 19.5V7M20 19.5V11" />
  </Svg>
)

export const IconLeaf = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 20c-4.5 0-7.5-3-7.5-7.5C3.5 7 8 4 20.5 3.5 20 16 17 20 11 20z" />
    <path d="M4.5 20.5c3-6 7-9.5 12-12" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16" />
    <path d="M9.5 6.5V4.2h5v2.3" />
    <path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5" />
  </Svg>
)

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4.2l10-10a2.5 2.5 0 0 0-3.5-3.5l-10 10z" />
    <path d="M14.5 7.5l2.5 2.5" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8 20.5 20.5" />
  </Svg>
)

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" />
    <path d="M16.5 8.5 20 12l-3.5 3.5" />
    <path d="M20 12h-9" />
  </Svg>
)

/* ------------------------------------------------------- food categories
 *
 * DineOnCampus publishes no images (`useMenuImages` is false and
 * `locationMenuImages` is empty on every UH location), so item thumbnails are
 * drawn from this set instead of photographed. Each glyph sits on a soft-green
 * tile; `foodIcon()` maps an item's name and category onto one.
 */

export const IconFoodBowl = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z" />
    <path d="M12 11c0-2.2 1.6-4 4-4.5" />
    <path d="M2 21h20" />
  </Svg>
)

export const IconFoodPoultry = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.8 4.4a5.5 5.5 0 0 0-8.6 6.7l-3.6 3.6a2.5 2.5 0 0 0 3.5 3.5l3.6-3.6a5.5 5.5 0 0 0 5.1-10.2z" />
    <path d="M7.5 16.5 5 19" />
  </Svg>
)

export const IconFoodGrain = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21V8" />
    <path d="M12 11c0-2.4 1.9-4.4 4.5-4.9C16.5 8.6 14.6 11 12 11z" />
    <path d="M12 16c0-2.4 1.9-4.4 4.5-4.9C16.5 13.6 14.6 16 12 16z" />
    <path d="M12 11c0-2.4-1.9-4.4-4.5-4.9C7.5 8.6 9.4 11 12 11z" />
    <path d="M12 16c0-2.4-1.9-4.4-4.5-4.9C7.5 13.6 9.4 16 12 16z" />
  </Svg>
)

export const IconFoodSalad = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12.5h17a8.5 8.5 0 0 1-17 0z" />
    <path d="M8 12.5a2.8 2.8 0 0 1 2.6-3.9" />
    <path d="M13.5 12.5c-.4-2.4.8-4.2 3.2-4.9" />
    <path d="M10.5 8.6C10.2 6.4 11.4 4.8 14 4.2" />
  </Svg>
)

export const IconFoodSoup = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 11h15a7.5 7.5 0 0 1-15 0z" />
    <path d="M19.5 12.5h.8a2 2 0 0 1 0 4h-2.1" />
    <path d="M9 7.5c0-1.2 1-1.5 1-2.5M13 7.5c0-1.2 1-1.5 1-2.5" />
  </Svg>
)

export const IconFoodSandwich = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8.5 12 4.5l8.5 4-8.5 4z" />
    <path d="M3.5 12.5 12 16.5l8.5-4" />
    <path d="M3.5 16 12 20l8.5-4" />
  </Svg>
)

export const IconFoodPizza = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 20.5 20a1 1 0 0 1-1.3 1.3L12 18.5 4.8 21.3A1 1 0 0 1 3.5 20z" />
    <circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="9.8" cy="15" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.4" cy="15.2" r="1" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconFoodFruit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21c-4 0-7-3.5-7-8 0-3 2-5.5 4.5-5.5 1.2 0 1.9.5 2.5.5s1.3-.5 2.5-.5C17 7.5 19 10 19 13c0 4.5-3 8-7 8z" />
    <path d="M12 7.5c0-2 1.4-3.5 3.2-3.7" />
  </Svg>
)

export const IconFoodDrink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4.5h12l-1.2 14a2 2 0 0 1-2 1.9H9.2a2 2 0 0 1-2-1.9z" />
    <path d="M6.6 10h10.8" />
  </Svg>
)

export const IconFoodDessert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 10.5a6.5 6.5 0 0 1 13 0z" />
    <path d="M4.5 13.5h15" />
    <path d="M6 16.5h12" />
    <path d="M12 4.2v2.1" />
  </Svg>
)

export const IconFoodEgg = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c3.5 4 5.5 6.6 5.5 9.4A5.5 5.5 0 0 1 6.5 13c0-2.8 2-5.4 5.5-9.5z" />
  </Svg>
)

export const IconFoodSide = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.2" />
  </Svg>
)

/**
 * Match an item to a glyph by name first, then by menu category.
 *
 * Name wins because DineOnCampus categories are station names ("Nook",
 * "Sizzle") as often as they are food types.
 */
const FOOD_ICONS: Array<[RegExp, (p: IconProps) => JSX.Element]> = [
  [/salad|greens|lettuce|slaw|caesar/i, IconFoodSalad],
  [/soup|chili|broth|stew|bisque|pho|ramen/i, IconFoodSoup],
  [/sandwich|wrap|burger|sub|panini|burrito|taco|quesadilla|toast|bagel|bread|roll/i, IconFoodSandwich],
  [/pizza|flatbread|calzone/i, IconFoodPizza],
  [/chicken|turkey|beef|pork|steak|fish|salmon|shrimp|tilapia|bacon|sausage|meat|brisket|wings?/i, IconFoodPoultry],
  [/rice|pasta|noodle|quinoa|grain|potato|fries|oatmeal|cereal|granola|couscous|barley/i, IconFoodGrain],
  [/egg|omelet|omelette|frittata|tofu/i, IconFoodEgg],
  [/fruit|apple|banana|berry|berries|melon|orange|grape|pineapple|mango|peach/i, IconFoodFruit],
  [/coffee|tea|juice|milk|smoothie|soda|water|latte|lemonade|beverage|drink/i, IconFoodDrink],
  [/cake|cookie|brownie|pie|ice cream|dessert|pudding|donut|muffin|pastry|yogurt/i, IconFoodDessert],
  [/bowl|plate|entree|entrée|main/i, IconFoodBowl],
  [/vegetable|broccoli|carrot|beans?|corn|spinach|squash|side/i, IconFoodSide],
]

export function foodIcon(
  name: string | null | undefined,
  category?: string | null,
): (p: IconProps) => JSX.Element {
  const haystack = `${name ?? ''} ${category ?? ''}`
  const match = FOOD_ICONS.find(([pattern]) => pattern.test(haystack))
  return match ? match[1] : IconFoodBowl
}
