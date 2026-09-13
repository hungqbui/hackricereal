# UniBite — UI / UX map

Companion to the root [`README.md`](README.md) (what the app is) and
[`DECISIONS.md`](DECISIONS.md) (why it is shaped this way). This file is the map
of **what the user sees and does** — surfaces, states, visual language.

Stack: React 19 + TypeScript + Vite, **GSAP** (`gsap` + `@gsap/react`) for
motion, Inter from Google Fonts. There is **no CSS framework**: every rule is
hand-written in `src/styles.css`, driven by the tokens in
`unibite-design-tokens.json`. `shadcn` appears in `devDependencies` and
`.mcp.json` as an authoring tool only — no shadcn component and no Tailwind is
imported anywhere in `src/`. **No router either**: the active tab lives in
`location.hash` via `useTab()`.

> **This file was written for the single-screen planner.** The app is now four
> tabs, and the planner is one view inside one of them. §1 below is rewritten
> for the new shape; **§2 and §4–§9 still describe the planner accurately**,
> because `Composer`, `WeekBoard`, `DayDetail` and the availability logic moved
> unchanged into **My Meals → This Week**. Read §3 as the planner's states.

## 1. Screen map

```
<App>
 └─ <AuthProvider>
     └─ <Root>                        ready? → splash spinner
         ├─ <AuthScreen>              no user
         └─ <UniBite>                 signed in
             └─ <AppShell>            header · screen · bottom nav
                 ├─ <AdvisorScreen>   #/advisor
                 ├─ <DiningScreen>    #/dining   (hall list ⇄ hall menu)
                 ├─ <MealsScreen>     #/meals    (Today · This Week · This Month)
                 │    └─ This Week → <Composer> + <WeekBoard> + <DayDetail>
                 ├─ <ProfileScreen>   #/profile
                 └─ <LogMealSheet>    overlay, from My Meals
```

### Shell (`components/AppShell.tsx`)
A sticky header (wordmark + avatar, which jumps to Profile) and a bottom nav of
four items. Each nav item is a real `<button>` with `aria-current="page"`, a
44px minimum target, and active state carried by **weight, colour and a bar** —
never colour alone. On desktop (≥900px) the nav becomes a floating pill centred
over the page.

### Advisor (`components/AdvisorScreen.tsx`)
Two states, one screen.

**Idle** — greeting by clock (`Good morning/afternoon/evening, <name> 👋`), a
summary card (calorie ring + protein + meals), a context card naming the hall
that is open right now with its published status sentence, four quick prompts,
and the composer. An insight card appears once something is logged.

**Conversing** — the snapshot is replaced by the thread: user bubbles right,
assistant bubbles left behind a spark avatar, a three-dot typing bubble while
`state === 'thinking'`, and a **recommendation card** on the turn that carries a
plan. The card shows the period eyebrow, a title, the hall, up to
`MAX_CARD_ITEMS` (5) items with calories, a three-tile macro row, the projection
sentence ("that would put you at about 2,030 calories…"), a fallback-planner
note where relevant, then **Add to my meals** and **See alternatives**.

The engine is `state/advisor.ts` — see the README for how a question becomes a
`/plans/generate` call.

### Dining (`components/DiningScreen.tsx`)
**Hall list** — a building selector, Now / Later / All filters, and a card per
hall: initial tile, name, building, and a status chip (dot **and** words) from
`GET /dining/locations/{id}/details`. Sorted open → closing → unknown → closed.
Statuses load through a concurrency-4 pool into a module-level cache.

**Hall menu** — back button, hall name and status, period chips, category
chips, a search field once the menu exceeds 8 items, then a row per item: food
glyph, name, calories · protein · portion, diet tags, an allergen warning when
the item collides with the student's own allergy list, and a quick-add that
writes straight to the log and flips to a check.

### My Meals (`components/MealsScreen.tsx`)
A segmented control over three views.

- **Today** — day stepper, two rings (calories, protein), "n of 3 meals
  logged", then a timeline with a row per slot in `MEAL_SLOTS` order. Empty
  slots render a dashed "Not logged yet" row with a `+`. An insight card closes
  the screen.
- **This Week** — the original planner, whole: `Composer`, `WeekBoard`,
  `DayDetail`. §2 and §4–§7 describe it.
- **This Month** — averages over 30 days and a 14-day bar trend, with the whole
  chart carrying a sentence as its `aria-label`.

### Profile (`components/ProfileScreen.tsx`)
Identity (editable name, email), then grouped settings: daily goals (number
field + slider), dietary preference, allergies in the DineOnCampus vocabulary,
free-text foods to avoid, favourite halls, typical meal times, and account. A
note at the top, and a hint on each group, says **how that setting reaches the
advisor** — goals as numeric targets, the rest as constraint sentences.

### Log meal sheet (`components/LogMealSheet.tsx`)
A bottom sheet (centred dialog on desktop), Escape to close. Pick a slot, then
either browse a live menu — hall select, period chips, search — or type an
off-campus entry. The manual path is the only place in the app where a macro is
not server-computed, and the sheet says so.

## 2. Availability — the thing that isn't obvious

`state/availability.ts` is the biggest functional addition beyond layout, and
it exists because halls genuinely differ: Moody Towers runs
Breakfast/Lunch/Dinner/Everyday, Cougar Woods adds Late Night, a retail stand
may publish one period or none, and **menus are only posted a couple of weeks
out**, so a far-future date comes back empty even for a hall that serves all
day.

`useAvailability(locationId, dates, selectedPeriods)` loads the real period list
for every selected date and derives:

| Field | Meaning |
|---|---|
| `served` | period names served on at least one selected day |
| `partial` | served on some selected days but not all |
| `closedDates` | selected dates the hall publishes no menu for |
| `allClosed` | every selected date is known to publish nothing |
| `unavailableSelected` | periods the user picked that this hall never serves |

How that reaches the screen:

- A period the hall never serves is **disabled** and struck through
  (`.unserved`). One served on only some days gets `.partial` and a warning
  glyph.
- Until the lookup resolves, every chip is treated as offerable — otherwise the
  whole row would flash to "not served" on each keystroke.
- Dates with no menu get a warning glyph on their chip.
- `allClosed` **disables Build plan** and explains why, rather than letting you
  submit a request that can only come back empty.

The period cache is module-level and shared with the plan board (`board.ts`
imports `fetchPeriods` from here), so picking a day in the composer and then
planning it costs one request, not two.

---

## 3. Loading, empty and error states

Per-day, never a full-page block — one dead day can't take the week down.

| Where | State | What the user sees |
|---|---|---|
| Root | token check | centered spinner |
| Auth | submitting | button → "Working…" |
| Composer | `busy` | button → "Planning…" |
| Composer | `allClosed` | Build plan disabled + "try another hall or a nearer date" |
| Composer | some dates closed | "No menu for Thu. That day will be skipped." |
| Day column | `queued` / `loading` | spinner + "Queued" / "Planning…" |
| Day column | `refining` | spinner + "Refining…" |
| Day column | `empty` | **Closed** chip in the header, `IconCalendarOff` + "No menu published." |
| Day column | `error` | `IconWarn` + the API message |
| Day column | restored, plan gone | "This plan is no longer available." |
| App | locations fetch failed | error line above the composer |
| App | no `GEMINI_API_KEY` | top banner; mode pill reads **Offline** |
| Drawer | refine failed | error above the refine textarea |
| Any | backend down | "Could not reach the UniBite API. Is the backend running?" |

A hall that simply isn't serving reads as *closed*, not as a failure — only a
real error gets the alarm glyph. Generation and refinement both run through a
**concurrency-2 pool** in `state/board.ts`.

---

## 4. Visual language

All tokens live at the top of `styles.css`, remapped from
`unibite-design-tokens.json`. The original token *names* were kept and pointed
at the new values, so every pre-existing rule inherited the new palette without
being rewritten. **Light only** — see DECISIONS.md §5 on the dropped dark mode
and the retired orange accent.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f2efe4` | `#1e241f` | cream page ground |
| `--surface` | `#fbfaf4` | `#262e27` | cards, columns, drawer |
| `--surface-2` | `#e8e4d6` | `#303a31` | headers, hovers, code |
| `--brand` / `--ink` / `--ink-2` / `--ink-3` | deep green ramp | | text and the mark |
| `--sage` / `--sage-soft` | `#8fae8a` | | secondary surface, **not** a third accent |
| `--line` | `#dad5c4` | `#3a443b` | hairlines |
| `--accent` | `#e2832f` | `#f0a05a` | the single orange accent |
| `--accent-strong` | `#b25e19` | | white on `--accent` is only 2.7:1; this step clears 4.5:1 |
| `--on` / `--near` / `--off` | green / amber / red | | macro-fit tones |

Conventions that hold across the sheet:

- **Warm off-white ground, deep forest green primary.** One green; sage is a
  tint of it, not a second accent. No orange anywhere.
- Radii 22px sheets / 16px cards / 10px controls / pill for chips and nav.
- Type is **Inter** throughout (preconnected and loaded in `index.html`),
  16px/1.5 body, headings 650 with `-0.02em`.
- Every interactive surface carries a visible `:focus-visible` ring in
  `--accent`, and no state is encoded by colour alone.

### The icon system (`components/icons.tsx`)
One stroked family, 24×24 on a single grid, 1.9 stroke, all `currentColor`, so
a row of them reads as one weight. ~34 icons: the logo, four period glyphs,
eight macro glyphs (`MACRO_ICONS`), diet/allergen glyphs, and UI glyphs.

**Icons frequently replace words here** — macro names in `MacroPills` and
`TargetFit`, "cal"/"protein" in `MacroLine`, P/C/F on item rows, period names on
meal cards. The rule the file states, and that new code must follow: *anywhere
an icon replaces a word, the word still ships as `aria-label`/`title`*, so the
meaning survives for screen readers and is one hover away for everyone else.

`FitRing` is the same idea at component scale — an SVG arc replaces the
"78% of target" caption, with the sentence in the tooltip. Its colour comes
from `fitTone()` (`on` ≤10% drift, `near` ≤25%, `off` beyond).

### Responsive (`@media (max-width: 760px)`)
Topbar wraps and the context line takes its own row; the composer's button
stacks under a now-bordered textarea; the board flips from columns to stacked
rows; item rows go vertical with macros inline; the drawer becomes `100vw`.
`.main` caps at 1180px. (See §7 for a gap in this.)

---

## 5. Motion

Everything routes through `lib/motion.ts`, which is the single source of
rhythm — `DUR` (fast `.18` / base `.42` / slow `.7`), `EASE` (`power3.out` for
arrivals, `power2.out` for meters, one `back.out` kept for direct user
actions), and `STAGGER` (`.055` each). Components import these rather than
writing their own numbers, so the whole surface moves together.

| What | Where |
|---|---|
| Day columns deal in | `WeekBoard` — keyed on board *identity*, not contents, so a refinement doesn't re-deal the week |
| Meal cards stagger | `DayColumn`, on the transition into `ready` |
| Drawer opens | `DayDetail` — one timeline: scrim fades, panel slides, then sections stagger |
| Macro pills | `MacroPills`, on value change |
| Target bars fill | `TargetFit`, `scaleX` from left |
| Fit ring sweeps | `FitRing`, animating `strokeDashoffset` |

**Reduced motion is handled globally, once.** `initMotion()` runs in
`main.tsx` before first render and sets
`gsap.globalTimeline.timeScale(200)` when the media query matches — every tween
still runs, keeping `onComplete` callbacks and stagger ordering intact, but
resolves within a frame. This is why no component branches on reduced motion,
and new components shouldn't either. The listener also reacts to the setting
changing mid-session.

---

## 6. Accessibility

Handled: semantic `header`/`main`/`section`/`article`/`aside`, `aria-label` on
the board and drawer, `aria-expanded` on the account toggle, labelled inputs,
Escape closes the drawer, real `<button>`s throughout, reduced motion honoured
globally, an icon family that keeps its words as accessible names, a deliberate
`--accent-strong` for contrast on orange, and disabled-with-explanation rather
than silently-broken period chips.

Known gaps:
- The drawer is not a focus trap, and focus is neither moved into it on open
  nor restored on close.
- The scrim is `role="presentation"` with a click handler, so backdrop
  dismissal is mouse-only (Escape covers the keyboard).
- `ProfileMenu` closes only via its own button — no Escape, no outside click.
- No live regions, so "Planning…" → ready is silent to a screen reader.
- Period toggles are buttons rather than `aria-pressed` toggles.
- Several affordances are `title`-only, which never appears on touch.

---

## 7. Known issues

- **Short plans don't fill the width on phones.** The mobile query resets
  `.board-scroll`, but `.board-scroll.sparse` (specificity 0-2-0) keeps its
  `grid-auto-columns: minmax(228px, 340px)` and `justify-content: start`, so a
  1–3 day board stays capped and left-aligned on a narrow screen instead of
  going full-width. Fix: reset both in the media query.
- **Dead code**: `countTo()` and `prefersReducedMotion()` in `lib/motion.ts`
  and `CalorieMeter` in `Macros.tsx` are defined but never imported.

---

## 8. Backend surface the UI uses

`health`, `auth/register`, `auth/login`, `auth/me`, `dining/locations`,
`dining/locations/{id}/periods`, `plans/generate`, `plans/{id}/refine`,
`plans/{id}`.

**Exists in the backend but has no UI** — the obvious places to grow:
- `GET /plans` — a saved-plans history. There's no way to reach an old board
  beyond the one in `localStorage`.
- `DELETE /plans/{id}` — wired in `api.deletePlan`, never called.
- `GET /dining/locations/{id}/menu` and `/details` — the raw menu is never
  browsable; items are only reachable through a generated plan.

Note the backend does **not** currently start from a clean checkout — see the
stale `User`-column references in `app/routers/`, and the unsatisfiable
`pydantic` pin in `requirements.txt`.

---

## 9. Persistence

- `unibite.token` — JWT in `localStorage`. A 401 on startup clears it; any
  other failure (backend down) keeps the session.
- `unibite.board.<userId>` — the board as **plan ids only**, re-fetched via
  `GET /plans/{id}` on load. A deleted plan degrades to an error cell.
- Every `localStorage` access is try/caught, so private browsing loses
  persistence rather than breaking.
- Otherwise only the module-level period cache in `state/availability.ts`,
  which lives for the session.
