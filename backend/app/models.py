import uuid
from datetime import date as Date
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Date as SADate,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str | None] = mapped_column(String(120), nullable=True)

    # Default nutrition targets, reused when a plan request omits them.
    targets: Mapped[dict] = mapped_column(JSONType, default=dict)
    # Standing dietary constraints in natural language, e.g. "vegetarian, no nuts".
    dietary_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )

    plans: Mapped[list["MealPlan"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin"
    )


class MealPlan(Base):
    """One generated plan. Many plans belong to one user."""

    __tablename__ = "meal_plans"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    plan_date: Mapped[Date] = mapped_column(SADate, index=True)
    title: Mapped[str] = mapped_column(String(200))

    # The structured plan produced by Gemini (MealPlanContent schema).
    content: Mapped[dict] = mapped_column(JSONType)
    # Targets and the natural-language constraints used for generation.
    targets: Mapped[dict] = mapped_column(JSONType, default=dict)
    constraints_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Location/period ids the plan drew from, for regeneration.
    sources: Mapped[dict] = mapped_column(JSONType, default=dict)

    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    revision_count: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    user: Mapped[User] = relationship(back_populates="plans")
    revisions: Mapped[list["PlanRevision"]] = relationship(
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="PlanRevision.revision_number",
        lazy="selectin",
    )


class PlanRevision(Base):
    """Audit trail of every refinement instruction applied to a plan."""

    __tablename__ = "plan_revisions"
    __table_args__ = (
        UniqueConstraint("plan_id", "revision_number", name="uq_plan_revision_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    plan_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("meal_plans.id", ondelete="CASCADE"), index=True
    )

    revision_number: Mapped[int] = mapped_column(Integer)
    instruction: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Which Gemini tool produced this revision: rewrite_meal_plan | adjust_meal_items | initial
    tool_used: Mapped[str | None] = mapped_column(String(60), nullable=True)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[dict] = mapped_column(JSONType)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )

    plan: Mapped[MealPlan] = relationship(back_populates="revisions")
