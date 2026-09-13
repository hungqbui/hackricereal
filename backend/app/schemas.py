import uuid
from datetime import date as Date
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints


# ---------- auth ----------

class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class NutritionTargets(BaseModel):
    """All optional; omitted fields are left unconstrained."""

    calories: float | None = Field(default=None, ge=0, le=10000)
    protein_g: float | None = Field(default=None, ge=0, le=500)
    carbs_g: float | None = Field(default=None, ge=0, le=1000)
    fat_g: float | None = Field(default=None, ge=0, le=500)
    fiber_g: float | None = Field(default=None, ge=0, le=200)
    sodium_mg: float | None = Field(default=None, ge=0, le=20000)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------- profile ----------

Diet = Literal["none", "vegetarian", "vegan", "pescatarian", "halal", "kosher"]

# Allergies and dislikes are pasted into every planning prompt, so both the
# list lengths and the entries themselves are capped.
_Allergen = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
_Dislike = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
_ClockTime = Annotated[str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    display_name: str | None = None
    calorie_goal: int = 2200
    protein_goal: int = 120
    diet: str = "none"
    allergies: list[str] = []
    avoid: list[str] = []
    favorite_location_ids: list[str] = []
    schedule: dict[str, str] = {}
    # None until the first save, which is how a client tells defaults apart.
    updated_at: datetime | None = None


class ProfileUpdate(BaseModel):
    """Every field optional: the UI saves one setting at a time."""

    display_name: str | None = Field(default=None, max_length=120)
    calorie_goal: int | None = Field(default=None, ge=1000, le=6000)
    protein_goal: int | None = Field(default=None, ge=20, le=400)
    diet: Diet | None = None
    # DineOnCampus allergen vocabulary: "Milk", "Peanut", "Tree Nut", ...
    allergies: list[_Allergen] | None = Field(default=None, max_length=20)
    avoid: list[_Dislike] | None = Field(default=None, max_length=30)
    favorite_location_ids: list[str] | None = Field(default=None, max_length=20)
    schedule: dict[Literal["breakfast", "lunch", "dinner"], _ClockTime] | None = None


# ---------- dining ----------

class LocationOut(BaseModel):
    id: str
    name: str
    building: str | None = None
    sort_order: int = 0


class PeriodOut(BaseModel):
    id: str
    name: str | None = None
    slug: str | None = None


class PeriodsOut(BaseModel):
    location_id: str
    date: Date
    periods: list[PeriodOut]


class MenuItemOut(BaseModel):
    id: str | None
    name: str | None
    category: str
    portion: str | None = None
    description: str | None = None
    ingredients: str | None = None
    tags: list[str] = []
    allergens: list[str] = []
    calories: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    saturated_fat_g: float | None = None
    fiber_g: float | None = None
    sugar_g: float | None = None
    sodium_mg: float | None = None


class MenuOut(BaseModel):
    location_id: str
    date: Date
    period_id: str | None
    period_name: str | None
    closed: bool = False
    status: str | None = None
    categories: list[str | None] = []
    items: list[MenuItemOut] = []


# ---------- meal plans ----------

class BoardRef(BaseModel):
    """Marks a plan as one day of a week plan generated together."""

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    query: str | None = Field(default=None, max_length=2000)
    periods: list[str] = Field(default=[], max_length=10)
    # Every date the week covers, including days that produced no plan.
    dates: list[Date] = Field(default=[], max_length=31)


class PlanGenerateRequest(BaseModel):
    location_id: str
    date: Date
    # Present when this plan is a day of a week plan; absent for a one-off meal.
    board: BoardRef | None = None
    # Restrict to specific periods; empty means every period served that day.
    period_ids: list[str] = []
    constraints: str | None = Field(
        default=None,
        max_length=2000,
        description="Natural-language constraints, e.g. 'vegetarian, high protein, no nuts'.",
    )
    targets: NutritionTargets | None = None
    title: str | None = Field(default=None, max_length=200)


class PlanRefineRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=2000)


class SelectedItemIn(BaseModel):
    item_id: str | None = None
    servings: float = Field(default=1.0, gt=0, le=4)
    reason: str | None = Field(default=None, max_length=500)


class SelectedMealIn(BaseModel):
    period_id: str | None = None
    notes: str | None = Field(default=None, max_length=1000)
    items: list[SelectedItemIn] = Field(default=[], max_length=40)


class PlanSelectionIn(BaseModel):
    """A plan's selections only.

    Clients echo back a whole proposal; names, macros and totals on it are
    ignored because the server recomputes them from the menu.
    """

    title: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=2000)
    meals: list[SelectedMealIn] = Field(default=[], max_length=12)
    constraint_notes: list[str] = Field(default=[], max_length=30)
    warnings: list[str] = Field(default=[], max_length=30)


class PlanApplyRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=2000)
    # The revision the proposal was made against; a mismatch means it is stale.
    base_revision: int = Field(ge=0)
    tool_used: Literal["rewrite_meal_plan", "adjust_meal_items"]
    rationale: str | None = Field(default=None, max_length=2000)
    content: PlanSelectionIn


class PlannedItemOut(BaseModel):
    item_id: str | None = None
    name: str | None = None
    category: str | None = None
    portion: str | None = None
    servings: float = 1.0
    reason: str | None = None
    tags: list[str] = []
    allergens: list[str] = []
    calories: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    saturated_fat_g: float | None = None
    fiber_g: float | None = None
    sugar_g: float | None = None
    sodium_mg: float | None = None


class MealOut(BaseModel):
    period_id: str | None = None
    period_name: str | None = None
    notes: str | None = None
    items: list[PlannedItemOut] = []
    # A macro is None when no item in the selection published it.
    totals: dict[str, float | None] = {}


class PlanContentOut(BaseModel):
    title: str
    summary: str | None = None
    meals: list[MealOut] = []
    # A macro is None when no item in the selection published it.
    totals: dict[str, float | None] = {}
    target_fit: dict = {}
    constraint_notes: list[str] = []
    warnings: list[str] = []


class RevisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision_number: int
    instruction: str | None
    tool_used: str | None
    rationale: str | None
    created_at: datetime


class PlanSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    plan_date: Date
    title: str
    revision_count: int
    created_at: datetime
    updated_at: datetime


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    plan_date: Date
    title: str
    content: PlanContentOut
    targets: dict
    constraints_text: str | None
    sources: dict
    model: str | None
    revision_count: int
    created_at: datetime
    updated_at: datetime
    revisions: list[RevisionOut] = []


class WeekOut(BaseModel):
    """The student's current week plan, rebuilt from the plans that make it up."""

    board_id: str
    location_id: str | None
    location_name: str | None
    query: str | None
    periods: list[str]
    dates: list[Date]
    targets: dict
    # One plan per date (the newest), in date order.
    plans: list[PlanOut]


class PlanProposalOut(BaseModel):
    """A refinement that has not been saved. Send it to /apply to keep it."""

    plan_id: uuid.UUID
    base_revision: int
    instruction: str
    tool_used: str
    rationale: str | None
    model: str | None
    content: PlanContentOut
