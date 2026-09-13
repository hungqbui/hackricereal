"""Sanity checks: does the app fetch the right menu for the right day?

The failure mode these guard against is subtle -- the upstream happily
returns *a* menu for almost any request, so a wrong date or a period id
belonging to another location produces plausible-looking but incorrect
food. These tests pin the location/date/period all the way through.
"""

import pytest

from app.services.nutrition import flatten_menu

from .conftest import COUGAR_WOODS, DATE_A, DATE_B, MOODY


# ---------------------------------------------------------------------------
# Normalisation preserves the identity of what was requested
# ---------------------------------------------------------------------------


def test_flatten_menu_echoes_requested_location_and_date(recorded):
    raw = recorded["moody_a"]["menus"]
    period_id, payload = next(iter(raw.items()))

    menu = flatten_menu(payload, MOODY, DATE_A)

    assert menu["location_id"] == MOODY
    assert menu["date"] == DATE_A
    assert menu["period_id"] == period_id


def test_client_asks_for_the_app_view_of_the_menu(app_env, monkeypatch):
    """Sec-Fetch-Dest decides whether upstream applies the hall's hours.

    With curl_cffi's default "document" it returns every item even on a day the
    hall is closed; "empty" (what dineoncampus.com's fetch() sends) returns
    closedOnDate and no categories. The session must override the default.
    """
    from app.services import dineoncampus

    captured = {}

    class RecordingSession:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(dineoncampus, "HAS_CURL_CFFI", True)
    monkeypatch.setattr(dineoncampus, "_CurlSession", RecordingSession)
    dineoncampus.DineOnCampusClient()._ensure_session()

    headers = captured["headers"]
    assert headers["Sec-Fetch-Dest"] == "empty"
    assert headers["Sec-Fetch-Mode"] == "cors"
    assert headers["Sec-Fetch-Site"] == "same-site"


def test_a_closed_day_flattens_to_no_items():
    """The payload upstream sends when the hall is shut on the requested date."""
    payload = {
        "id": None,
        "locationId": "599da32a3191a2fc6b417fee",
        "date": "2026-09-13",
        "closedOnDate": True,
        "status": {
            "label": "closed",
            "message": "Closed. Opens Monday at 7:00am.",
            "color": "red",
        },
        "period": {"id": "1", "name": None, "slug": None, "categories": []},
    }

    menu = flatten_menu(payload, "599da32a3191a2fc6b417fee", "2026-09-13")

    assert menu["closed"] is True
    assert menu["status"] == "Closed. Opens Monday at 7:00am."
    assert menu["items"] == []
    assert menu["categories"] == []


def test_upstream_payload_carries_the_date_we_asked_for(recorded):
    for label, date in [("moody_a", DATE_A), ("moody_b", DATE_B)]:
        for payload in recorded[label]["menus"].values():
            assert payload["date"] == date
            assert payload["locationId"] == MOODY


def test_every_period_of_the_day_is_distinct_and_named(moody_menus):
    names = [m["period_name"] for m in moody_menus]
    ids = [m["period_id"] for m in moody_menus]

    assert names == ["Breakfast", "Lunch", "Dinner", "Everyday"]
    assert len(set(ids)) == len(ids), "period ids must be unique within a day"
    assert all(m["items"] for m in moody_menus), "each period should serve items"


def test_items_are_not_leaked_between_periods(recorded):
    """Breakfast items must come from the breakfast payload, not lunch."""
    raw = recorded["moody_a"]["menus"]
    by_period = {
        pid: {i["id"] for c in (p["period"] or {}).get("categories") or []
              for i in c.get("items") or []}
        for pid, p in raw.items()
    }
    for pid, payload in raw.items():
        menu = flatten_menu(payload, MOODY, DATE_A)
        got = {i["id"] for i in menu["items"]}
        assert got == by_period[pid]


# ---------------------------------------------------------------------------
# The day actually matters
# ---------------------------------------------------------------------------


def test_different_dates_yield_different_menus(recorded):
    """Guards against a cache key or param bug that pins one date."""
    def lunch_names(label):
        for payload in recorded[label]["menus"].values():
            menu = flatten_menu(payload, MOODY, "x")
            if menu["period_name"] == "Lunch":
                return {i["name"] for i in menu["items"]}
        raise AssertionError("no lunch period recorded")

    a, b = lunch_names("moody_a"), lunch_names("moody_b")

    assert a and b
    assert a != b, "two different service dates returned identical lunch menus"
    # Sanity on the fixtures themselves: overlapping but clearly distinct.
    assert a & b, "expected some staple items on both days"
    assert (a - b) and (b - a)


def test_different_locations_yield_different_menus(recorded):
    def names(label):
        return {
            i["name"]
            for payload in recorded[label]["menus"].values()
            for i in flatten_menu(payload, "x", "y")["items"]
        }

    assert names("moody_a") != names("cougarwoods_a")


def test_period_ids_are_scoped_to_their_location(recorded):
    """A Cougar Woods period id must not be valid for Moody."""
    moody_ids = set(recorded["moody_a"]["menus"])
    cw_ids = set(recorded["cougarwoods_a"]["menus"])

    assert not (moody_ids & cw_ids)


# ---------------------------------------------------------------------------
# End-to-end through the HTTP layer
# ---------------------------------------------------------------------------


async def test_periods_endpoint_returns_the_days_periods(api):
    resp = await api.get(f"/dining/locations/{MOODY}/periods", params={"date": DATE_A})

    assert resp.status_code == 200
    body = resp.json()
    assert body["location_id"] == MOODY
    assert body["date"] == DATE_A
    assert [p["name"] for p in body["periods"]] == [
        "Breakfast", "Lunch", "Dinner", "Everyday",
    ]


async def test_menu_endpoint_round_trips_period_selection(api):
    periods = (
        await api.get(f"/dining/locations/{MOODY}/periods", params={"date": DATE_A})
    ).json()["periods"]

    seen: dict[str, set[str]] = {}
    for period in periods:
        resp = await api.get(
            f"/dining/locations/{MOODY}/menu",
            params={"date": DATE_A, "period": period["id"]},
        )
        assert resp.status_code == 200
        menu = resp.json()

        # The menu we got back is the one we asked for.
        assert menu["period_id"] == period["id"]
        assert menu["period_name"] == period["name"]
        assert menu["location_id"] == MOODY
        assert menu["date"] == DATE_A
        seen[period["name"]] = {i["name"] for i in menu["items"]}

    assert seen["Breakfast"] != seen["Lunch"] != seen["Dinner"]


async def test_menu_request_forwards_exact_date_and_period(api, upstream):
    await api.get(
        f"/dining/locations/{MOODY}/menu",
        params={"date": DATE_B, "period": "6aa5f5c5271b6d7019756f44"},
    )

    path, params = upstream.calls[-1]
    assert path == f"/locations/{MOODY}/menu"
    assert params == {"date": DATE_B, "period": "6aa5f5c5271b6d7019756f44"}


async def test_unknown_period_yields_an_empty_menu_not_another_periods_food(api):
    resp = await api.get(
        f"/dining/locations/{MOODY}/menu",
        params={"date": DATE_A, "period": "0" * 24},
    )

    assert resp.status_code == 200
    assert resp.json()["items"] == []


async def test_malformed_date_is_rejected(api):
    resp = await api.get(
        f"/dining/locations/{MOODY}/menu",
        params={"date": "09-15-2026", "period": "x"},
    )
    assert resp.status_code == 422


async def test_locations_endpoint_lists_known_dining_halls(api):
    resp = await api.get("/dining/locations")

    assert resp.status_code == 200
    locations = resp.json()
    by_id = {loc["id"]: loc for loc in locations}

    assert MOODY in by_id
    assert by_id[MOODY]["name"] == "Moody Towers Dining Commons"
    assert by_id[MOODY]["building"] == "Moody Towers"
    assert COUGAR_WOODS in by_id
    assert all(loc["id"] and loc["name"] for loc in locations)


async def test_menu_responses_are_never_cached(api, upstream):
    """Every request reaches upstream, so a republished menu shows up at once."""
    args = {"date": DATE_A, "period": "6aa5f5c5271b6d7019756f44"}
    await api.get(f"/dining/locations/{MOODY}/menu", params=args)
    after_first = len(upstream.calls)

    await api.get(f"/dining/locations/{MOODY}/menu", params=args)
    assert len(upstream.calls) == after_first + 1, "identical request must re-fetch"

    await api.get(
        f"/dining/locations/{MOODY}/menu",
        params={**args, "date": DATE_B},
    )
    assert len(upstream.calls) == after_first + 2
    assert upstream.calls[-1] == (
        f"/locations/{MOODY}/menu",
        {"date": DATE_B, "period": args["period"]},
    )
