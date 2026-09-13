# CougarGrub — frontend

A small React + TypeScript app over the CougarGrub API. You describe a day or a
week in plain English; it builds meal plans from the **live** University of
Houston DineOnCampus menus and lets you talk the plan into something better.

There is no mock data anywhere in this app. Locations, meal periods, menu items
and every macro number come from the backend, which in turn reads the real
DineOnCampus v4 API.

## Run it

The backend must be running first (see `../backend`):

```bash
cd backend
DATABASE_URL="sqlite+aiosqlite:///./dev.db" \
JWT_SECRET="something-long-and-random" \
uvicorn app.main:app --port 8000
```

Then:

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser never
makes a cross-origin request. Point it somewhere else with `VITE_BACKEND_URL`
(see `.env.example`). For a production build served from another origin, set
`VITE_API_BASE` to the API root instead.

```bash
npm run build        # typecheck + bundle to dist/
npm run typecheck
```

### Gemini

Plan *generation* works without a Gemini key — the backend falls back to a
deterministic greedy planner, and the app labels those plans as such.
**Refinement requires `GEMINI_API_KEY` on the backend**; without it the API
returns 503 and the refine box shows that message. Set the key in
`backend/.env` to get real natural-language refinement.

## How a sentence becomes a plan

`POST /plans/generate` takes a location, a date, optional period ids, optional
numeric targets, and a free-text `constraints` string. The app fills those in
like this:

1. `src/lib/parse.ts` reads the sentence for the four structured things the API
   needs: **which dining hall** (matched against the live location list by its
   distinctive words), **which dates** (`tomorrow`, `this week`, `monday and
   wednesday`, `next 3 days`, `9/15`, …), **which meal periods**, and **numeric
   macro targets** (`2200 calories`, `150g protein`, `40g fiber`, …).
2. Everything it inferred is shown back as editable chips. A wrong guess is a
   click to fix, not a dead end.
3. The **entire original sentence** is still sent as `constraints`, so the taste
   and safety parts — "no nuts", "nothing too heavy before practice" — reach
   Gemini untouched. The parser never has to understand them.
4. Each date is generated independently, two at a time, and dropped into its own
   column. A day the hall has not published a menu for says so instead of
   failing the batch.

Refinement posts your instruction to `POST /plans/{id}/refine`, which the
backend resolves through Gemini function calling. One button applies it to the
open day; the other applies it to every planned day.

## Layout

```
src/
  api/          typed client + response types mirroring backend/app/schemas.py
  lib/          date maths, the natural-language parser, macro formatting
  state/        auth context, plan-board orchestration and persistence
  components/   Composer (ask + chips), WeekBoard (calendar), DayDetail (drawer)
```

The calendar deliberately shows only what you need to pick a day: period, three
item names, calories and protein, plus a bar against your calorie target.
Portions, reasons, allergen tags, per-item macros, caveats and revision history
live in the drawer.

## Notes

- The auth token lives in `localStorage`; so does the current board, as plan ids
  that are re-fetched on load. Nothing else is cached client-side.
- Every macro shown is computed server-side from the real menu payload. The
  model only ever picks item ids and serving counts, so it cannot invent
  nutrition data.
