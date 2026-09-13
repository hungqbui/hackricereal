import asyncio
import uuid
from datetime import date as Date

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from ..deps import CurrentUser, SessionDep
from ..models import MealPlan, PlanRevision
from ..schemas import (
    PlanGenerateRequest,
    PlanOut,
    PlanRefineRequest,
    PlanSummaryOut,
)
from ..services import gemini
from ..services.dineoncampus import DineOnCampusClient, DineOnCampusError
from ..services.nutrition import flatten_menu

router = APIRouter(prefix="/plans", tags=["plans"])


async def _load_menus(
    client: DineOnCampusClient,
    location_id: str,
    date: str,
    period_ids: list[str],
) -> tuple[list[dict], str | None, list[str]]:
    """Fetch every requested period's menu concurrently.

    Returns (menus, location_name, period_ids_used).
    """
    try:
        periods_payload = await client.list_periods(location_id, date)
    except DineOnCampusError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not load meal periods: {exc}",
        ) from exc

    available = {p["id"]: p for p in periods_payload.get("periods") or [] if p.get("id")}
    if not available:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No meal periods are served at this location on {date}.",
        )

    if period_ids:
        unknown = [pid for pid in period_ids if pid not in available]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Period(s) {unknown} are not served on {date}. "
                    f"Available: {sorted(available)}"
                ),
            )
        wanted = period_ids
    else:
        wanted = list(available)

    location_name = None
    try:
        details = await client.location_details(location_id)
        location_name = details.get("name")
    except DineOnCampusError:
        pass  # a missing display name should not fail plan generation

    results = await asyncio.gather(
        *(client.get_menu(location_id, date, pid) for pid in wanted),
        return_exceptions=True,
    )

    menus: list[dict] = []
    for pid, result in zip(wanted, results):
        if isinstance(result, Exception):
            continue
        menu = flatten_menu(result, location_id, date)
        menu["period_id"] = menu.get("period_id") or pid
        menu["period_name"] = menu.get("period_name") or available[pid].get("name")
        menus.append(menu)

    if not any(m.get("items") for m in menus):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No menu items were published for {date} at this location.",
        )

    return menus, location_name, wanted


def _client(request: Request) -> DineOnCampusClient:
    return request.app.state.dineoncampus


async def _get_owned_plan(
    plan_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> MealPlan:
    plan = await session.get(MealPlan, plan_id)
    # Same 404 for missing and other-user plans, so ids cannot be probed.
    if plan is None or plan.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Meal plan not found."
        )
    return plan


@router.post("/generate", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
async def generate_plan(
    payload: PlanGenerateRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> PlanOut:
    date = payload.date.isoformat()
    menus, location_name, used_periods = await _load_menus(
        _client(request), payload.location_id, date, payload.period_ids
    )

    # Request targets win; otherwise fall back to the user's saved profile.
    targets = (
        payload.targets.model_dump(exclude_none=True)
        if payload.targets is not None
        else dict(user.targets or {})
    )

    try:
        selection, model_used = await gemini.generate_selection(
            menus=menus,
            targets=targets,
            constraints=payload.constraints,
            dietary_notes=user.dietary_notes,
            date=date,
            location_name=location_name,
        )
    except gemini.GeminiUnavailable:
        selection = gemini.fallback_selection(
            menus, targets, payload.constraints, user.dietary_notes
        )
        model_used = "fallback-greedy"
    except gemini.GeminiError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc

    catalog = gemini.build_catalog(menus)
    content = gemini.hydrate_plan(selection, catalog, menus, targets)

    plan = MealPlan(
        user_id=user.id,
        plan_date=payload.date,
        title=payload.title or content.get("title") or "Meal plan",
        content=content,
        targets=targets,
        constraints_text=payload.constraints,
        sources={
            "location_id": payload.location_id,
            "location_name": location_name,
            "period_ids": used_periods,
        },
        model=model_used,
        revision_count=0,
    )
    session.add(plan)
    await session.flush()

    session.add(
        PlanRevision(
            plan_id=plan.id,
            revision_number=0,
            instruction=payload.constraints,
            tool_used="initial",
            rationale=content.get("summary"),
            content=content,
        )
    )
    await session.commit()
    await session.refresh(plan)
    return PlanOut.model_validate(plan)


@router.post("/{plan_id}/refine", response_model=PlanOut)
async def refine_plan(
    plan_id: uuid.UUID,
    payload: PlanRefineRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> PlanOut:
    plan = await _get_owned_plan(plan_id, user, session)

    sources = plan.sources or {}
    location_id = sources.get("location_id")
    if not location_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This plan has no source location recorded and cannot be refined.",
        )

    date = plan.plan_date.isoformat()
    menus, location_name, _ = await _load_menus(
        _client(request), location_id, date, sources.get("period_ids") or []
    )

    try:
        selection, tool_used, rationale, model_used = await gemini.refine_selection(
            current=plan.content,
            menus=menus,
            instruction=payload.instruction,
            targets=plan.targets or {},
            dietary_notes=user.dietary_notes,
            date=date,
            location_name=location_name,
        )
    except gemini.GeminiUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Refinement requires Gemini. Set GEMINI_API_KEY to enable it."
            ),
        ) from exc
    except gemini.GeminiError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc

    catalog = gemini.build_catalog(menus)
    content = gemini.hydrate_plan(selection, catalog, menus, plan.targets or {})

    plan.content = content
    plan.title = content.get("title") or plan.title
    plan.model = model_used
    plan.revision_count += 1

    session.add(
        PlanRevision(
            plan_id=plan.id,
            revision_number=plan.revision_count,
            instruction=payload.instruction,
            tool_used=tool_used,
            rationale=rationale,
            content=content,
        )
    )
    await session.commit()
    await session.refresh(plan)
    return PlanOut.model_validate(plan)


@router.get("", response_model=list[PlanSummaryOut])
async def list_plans(
    user: CurrentUser,
    session: SessionDep,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    date: Date | None = Query(None, description="Filter to a single service date."),
) -> list[PlanSummaryOut]:
    stmt = select(MealPlan).where(MealPlan.user_id == user.id)
    if date is not None:
        stmt = stmt.where(MealPlan.plan_date == date)
    stmt = stmt.order_by(MealPlan.created_at.desc()).limit(limit).offset(offset)

    rows = (await session.scalars(stmt)).all()
    return [PlanSummaryOut.model_validate(row) for row in rows]


@router.get("/{plan_id}", response_model=PlanOut)
async def get_plan(
    plan_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> PlanOut:
    plan = await _get_owned_plan(plan_id, user, session)
    return PlanOut.model_validate(plan)


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> None:
    plan = await _get_owned_plan(plan_id, user, session)
    # ORM delete so the revision cascade runs regardless of whether the
    # backend enforces FK ON DELETE (SQLite does not, by default).
    await session.delete(plan)
    await session.commit()
