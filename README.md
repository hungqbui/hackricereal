# UniBite

**Eat Smarter. Live Better.** — your personal campus dining advisor.

UniBite answers one question well: *what should I eat right now?* It answers it
using two things at once — **what you have already eaten today**, and **what the
University of Houston dining halls are actually serving at this minute**.

There is no mock menu data anywhere in this app. Every dining hall, meal period,
menu item and macro number comes from the backend, which reads the live
DineOnCampus v4 API. The AI only ever picks item ids and serving counts; the
server recomputes every calorie from the real payload, so a recommendation
cannot invent nutrition it does not have.

```
┌──────────┐   plain English    ┌─────────┐   item ids only   ┌────────────┐
│ Student  │ ─────────────────▶ │ UniBite │ ────────────────▶ │   Gemini   │
└──────────┘                    │   API   │ ◀──────────────── └────────────┘
     ▲                          └─────────┘   macros recomputed server-side
     │  real items, real macros       │
     └───────────────────────────────┘│ live menus
                                       ▼
                            DineOnCampus v4 (UH)
```

---

## The four screens

| Tab | What it does |
|---|---|
| **Advisor** | Your greeting, today's calories/protein/meals, which hall is open right now, four quick prompts, and a composer. Ask a question, get **one** meal recommendation with the reasoning behind it, then *Add to my meals* or *See alternatives*. |
| **Dining** | Every hall on campus with its live open/closed status, filtered by Now / Later / All and by building. Open one to browse the real menu by meal period and category, with calories, protein, diet tags and allergens per item — and a quick-add on every row. |
| **My Meals** | **Today** is your logged-meal timeline and daily rings. **This Week** is the multi-day planner — describe a week in plain English and UniBite builds each day from the live menu, then talk it into shape. **This Month** is your rolling averages and a two-week trend. |
| **Profile** | Calorie and protein goals, dietary preference, allergies, foods to avoid, favourite halls and typical meal times. Every one of these is sent with each recommendation — the screen says so, per setting. |

## How the Advisor actually works

There is no chat endpoint on the backend, and it does not need one.
`POST /plans/generate` already accepts a free-text `constraints` string and
returns real menu items with server-computed macros. The Advisor drives it
scoped to a **single meal period**, so a whole-day planner returns one meal:

1. **Pick the hall** — one named in your question, else your favourite, else the
   nearest dining commons.
2. **Pick the period** — whatever that hall is serving around now.
3. **Set the targets to what is left** — your goals *minus* what you have
   already logged, so the suggestion fits the remaining room in your day rather
   than the whole day.
4. **Send the question verbatim**, plus your diet and allergy sentences and a
   line about what you have eaten, as `constraints`.

*See alternatives* is `POST /plans/{id}/refine`.

---

## Running it

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

DATABASE_URL="sqlite+aiosqlite:///./dev.db" \
JWT_SECRET="$(python -c 'import secrets;print(secrets.token_urlsafe(48))')" \
uvicorn app.main:app --port 8000
```

Check it with `curl localhost:8000/health`.

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser never
makes a cross-origin request.

### Gemini (optional, but you want it)

Plan **generation** works without a key — the backend falls back to a
deterministic greedy planner and the app labels those recommendations as such.
Plan **refinement** ("See alternatives") *requires* `GEMINI_API_KEY`; without it
the API returns 503 and the app shows that message. Put the key in
`backend/.env`. The Profile tab tells you which mode you are in.

---

## What is real, and what is not

Being straight about this matters more than the demo looking complete.

**Backed by the live API and the database:** dining halls, open/closed status
and hours, meal periods, menus, every macro, diet tags, allergens, AI
recommendations, plan refinement, multi-day plans, and your account.

**Held in the browser only, for now:** your **profile** (goals, diet, allergies,
avoided foods, favourite halls) and your **meal log**. The `users` table stores
credentials and nothing else, and there is no `logged_meals` table yet — so both
live in `localStorage`, namespaced per user, behind a small interface designed
to be swapped for HTTP calls.

**[`docs/BACKEND.md`](docs/BACKEND.md) is the build guide for that backend** —
the exact tables, endpoints, schemas and the handful of frontend edits that
switch it over.

One more: DineOnCampus publishes no item photography (`useMenuImages` is false
on every UH location), so food thumbnails are drawn from an illustrated
category glyph set rather than photographs. See
[`DECISIONS.md`](DECISIONS.md).

---

## Layout

```
backend/
  app/
    routers/       auth · dining · plans
    services/      dineoncampus (live menus) · gemini (tool calling) · nutrition
frontend/
  src/
    api/           typed client mirroring backend/app/schemas.py
    state/         auth · profile · meals · advisor · dining · board · availability
    components/    AppShell + the four screens + the planner + primitives
    lib/           dates · the natural-language parser · macro formatting · motion
docs/BACKEND.md    how to build the profile + meal-log backend
DECISIONS.md       why the app is shaped the way it is
UI.md              the planner surface in detail
```

Stack: React 19 + TypeScript + Vite, GSAP for motion, hand-written CSS driven by
`unibite-design-tokens.json`. No CSS framework, no router — the tab lives in the
URL hash.
