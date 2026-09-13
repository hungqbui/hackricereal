# Building the profile + meal-log backend

The UI for **Profile** and **My Meals** is finished and working; both are held
in `localStorage` because the backend has nowhere to put them yet. This is the
guide to giving them a real home.

Everything here is additive. No existing endpoint changes, and the frontend
keeps working throughout — you can ship the tables, then the endpoints, then
flip the frontend over, in three separate sittings.

---

## 1. What exists today

```
users            id · email · password_hash · created_at        ← credentials only
meal_plans       id · user_id · plan_date · title · content · targets
                 constraints_text · sources · model · revision_count
plan_revisions   id · plan_id · revision_number · instruction · tool_used
                 rationale · content
```

`app/routers/plans.py` says the quiet part out loud:

> The users table stores credentials only, so targets and dietary notes travel
> with the request rather than living on a profile.

That is exactly the gap. Two things are missing:

| Missing | Who needs it | Currently |
|---|---|---|
| A student profile — goals, diet, allergies, avoided foods, favourite halls, meal times | Profile tab; the Advisor reads it on every question | `localStorage['unibite.profile.<userId>']` |
| A log of meals actually eaten | My Meals timeline; the Advisor's "what's left of your day" maths | `localStorage['unibite.meals.<userId>']` |

---

## 2. The UI these must serve

Build to the shapes the frontend already uses, and the swap is mechanical.

### `StudentProfile` — `frontend/src/state/profile.ts`

```ts
interface StudentProfile {
  displayName: string
  calorieGoal: number            // 1000–6000
  proteinGoal: number            // 20–400
  diet: 'none' | 'vegetarian' | 'vegan' | 'pescatarian' | 'halal' | 'kosher'
  allergies: string[]            // DineOnCampus vocabulary: "Milk", "Peanut", …
  avoid: string[]                // free text: "mushrooms", "anything fried"
  favoriteLocationIds: string[]  // DineOnCampus location ids
  schedule: { breakfast: string; lunch: string; dinner: string }  // "HH:MM"
}
```

Where it is used: goals become the numeric `targets` on `/plans/generate`;
`diet`, `allergies` and `avoid` become sentences in the `constraints` string
(see `profileConstraints()`); `favoriteLocationIds[0]` is the hall the Advisor
defaults to; `schedule` disambiguates "what should I eat?".

**Allergies must stay in DineOnCampus's vocabulary.** The Dining tab flags an
item when `item.allergens` intersects `profile.allergies` by exact,
case-insensitive name. `COMMON_ALLERGENS` in `profile.ts` is that list.

### `LoggedMeal` — `frontend/src/state/meals.ts`

```ts
interface LoggedMeal {
  id: string
  date: string                   // YYYY-MM-DD, the student's local service date
  slot: 'Breakfast' | 'Lunch' | 'Snack' | 'Dinner'
  title: string
  locationId: string | null      // DineOnCampus id, null if off campus
  locationName: string | null
  loggedAt: string               // ISO datetime, drives the timeline clock
  items: LoggedItem[]
  note: string | null
  planId: string | null          // set when it came from an advisor recommendation
}

interface LoggedItem {
  itemId: string | null          // DineOnCampus item id, traceable to its menu
  name: string
  category: string | null
  portion: string | null
  servings: number
  calories: number | null
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
  fiber_g: number | null
  sodium_mg: number | null
}
```

Two things to preserve:

- **`date` is a local service date, not a timestamp.** A meal logged at 00:30
  belongs to that calendar day for the student. Store it as a `Date` column, not
  derived from `loggedAt`, or late-night logging lands on the wrong day.
- **Macros are stored on the row, not looked up later.** Menus change; a logged
  meal is a record of what was eaten and what it contained *then*. `LoggedItem`
  is a snapshot on purpose.

---

## 3. The tables

Add to `backend/app/models.py`. These follow the conventions already there —
`Uuid` primary keys, `JSONType` for the JSON/JSONB variant, cascading deletes.

```python
class UserProfile(Base):
    """Goals and preferences. One row per user."""

    __tablename__ = "user_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )

    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    calorie_goal: Mapped[int] = mapped_column(Integer, default=2200)
    protein_goal: Mapped[int] = mapped_column(Integer, default=120)
    diet: Mapped[str] = mapped_column(String(20), default="none")

    # Lists and the schedule map travel as JSON: they are read and written
    # whole, and never queried by element.
    allergies: Mapped[list] = mapped_column(JSONType, default=list)
    avoid: Mapped[list] = mapped_column(JSONType, default=list)
    favorite_location_ids: Mapped[list] = mapped_column(JSONType, default=list)
    schedule: Mapped[dict] = mapped_column(JSONType, default=dict)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    user: Mapped[User] = relationship(back_populates="profile")


class LoggedMeal(Base):
    """One meal the student actually ate."""

    __tablename__ = "logged_meals"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    # Local service date. Not derived from logged_at: a 00:30 snack belongs to
    # the day the student thinks it does.
    meal_date: Mapped[Date] = mapped_column(SADate, index=True)
    slot: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(200))

    location_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    location_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Snapshot of the items and their macros as published when logged.
    items: Mapped[list] = mapped_column(JSONType, default=list)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    plan_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("meal_plans.id", ondelete="SET NULL"),
        nullable=True,
    )

    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
```

Add the back-references on `User`:

```python
    profile: Mapped["UserProfile | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False, lazy="selectin"
    )
    logged_meals: Mapped[list["LoggedMeal"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )
```

Add a composite index — every read is "this user, this date range":

```python
    __table_args__ = (Index("ix_logged_meals_user_date", "user_id", "meal_date"),)
```

`init_models()` creates tables on startup, so SQLite needs nothing more. On
Postgres, add a migration.

---

## 4. The endpoints

### `backend/app/schemas.py`

```python
class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    display_name: str | None = None
    calorie_goal: int = 2200
    protein_goal: int = 120
    diet: str = "none"
    allergies: list[str] = []
    avoid: list[str] = []
    favorite_location_ids: list[str] = []
    schedule: dict = {}


class ProfileUpdate(BaseModel):
    """Every field optional: the UI saves one row at a time."""

    display_name: str | None = Field(default=None, max_length=120)
    calorie_goal: int | None = Field(default=None, ge=1000, le=6000)
    protein_goal: int | None = Field(default=None, ge=20, le=400)
    diet: Literal["none", "vegetarian", "vegan", "pescatarian", "halal", "kosher"] | None = None
    allergies: list[str] | None = None
    avoid: list[str] | None = None
    favorite_location_ids: list[str] | None = None
    schedule: dict[str, str] | None = None


class LoggedItemIn(BaseModel):
    item_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    category: str | None = None
    portion: str | None = None
    servings: float = Field(default=1.0, gt=0, le=20)
    calories: float | None = Field(default=None, ge=0, le=10000)
    protein_g: float | None = Field(default=None, ge=0, le=500)
    carbs_g: float | None = None
    fat_g: float | None = None
    fiber_g: float | None = None
    sodium_mg: float | None = None


class LoggedMealCreate(BaseModel):
    date: Date
    slot: Literal["Breakfast", "Lunch", "Snack", "Dinner"]
    title: str = Field(min_length=1, max_length=200)
    location_id: str | None = None
    location_name: str | None = None
    items: list[LoggedItemIn] = Field(min_length=1)
    note: str | None = Field(default=None, max_length=500)
    plan_id: uuid.UUID | None = None
    logged_at: datetime | None = None


class LoggedMealOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    date: Date = Field(validation_alias="meal_date")
    slot: str
    title: str
    location_id: str | None
    location_name: str | None
    items: list[LoggedItemIn]
    note: str | None
    plan_id: uuid.UUID | None
    logged_at: datetime


class DayTotalsOut(BaseModel):
    date: Date
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    meals: int
```

### `backend/app/routers/profile.py`

```
GET   /profile                 -> ProfileOut     (defaults if no row yet)
PUT   /profile                 -> ProfileOut     (partial; upserts)
```

`PUT` should upsert and apply only the fields present
(`payload.model_dump(exclude_unset=True)`), because the Profile screen saves on
every keystroke of a single setting.

### `backend/app/routers/meals.py`

```
GET    /meals?start=&end=      -> list[LoggedMealOut]   (inclusive, default today)
POST   /meals                  -> LoggedMealOut         (201)
DELETE /meals/{id}             -> 204
GET    /meals/totals?start=&end=  -> list[DayTotalsOut]
```

Two rules worth enforcing server-side:

- **Ownership, quietly.** `DELETE` on someone else's meal returns **404**, not
  403 — the same shape `_get_owned_plan` already uses in `plans.py`, so ids
  cannot be probed.
- **Totals are computed, never trusted.** Reuse `sum_macros()` from
  `app/services/nutrition.py` — it already scales by `servings` and is what the
  plan totals go through. Do not accept totals from the client.

Cap the range (say 400 days) so `?start=1900-01-01` cannot ask for everything.

Register both in `main.py`:

```python
from .routers import auth, dining, meals, plans, profile
app.include_router(profile.router)
app.include_router(meals.router)
```

---

## 5. Wiring the frontend over

Four files. The interfaces are already the right shape — this is deliberate.

**`src/api/types.ts`** — add `Profile`, `LoggedMealOut`, `DayTotalsOut`
mirroring the schemas above.

**`src/api/client.ts`** — add the six calls next to the existing ones:

```ts
  profile:       () => request<Profile>('/profile'),
  updateProfile: (body: Partial<Profile>) => request<Profile>('/profile', { method: 'PUT', body }),
  meals:         (start: string, end: string) => request<LoggedMealOut[]>(`/meals?start=${start}&end=${end}`),
  logMeal:       (body: LoggedMealCreate) => request<LoggedMealOut>('/meals', { method: 'POST', body }),
  deleteMeal:    (id: string) => request<void>(`/meals/${id}`, { method: 'DELETE' }),
  mealTotals:    (start: string, end: string) => request<DayTotalsOut[]>(`/meals/totals?start=${start}&end=${end}`),
```

**`src/state/profile.ts`** — replace the `read`/`write` helpers with those calls.
`useProfile` gains a loading state; `update()` becomes optimistic — apply the
patch locally, then `PUT`, and roll back on failure. Keep `profileConstraints()`
and `listSentence()` exactly as they are; they are pure.

**`src/state/meals.ts`** — replace `read`/`write` with `api.meals` / `api.logMeal`
/ `api.deleteMeal`. `sumMeals()`, `itemFromMenuItem()`, `itemFromPlannedItem()`,
`slotForPeriod()` and `slotForTime()` are pure and stay.

No component changes. Nothing outside these two hooks touches storage — that is
the whole reason they were written this way.

### Migrating what people already logged

On first load after the swap, if `localStorage` holds a log and `GET /meals`
returns empty, `POST` the stored meals, then clear the key. Perhaps twenty
lines, and it means the demo account keeps its history.

---

## 6. What this unlocks

Worth doing for its own sake, but it also makes three things possible that the
local version cannot do:

- **The Advisor can stop re-explaining the student.** Today the day's intake and
  every preference are re-sent as an English sentence on every question. With a
  profile on the server, `plans.py` could read it directly — `generate_plan()`
  already has a `dietary_notes` parameter it currently passes `None` to.
- **Totals follow the student across devices**, which is the point of logging.
- **Recommendations can learn.** With real history, "you had chicken three days
  running" becomes a thing the planner can be told.

---

## 7. Before any of this, a working checkout

`UI.md` §8 notes the backend does not start clean. Two things to confirm:

- **`requirements.txt` pins `pydantic==2.10.4`** alongside
  `pydantic-settings==2.7.0`. Check that combination resolves in a fresh venv.
- **Stale `User` column references** in `app/routers/` — `auth.py` and
  `plans.py` have uncommitted fixes in the working tree. Commit them, then
  verify from a clean clone:

```bash
python -m venv /tmp/fresh && /tmp/fresh/bin/pip install -r backend/requirements.txt
DATABASE_URL="sqlite+aiosqlite:///./dev.db" JWT_SECRET=x /tmp/fresh/bin/uvicorn app.main:app
curl localhost:8000/health
```

`/health` reports database connectivity and whether Gemini is configured, so it
is the one call that tells you the whole boot story.
