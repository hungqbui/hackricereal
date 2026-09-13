import asyncio
import re
import uuid
from datetime import date as Date

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..deps import CurrentUser, SessionDep
from ..models import MealPlan, PlanRevision, UserProfile
from ..schemas import (
    PlanApplyRequest,
    PlanGenerateRequest,
    PlanOut,
    PlanProposalOut,
    PlanRefineRequest,
    PlanSummaryOut,
    ProfileOut,
    WeekOut,
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
    period_names: dict[str, str] | None = None,
) -> tuple[list[dict], str | None, list[str]]:
    """Fetch every requested period's menu concurrently.

    ``period_names`` maps a requested id to the period name it was saved
    under, so an id upstream has since reissued still resolves. Ids come back
    in request order, so zipping them with ``period_ids`` gives the remap.

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
        wanted, unknown = _resolve_periods(available, period_ids, period_names or {})
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Period(s) {unknown} are not served on {date}. "
                    f"Available: {sorted(available)}"
                ),
            )
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


def _period_key(name: str | None) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _resolve_periods(
    available: dict[str, dict],
    period_ids: list[str],
    period_names: dict[str, str],
) -> tuple[list[str], list[str]]:
    """Match requested ids to served periods. Returns (resolved, unknown).

    DineOnCampus reissues a hall's period ids when it republishes menus, so an
    id saved with a plan can go stale while the period itself ("Lunch") is
    still served. Such an id falls back to the name it was saved under; an id
    with no known name stays unknown.
    """
    by_name: dict[str, str] = {}
    for pid, period in available.items():
        by_name.setdefault(_period_key(period.get("name")), pid)

    resolved: list[str] = []
    unknown: list[str] = []
    for pid in period_ids:
        if pid in available:
            resolved.append(pid)
            continue
        saved_name = period_names.get(pid)
        current = by_name.get(_period_key(saved_name)) if saved_name else None
        if current:
            resolved.append(current)
        else:
            unknown.append(pid)
    return resolved, unknown


def _remap_periods(content: dict, remap: dict[str, str]) -> dict:
    """A copy of plan content with reissued period ids swapped for current ones."""
    if not remap:
        return content
    return {
        **content,
        "meals": [
            {**meal, "period_id": remap.get(meal.get("period_id"), meal.get("period_id"))}
            for meal in content.get("meals") or []
        ],
    }


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


async def _profile_context(
    user: CurrentUser, session: SessionDep
) -> tuple[dict, str | None]:
    """The saved profile as (default targets, dietary notes).

    A user who has never saved a profile gets neither, so the planner is
    not steered by goals they did not choose.
    """
    row = await session.get(UserProfile, user.id)
    if row is None:
        return {}, None
    profile = ProfileOut.model_validate(row)
    targets = {"calories": profile.calorie_goal, "protein_g": profile.protein_goal}
    return targets, gemini.build_profile_notes(profile.model_dump())


async def _plan_menus(
    plan: MealPlan, request: Request
) -> tuple[list[dict], str | None, dict[str, str]]:
    """The menus a stored plan was drawn from, refetched from upstream.

    Returns (menus, location_name, remap), where remap takes any period id
    upstream has reissued since the plan was saved to its current id.
    """
    sources = plan.sources or {}
    location_id = sources.get("location_id")
    if not location_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This plan has no source location recorded and cannot be refined.",
        )
    requested = sources.get("period_ids") or []
    saved_names = {
        meal["period_id"]: meal.get("period_name")
        for meal in (plan.content or {}).get("meals") or []
        if meal.get("period_id") and meal.get("period_name")
    }
    menus, location_name, used = await _load_menus(
        _client(request),
        location_id,
        plan.plan_date.isoformat(),
        requested,
        saved_names,
    )
    remap = {old: new for old, new in zip(requested, used) if old != new}
    return menus, location_name, remap


async def _propose(
    plan: MealPlan,
    instruction: str,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> tuple[dict, str, str, str, dict[str, str]]:
    """Run a refinement and hydrate it without touching the stored plan.

    Returns (content, tool_used, rationale, model, period_remap).
    """
    menus, location_name, remap = await _plan_menus(plan, request)
    # The profile as it is now, so an allergy added since generation applies.
    _, dietary_notes = await _profile_context(user, session)

    try:
        selection, tool_used, rationale, model_used = await gemini.refine_selection(
            # The model must see the ids on today's menu, or its edits would
            # land in a duplicate meal under the stale id.
            current=_remap_periods(plan.content, remap),
            menus=menus,
            instruction=instruction,
            targets=plan.targets or {},
            dietary_notes=dietary_notes,
            date=plan.plan_date.isoformat(),
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
    return content, tool_used, rationale, model_used, remap


async def _record_revision(
    plan: MealPlan,
    session: SessionDep,
    *,
    content: dict,
    instruction: str,
    tool_used: str,
    rationale: str | None,
    model: str | None,
    period_remap: dict[str, str] | None = None,
) -> PlanOut:
    plan.content = content
    plan.title = content.get("title") or plan.title
    plan.model = model
    plan.revision_count += 1
    if period_remap:
        # Store the current ids so the next refinement need not resolve again.
        sources = plan.sources or {}
        plan.sources = {
            **sources,
            "period_ids": [period_remap.get(pid, pid) for pid in sources.get("period_ids") or []],
        }

    session.add(
        PlanRevision(
            plan_id=plan.id,
            revision_number=plan.revision_count,
            instruction=instruction,
            tool_used=tool_used,
            rationale=rationale,
            content=content,
        )
    )
    try:
        await session.commit()
    except IntegrityError:
        # Another revision claimed this number first.
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This plan was changed at the same time. Reload it and try again.",
        ) from None
    await session.refresh(plan)
    return PlanOut.model_validate(plan)


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

    # Targets on the request win; otherwise the saved goals apply. Diet,
    # allergies and dislikes always come from the saved profile.
    profile_targets, dietary_notes = await _profile_context(user, session)
    targets = (
        payload.targets.model_dump(exclude_none=True)
        if payload.targets is not None
        else profile_targets
    )

    try:
        selection, model_used = await gemini.generate_selection(
            menus=menus,
            targets=targets,
            constraints=payload.constraints,
            dietary_notes=dietary_notes,
            date=date,
            location_name=location_name,
        )
    except gemini.GeminiUnavailable:
        selection = gemini.fallback_selection(
            menus, targets, payload.constraints, dietary_notes
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
            # "week" plans make up the This Week board; "meal" is a one-off
            # Advisor recommendation, which is never shown as the student's plan.
            "kind": "week" if payload.board else "meal",
            **({"board": payload.board.model_dump(mode="json")} if payload.board else {}),
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
    content, tool_used, rationale, model_used, remap = await _propose(
        plan, payload.instruction, request, user, session
    )
    return await _record_revision(
        plan,
        session,
        content=content,
        instruction=payload.instruction,
        tool_used=tool_used,
        rationale=rationale,
        model=model_used,
        period_remap=remap,
    )


@router.post("/{plan_id}/propose", response_model=PlanProposalOut)
async def propose_refinement(
    plan_id: uuid.UUID,
    payload: PlanRefineRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> PlanProposalOut:
    """Refine without saving, so the student can review the change first."""
    plan = await _get_owned_plan(plan_id, user, session)
    content, tool_used, rationale, model_used, _ = await _propose(
        plan, payload.instruction, request, user, session
    )
    return PlanProposalOut(
        plan_id=plan.id,
        base_revision=plan.revision_count,
        instruction=payload.instruction,
        tool_used=tool_used,
        rationale=rationale,
        model=model_used,
        content=content,
    )


@router.post("/{plan_id}/apply", response_model=PlanOut)
async def apply_proposal(
    plan_id: uuid.UUID,
    payload: PlanApplyRequest,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
) -> PlanOut:
    """Save a proposal the student confirmed.

    Only the selections are read back. Every item is resolved against the
    live menu again and every macro recomputed, as for a model reply, so an
    edited proposal cannot store invented nutrition.
    """
    plan = await _get_owned_plan(plan_id, user, session)
    if payload.base_revision != plan.revision_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This plan changed after the proposal was made. Ask again for a fresh one.",
        )

    menus, _, remap = await _plan_menus(plan, request)
    catalog = gemini.build_catalog(menus)
    content = gemini.hydrate_plan(
        _remap_periods(payload.content.model_dump(), remap),
        catalog,
        menus,
        plan.targets or {},
    )
    return await _record_revision(
        plan,
        session,
        content=content,
        instruction=payload.instruction,
        tool_used=payload.tool_used,
        rationale=payload.rationale,
        model=plan.model,
        period_remap=remap,
    )


def _board_of(plan: MealPlan) -> dict:
    return (plan.sources or {}).get("board") or {}


async def _recent_plans(user: CurrentUser, session: SessionDep) -> list[MealPlan]:
    stmt = (
        select(MealPlan)
        .where(MealPlan.user_id == user.id)
        .order_by(MealPlan.created_at.desc())
        .limit(200)
    )
    return list((await session.scalars(stmt)).all())


# Declared before "/{plan_id}" so "week" is not read as a plan id.
@router.get("/week", response_model=WeekOut | None)
async def current_week(user: CurrentUser, session: SessionDep) -> WeekOut | None:
    """The most recent week plan, or null when there is none or it was cleared.

    A cleared week is not replaced by an older one: "New plan" means an empty
    board until the student builds another.
    """
    rows = await _recent_plans(user, session)
    newest = next((row for row in rows if _board_of(row).get("id")), None)
    if newest is None or _board_of(newest).get("archived"):
        return None

    board = _board_of(newest)
    by_date: dict[Date, MealPlan] = {}
    for row in rows:  # newest first, so the first plan per date wins
        if _board_of(row).get("id") == board["id"]:
            by_date.setdefault(row.plan_date, row)

    sources = newest.sources or {}
    return WeekOut(
        board_id=board["id"],
        location_id=sources.get("location_id"),
        location_name=sources.get("location_name"),
        query=board.get("query"),
        periods=board.get("periods") or [],
        dates=board.get("dates") or sorted(by_date),
        targets=newest.targets or {},
        plans=[PlanOut.model_validate(by_date[day]) for day in sorted(by_date)],
    )


@router.delete("/week/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
async def clear_week(board_id: str, user: CurrentUser, session: SessionDep) -> None:
    """Take a week plan off the board. The plans themselves stay, since logged
    meals may point at them. Idempotent, and scoped to the caller's plans."""
    for row in await _recent_plans(user, session):
        board = _board_of(row)
        if board.get("id") == board_id and not board.get("archived"):
            row.sources = {**row.sources, "board": {**board, "archived": True}}
    await session.commit()


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
