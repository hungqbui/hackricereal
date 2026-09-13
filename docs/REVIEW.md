# Review guide

This branch is large (~2,700 lines), but it is really **two unrelated changes
that happen to share a diff**. Reviewing them separately is much faster than
reading it top to bottom.

1. **A data-correctness bug in the backend** — ~40 lines, high stakes, worth
   reading closely. Start here.
2. **A UI rebuild of the four screens** — most of the line count, low stakes,
   mostly new files and CSS.

Nothing in part 2 can break part 1. If you only have ten minutes, read
[part 1](#1-the-nutrition-bug-read-this-part) and skim the rest.

---

## 1. The nutrition bug (read this part)

### What was wrong

`NUTRIENT_MAP` in `backend/app/services/nutrition.py` matched DineOnCampus
nutrient labels as **literal strings**:

```python
"Protein (g)": "protein_g",
"Total Carbohydrates (g)": "carbs_g",
```

UH serves **two labelling conventions side by side**, apparently from two
upstream feeds. Moody Towers sends `"Protein (g)"`. Cougar Woods sends plain
`"Protein"`, with the unit in a sibling `uom` field:

```json
{ "name": "Protein", "value": 11.0, "uom": "g", "valueNumeric": 11.0 }
```

Only `"Calories"` matched at the bare-name locations — it is the one label with
no unit suffix. **Every other macro came back `null` for entire dining halls.**

`sum_macros` then folded those nulls into `0.0`, so the API reported
`"protein_g": 0.0` as a fact. Two consequences:

- The UI stated **"0g protein"** on recommendations that had plenty of protein.
- `fallback_selection` (the no-Gemini greedy planner) ranks items by protein
  per calorie. At those locations it was **sorting on a column of zeros** — so
  the offline planner was not doing the one thing it exists to do.

### Measured effect

Across all 1,131 items UH published on 2026-09-13:

| | before | after |
|---|---|---|
| Cougar Woods protein | 0% | **100%** |
| Moody Towers protein | 100% | 100% |
| Campus-wide protein | 59% | **95%** |
| carbs / fat / fibre | 59% | 95% |
| calories (unchanged) | 97% | 97% |

### What to check

**`normalise_nutrient()` strips a trailing parenthesised unit and lower-cases.**
The near-miss labels are the whole risk here. These four all appear in live UH
data and must **not** map to a macro:

| label | normalises to | must not become |
|---|---|---|
| `Calories From Fat` | `calories from fat` | `calories` |
| `Fat Calories` | `fat calories` | `calories` |
| `Trans Fat` | `trans fat` | `fat_g` |
| `Saturated Fat + Trans Fat (g)` | `saturated fat + trans fat` | `saturated_fat_g` |

They are absent from `NUTRIENT_MAP` by design. **If you add an alias to that
map, re-check this table** — a careless `"fat": "fat_g"` entry would not break
these four, but a substring match instead of exact lookup would break all of
them.

`Sugar (g)` and `Sugars` both appear upstream; both are mapped.

### The second change: `sum_macros` returns `None`

A macro **no** row published is now `None` instead of `0.0`.

- A **genuine** zero still reports `0.0` (verified: Cougar Woods breakfast
  returns `"saturated_fat_g": 0.0`).
- A **partial** total — some rows have the macro, some do not — sums the known
  values rather than discarding them. It errs low, which is the safe direction
  for a number a student eats against. Flag if you disagree; it is a one-line
  change.
- `empty_totals()` is **unchanged** and still returns zeros. A plan that
  selected nothing has genuinely zero intake; that is different from unknown.
  `sum_macros([])` returns all-`None`, and the only caller guards the empty
  case explicitly (`gemini.py:351`).

**Contract change.** `MealOut.totals` and `PlanContentOut.totals` widened from
`dict[str, float]` to `dict[str, float | None]`. Two knock-ons:

- `_target_fit` now skips a field whose actual is `None` — there is no honest
  delta against an unknown, and scoring it as zero made plans look like
  failures. So `target_fit` may now omit `protein_g`; **any client iterating it
  must not assume every requested target appears.**
- Frontend `totals` typed `number | null`. `macroValue()` already rendered
  `null` as `—`, so only the prop types needed widening — no display logic
  changed.

### Verifying it yourself

```bash
cd backend && ./.venv/bin/python -c "
from app.services.nutrition import sum_macros
print(sum_macros([{'calories': 100.0, 'protein_g': None, 'servings': 1}]))
# protein_g must be None, calories must be 100.0
print(sum_macros([{'calories': 100.0, 'protein_g': 0.0, 'servings': 1}]))
# protein_g must be 0.0 -- a real zero survives
"
```

End to end, against live UH data:

```bash
# Taco Stand genuinely publishes no protein -> null, and target_fit omits it
# Cougar Woods does -> real numbers, target_fit includes protein_g
curl -s -X POST localhost:8000/plans/generate -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"location_id":"668565d6c625af0600dd8cf9","date":"2026-09-13","days":1,
       "targets":{"calories":800,"protein_g":45}}' | jq .content.totals
```

---

## 2. The UI rebuild

Four screens rebuilt against the mockups, driven by the real backend. Mostly
**new files** — `AdvisorScreen`, `DiningScreen`, `MealsScreen`,
`ProfileScreen`, `AppShell`, `LogMealSheet`, `ui.tsx`, and four `state/`
modules — plus ~2,100 lines appended to `styles.css`.

`DECISIONS.md` records the forks that could have gone the other way. The three
worth knowing before you read the diff:

- **The week planner was not deleted.** It moved from the Advisor tab into
  **My Meals → This Week**, intact — it is the most backend-complete part of
  the app (real generation, refinement, availability lookups, a concurrency
  pool). `MealsScreen` therefore takes a wide props object, because the planner
  state stays in `App` so a board survives a tab switch.
- **Profile and the meal log are `localStorage` only**, namespaced per user id,
  behind `useProfile()` / `useMealLog()`. The `users` table stores credentials
  and nothing else, and there is no `logged_meals` table. **No component
  touches storage directly**, so the swap is contained.
  [`docs/BACKEND.md`](BACKEND.md) is the build guide: two tables, six
  endpoints, about four frontend files.
- **Design tokens replaced the palette by remapping existing token names** at
  the top of `styles.css` rather than rewriting 1,500 lines of working CSS.
  Two deliberate casualties: the orange accent is gone, and so is dark mode
  (the tokens define a light palette only). The dark block is the most
  reversible thing here.

### Things that will look odd in the diff

- **`useGSAP`, never a bare `useEffect`.** React 19 double-invokes effects;
  the second `gsap.from` reads the half-faded element as its *start* value and
  strands whole sections near opacity 0. `useGSAP` reverts on cleanup. This is
  a real bug that was hit and fixed — please keep new animation code on it.
- **`.filter-chip:hover:not(:disabled):not(.active)`** — the `.active` guard
  is load-bearing. Without it `:not(:disabled)` raises the hover rule's
  specificity above `.filter-chip.active`, and a hovered selected chip renders
  white-on-pale.
- **Conversational words in `GENERIC_TOKENS`** (`lib/parse.ts`). "What should
  I eat now?" resolved to the hall **What It Do BBQ** — "what" is distinctive
  in that name and scored exactly at the threshold. The planner never hit this
  because it receives phrases like "3 days at Moody Towers", not questions.
- **Illustrated glyphs, not food photos.** DineOnCampus publishes no item
  imagery for UH (`useMenuImages: false`, `locationMenuImages: []` on every
  location). Glyphs match on item name first, menu category second, because
  DineOnCampus categories are station names ("Nook", "Bold Bistro") as often as
  food types.

---

## 3. Backend changes you did not ask for

`backend/app/routers/auth.py` and `plans.py` carry fixes that **predate this
work** and are unrelated to the UI. A clean checkout would not boot without
them: `User.full_name`, `User.dietary_notes` and `User.targets` are referenced
in three places but do not exist on the model.

The fix drops `PATCH /auth/me` (it only wrote those three non-existent columns)
and passes `dietary_notes=None` / empty targets in `plans.py`. **Targets now
travel with the request**, which is what the frontend already does.

If you would rather keep the endpoint, the alternative is adding the three
columns to `User` — a migration, and it duplicates what the Profile screen
already stores client-side. Worth a decision either way.

---

## 4. What was and was not verified

**Verified**, headlessly in Chromium at 1440px and 390px, signed up through the
real auth flow against live UH data:

- All four tabs render; no horizontal overflow at either width.
- The Advisor answers a question end to end and returns real menu items with
  real macros.
- `tsc --noEmit` is clean.
- The `sum_macros` semantics above, as unit assertions.

**Not verified:**

- **No automated tests were added.** The nutrition changes are the ones that
  deserve them — `normalise_nutrient` and the near-miss table are exactly what
  a regression test should pin. I did not add a suite because the repo has no
  test harness to extend; say the word and it is a small job.
- **Gemini paths.** `GEMINI_API_KEY` is unset locally, so every recommendation
  in this branch came from `fallback_selection`. The Gemini generation and
  refinement paths are **untested against this diff** — `hydrate_plan` is
  shared by both, so the `sum_macros` change affects them identically, but that
  is reasoning, not evidence.
- **Only one day of menu data** (2026-09-13). The two-labelling-convention
  finding held across all 20 locations that day. If UH changes feeds, the
  normalisation still holds; a *third* convention would not.
- Real iOS/Android browsers — only Chromium at a phone viewport.
