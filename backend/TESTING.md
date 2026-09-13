# Backend tests

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate     # Windows
pip install -r requirements-dev.txt

pytest                       # 102 offline tests, ~16s, no network, no API keys
pytest -m live               # real DineOnCampus API
pytest -m gemini             # real Gemini (needs GEMINI_API_KEY)
pytest -m "live or gemini"   # everything
```

The default run is fully offline. `live` and `gemini` are opt-in because
they need the network, cost money, and depend on what the dining halls
happen to be serving.

## How the offline suite avoids the network

`tests/fixtures/` holds real payloads recorded from DineOnCampus: two
different dates at Moody Towers plus one day at Cougar Woods. The
`upstream` fixture swaps the client's **HTTP session** (not `_get`), so
caching, retries and error handling still run for real. Any request the
recordings do not cover returns 404, so a test can never silently fall
through to the live API.

Refresh the recordings when the upstream changes:

```bash
python tests/fixtures/_capture.py
```

`pytest -m live` includes `test_live_fixtures_still_match_the_upstream_shape`,
which fails if the recordings have drifted.

## What the suite covers

| File | Concern |
| --- | --- |
| `test_menu_retrieval.py` | The right menu for the right day and location |
| `test_nutrition.py` | Macro parsing and arithmetic |
| `test_meal_plan.py` | Plan integrity and health awareness |
| `test_gemini.py` | Structured generation and tool-based refinement (model mocked) |
| `test_api.py` | Auth, persistence, per-user isolation |
| `test_live.py` | Real DineOnCampus and real Gemini |

### Right menu, right day

The upstream returns *a* menu for almost any request, so a wrong date or
a period id from another location yields plausible but incorrect food.
These tests pin location, date and period end to end: the two recorded
dates have genuinely different lunches (they share only ~73 of ~128
items), period ids are shown not to overlap between locations, an
unknown period yields an empty menu rather than another period's food,
and a generated plan is asserted to draw only from that day's catalog.

### Health awareness

Two independent guarantees:

* **Integrity.** The model only ever *selects* items (id, servings,
  reason). Every macro is recomputed server-side from the menu, so a
  model that reports 99999 calories, invents an item id, or asks for
  zero servings cannot corrupt a stored plan. `assert_plan_is_coherent`
  re-derives every total straight from the catalog.
* **Nutrition.** Plans are asserted to land near the calorie target,
  carry real protein, avoid condiment-only selections, cover the day's
  meal periods, and never violate a dietary exclusion (vegan,
  vegetarian, or a named allergen). Separate tests assert the model is
  actually *given* the tags, allergens, macros and targets it needs —
  including that every item on the menu is reachable in the prompt.

The same health assertions run against the real model under
`pytest -m gemini`, so adding a key upgrades them from "the planner is
wired correctly" to "the model's output is genuinely health-aware".
