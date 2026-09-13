from datetime import date as Date

from fastapi import APIRouter, HTTPException, Query, Request, status

from ..schemas import LocationOut, MenuOut, PeriodsOut
from ..services.dineoncampus import DineOnCampusClient, DineOnCampusError
from ..services.nutrition import flatten_menu

router = APIRouter(prefix="/dining", tags=["dining"])


def _client(request: Request) -> DineOnCampusClient:
    return request.app.state.dineoncampus


def _upstream_error(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"DineOnCampus upstream error: {exc}",
    )


@router.get("/locations", response_model=list[LocationOut])
async def list_locations(request: Request) -> list[LocationOut]:
    try:
        locations = await _client(request).list_locations()
    except DineOnCampusError as exc:
        raise _upstream_error(exc) from exc
    locations.sort(key=lambda loc: (loc.get("building") or "", loc.get("sort_order", 0)))
    return [LocationOut(**loc) for loc in locations]


@router.get("/locations/{location_id}/details")
async def location_details(location_id: str, request: Request) -> dict:
    try:
        return await _client(request).location_details(location_id)
    except DineOnCampusError as exc:
        raise _upstream_error(exc) from exc


@router.get("/locations/{location_id}/periods", response_model=PeriodsOut)
async def list_periods(
    location_id: str,
    request: Request,
    date: Date = Query(..., description="Service date, YYYY-MM-DD."),
) -> PeriodsOut:
    try:
        data = await _client(request).list_periods(location_id, date.isoformat())
    except DineOnCampusError as exc:
        raise _upstream_error(exc) from exc
    return PeriodsOut(**data)


@router.get("/locations/{location_id}/menu", response_model=MenuOut)
async def get_menu(
    location_id: str,
    request: Request,
    date: Date = Query(..., description="Service date, YYYY-MM-DD."),
    period: str = Query(..., description="Period id from the periods endpoint."),
) -> MenuOut:
    try:
        raw = await _client(request).get_menu(location_id, date.isoformat(), period)
    except DineOnCampusError as exc:
        raise _upstream_error(exc) from exc
    return MenuOut(**flatten_menu(raw, location_id, date.isoformat()))
