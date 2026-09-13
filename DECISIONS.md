# Decisions

Why UniBite is shaped the way it is. Each entry is a fork that could reasonably
have gone the other way, so the reasoning is worth keeping.

---

## 1. Advisor stays one idea; the week planner moved to My Meals

**Decision.** The Advisor tab shows a greeting, today's numbers, the live hall
context, four prompt chips, a composer, and — once you ask — one recommendation.
Nothing else. The original multi-day planner (`Composer` + `WeekBoard` +
`DayDetail`, about 1,500 lines wired to `/plans`) moved wholesale into
**My Meals → This Week**.

**Why.** The brief for the Advisor was "clean and without any clutter". A
prompt box that sometimes answers with one meal and sometimes with a
seven-column calendar is two products on one screen, and the calendar is the
one that loses — it is the surface you want when *planning ahead*, which is a
My Meals question, not a "what should I eat right now" question.

**Why not delete it.** It is the most backend-complete part of the app: real
generation, real refinement, availability lookups, per-day error handling, a
concurrency pool, and persistence. Deleting working code to match a mockup that
simply did not cover multi-day planning would have been a straight loss.

**Consequence.** `MealsScreen` takes a wide props object, because it passes the
planner's state straight through from `App`. That state stays in `App` so a
board survives switching tabs.

---

## 2. Profile and the meal log are local-first, with a documented swap

**Decision.** `StudentProfile` and `LoggedMeal` live in `localStorage`,
namespaced per user id, behind `useProfile()` and `useMealLog()`. No component
touches storage directly.

**Why.** The backend has nowhere to put them — `users` is
`id / email / password_hash / created_at`, and there is no logged-meal table.
`plans.py` even says so in a comment: targets "travel with the request rather
than living on a profile". Building the UI first was the explicit call.

**Consequence.** Totals do not follow you to another device, and a private
window starts empty. Every storage access is `try`/`catch`ed, so blocked storage
degrades to "nothing persists" rather than a crash.

**The swap** is written up in [`docs/BACKEND.md`](docs/BACKEND.md): two tables,
six endpoints, and roughly four files to touch on the frontend.

---

## 3. The Advisor drives `/plans/generate`, not a new chat endpoint

**Decision.** A question becomes a one-period plan request: hall + today +
current period + *remaining* macro targets + the question and preferences as
`constraints`.

**Why.** `/plans/generate` already does the hard part — Gemini function calling
over a real menu, with every macro recomputed server-side from the DineOnCampus
payload. A separate chat endpoint would have duplicated that and reintroduced
the risk the current design rules out: a model inventing nutrition numbers.
Scoping to one period is what turns a day planner into a meal recommender.

**The nice consequence:** targets are set to goals *minus* what you have logged,
so logging a meal genuinely changes the next recommendation. That is the
product's whole claim, and it holds without any new backend.

---

## 4. Illustrated category glyphs instead of food photography

**Decision.** Item and meal thumbnails are stroked glyphs on a soft-green tile,
matched to an item by name first and menu category second (`foodIcon()`).

**Why.** The mockups show a photo on every card, but DineOnCampus publishes
none — `useMenuImages` is `false` and `locationMenuImages` is empty on every UH
location. The alternatives were stock photos that would confidently show the
wrong dish, or nothing at all. Glyphs stay honest, extend the existing 24×24
stroked icon family, cost nothing to load, and work offline.

**Name before category**, because DineOnCampus categories are station names
("Nook", "Bold Bistro", "Sugar Rush") as often as they are food types.

---

## 5. The design tokens replaced the palette wholesale

**Decision.** `unibite-design-tokens.json` adopted verbatim: `#FAF9F5` ground,
`#1F5D46` forest-green primary, Inter, 10/16/22px radii, the token shadows.

**How.** Rather than rewrite 1,500 lines of working CSS, the **existing token
names were remapped onto the new values** at the top of `styles.css`. Every
pre-existing rule inherited the new look for free.

**Two casualties, both deliberate:**

- **The orange accent is gone.** `--accent` now points at the forest green. The
  mockups carry no orange anywhere.
- **Dark mode is gone.** The `prefers-color-scheme: dark` block was removed
  because the tokens define a light palette only, and inventing a dark ramp
  would have been designing past the spec. This is the most reversible decision
  here — a dark remap of the same token names restores it in one block.

---

## 6. Hash-based tabs instead of a router

**Decision.** `useTab()` keeps the active tab in state and mirrors it to
`location.hash`.

**Why.** The app had no router and did not need a dependency for four tabs, but
a bare `useState` would have broken the browser's Back button and lost your
place on reload. About twenty lines buys both.

---

## 7. Fixes made along the way

Two bugs worth recording, since both would have been easy to ship:

- **`matchLocation` matched a hall off a conversational word.** "What should I
  eat now?" resolved to **What It Do BBQ**, because "what" is a distinctive
  token in that hall's name and scored exactly at the threshold. The planner
  never hit this — it receives phrases like "3 days at Moody Towers", not
  questions. Fixed by adding conversational words to `GENERIC_TOKENS`, which
  improves both surfaces.

- **`gsap.from` inside `useEffect` is not StrictMode-safe.** React 19 invokes
  effects twice; the second `from` read the half-faded element as its *start*
  value and stranded whole sections near opacity 0. The existing components all
  use `useGSAP`, which reverts on cleanup — the new ones now do too. **New
  animation code must use `useGSAP`, not a bare effect.**

- **Every macro but calories was null, and it was our bug.** UH serves two
  nutrient-labelling conventions side by side — Moody Towers reports
  `"Protein (g)"`, Cougar Woods plain `"Protein"` with the unit in a sibling
  `uom` field. `NUTRIENT_MAP` matched literal strings, so whole dining halls
  came back with `protein_g: null` on every item and `nutrition.py` summed the
  nulls to `0.0`. Recommendations then stated "0g protein" as fact, and the
  greedy planner — which ranks by protein per calorie — was sorting on a
  column of zeros. Labels are now normalised to a unit-less key before lookup:
  protein coverage went from 0% to 100% at both dining commons, 95% campus-wide.
  The near-miss labels ("Calories From Fat", "Trans Fat", "Saturated Fat +
  Trans Fat") normalise to distinct keys and are deliberately unmapped.

  The Advisor still guards the genuine gaps — two locations publish no protein
  at all — by reading the *items* rather than the totals, since a summed `0.0`
  cannot be told from a real zero.

- **The offline planner's summary is engineering prose.** Without a Gemini key
  the backend writes "Greedy selection maximising protein per calorie within
  each meal period's calorie budget", which is precisely the register the tone
  guidance rules out. The Advisor composes its own sentence for fallback plans
  and titles the card after the item or the period, never "Balanced day (offline
  planner)".
