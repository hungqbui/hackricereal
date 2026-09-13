import uuid
from datetime import date as Date
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


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

class PlanGenerateRequest(BaseModel):
    location_id: str
    date: Date
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
    totals: dict[str, float] = {}


class PlanContentOut(BaseModel):
    title: str
    summary: str | None = None
    meals: list[MealOut] = []
    totals: dict[str, float] = {}
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
