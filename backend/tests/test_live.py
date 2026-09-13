"""Opt-in tests that hit the real services.

    pytest -m live                    # real DineOnCampus API
    pytest -m gemini                  # real Gemini (needs GEMINI_API_KEY)
    pytest -m "live or gemini"        # both

These are excluded from the default run because they need the network,
cost money (Gemini), and depend on what the dining halls happen to be
serving. They are the check that the recorded fixtures have not drifted
from the live API.
"""

import os
import sys
from datetime import date, timedelta

import pytest

from .conftest import MOODY
from .test_meal_plan import assert_plan_is_coherent, plan_items


def upcoming_weekday(offset: int = 2) -> str:
    """A near-future weekday, so a menu is likely to be published."""
    day = date.today() + timedelta(days=offset)
    while day.weekday() >= 5:  # skip Sat/Sun
        day += timedelta(days=1)
    return day.isoformat()


@pytest.fixture
async def live_api(tmp_path, monkeypatch):
    """App wired to the real upstream, with a throwaway database."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'live.db'}")
    monkeypatch.setenv("JWT_SECRET", "test-secret-not-for-production")

    for mod in [m for m in list(sys.modules) if m == "app" or m.startswith("app.")]:
        del sys.modules[mod]

    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test", timeout=120
        ) as client:
            yield client


@pytest.fixture
async def live_auth(live_api):
    resp = await live_api.post(
        "/auth/register", json={"email": "live@uh.edu", "password": "password123"}
    )
    assert resp.status_code == 201, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ---------------------------------------------------------------------------
# Live DineOnCampus
# ---------------------------------------------------------------------------


@pytest.mark.live
async def test_live_locations_include_the_dining_commons(live_api):
    resp = await live_api.get("/dining/locations")

    assert resp.status_code == 200, resp.text
    names = {loc["name"] for loc in resp.json()}
    assert any("Moody Towers" in n for n in names)
    assert any("Cougar Woods" in n for n in names)


@pytest.mark.live
async def test_live_periods_and_menu_agree_on_the_date(live_api):
    """The requested day must be the day we get food for."""
    day = upcoming_weekday()

    periods = await live_api.get(
        f"/dining/locations/{MOODY}/periods", params={"date": day}
    )
    assert periods.status_code == 200, periods.text
    body = periods.json()
    assert body["date"] == day
    if not body["periods"]:
        pytest.skip(f"no periods published for {day}")

    served = 0
    for period in body["periods"]:
        menu = await live_api.get(
            f"/dining/locations/{MOODY}/menu",
            params={"date": day, "period": period["id"]},
        )
        assert menu.status_code == 200, menu.text
        payload = menu.json()

        assert payload["date"] == day
        assert payload["location_id"] == MOODY
        assert payload["period_id"] == period["id"]
        assert payload["period_name"] == period["name"]
        served += len(payload["items"])

    assert served > 0, f"no items served anywhere at Moody on {day}"


@pytest.mark.live
async def test_live_menu_items_carry_nutrition(live_api):
    day = upcoming_weekday()
    periods = (
        await live_api.get(f"/dining/locations/{MOODY}/periods", params={"date": day})
    ).json()["periods"]
    if not periods:
        pytest.skip(f"no periods published for {day}")

    for period in periods:
        menu = (
            await live_api.get(
                f"/dining/locations/{MOODY}/menu",
                params={"date": day, "period": period["id"]},
            )
        ).json()
        if not menu["items"]:
            continue

        with_calories = [i for i in menu["items"] if i["calories"] is not None]
        assert len(with_calories) / len(menu["items"]) > 0.8, (
            f"{period['name']}: most items are missing calories"
        )
        assert any(i["protein_g"] for i in menu["items"])
        assert any(i["tags"] for i in menu["items"])
        return

    pytest.skip("no items served on the sampled day")


@pytest.mark.live
async def test_live_fixtures_still_match_the_upstream_shape(live_api, recorded):
    """Catches upstream schema drift that would invalidate the offline suite."""
    live = await live_api.get("/dining/locations")
    live_ids = {loc["id"] for loc in live.json()}

    recorded_ids = {
        loc["id"]
        for building in recorded["locations"].get("buildings") or []
        for loc in building.get("locations") or []
    }
    overlap = live_ids & recorded_ids
    assert len(overlap) >= 10, (
        "recorded locations have drifted from live; refresh with "
        "tests/fixtures/_capture.py"
    )


@pytest.mark.live
async def test_live_plan_generation_end_to_end(live_api, live_auth):
    day = upcoming_weekday()
    resp = await live_api.post(
        "/plans/generate",
        headers=live_auth,
        json={
            "location_id": MOODY,
            "date": day,
            "constraints": "high protein, vegetarian",
            "targets": {"calories": 2200, "protein_g": 130},
        },
    )
    if resp.status_code == 404:
        pytest.skip(f"no menu published for {day}")
    assert resp.status_code == 201, resp.text

    plan = resp.json()
    assert plan["plan_date"] == day
    assert plan["sources"]["location_id"] == MOODY

    # Every chosen item must exist on that day's real menu.
    catalog = {}
    for period_id in plan["sources"]["period_ids"]:
        menu = (
            await live_api.get(
                f"/dining/locations/{MOODY}/menu",
                params={"date": day, "period": period_id},
            )
        ).json()
        for item in menu["items"]:
            catalog[item["id"]] = item

    assert plan_items(plan["content"]), "plan selected nothing"
    assert_plan_is_coherent(plan["content"], catalog)


# ---------------------------------------------------------------------------
# Live Gemini
# ---------------------------------------------------------------------------

needs_key = pytest.mark.skipif(
    not os.environ.get("GEMINI_API_KEY"),
    reason="GEMINI_API_KEY is not set",
)


@pytest.mark.gemini
@needs_key
async def test_gemini_builds_a_health_aware_plan(live_api, live_auth):
    """The real model, judged on the same health criteria as the fallback."""
    day = upcoming_weekday()
    targets = {"calories": 2200, "protein_g": 140, "fiber_g": 30}

    resp = await live_api.post(
        "/plans/generate",
        headers=live_auth,
        json={
            "location_id": MOODY,
            "date": day,
            "constraints": "vegetarian, high protein, no peanuts",
            "targets": targets,
        },
    )
    if resp.status_code == 404:
        pytest.skip(f"no menu published for {day}")
    assert resp.status_code == 201, resp.text
    plan = resp.json()

    assert plan["model"].startswith("gemini"), "fell back to the offline planner"

    catalog = {}
    for period_id in plan["sources"]["period_ids"]:
        menu = (
            await live_api.get(
                f"/dining/locations/{MOODY}/menu",
                params={"date": day, "period": period_id},
            )
        ).json()
        for item in menu["items"]:
            catalog[item["id"]] = item

    assert_plan_is_coherent(plan["content"], catalog)

    items = plan_items(plan["content"])
    assert items, "the model selected nothing"

    # Health awareness.
    totals = plan["content"]["totals"]
    assert 0.7 * targets["calories"] <= totals["calories"] <= 1.3 * targets["calories"]
    assert totals["protein_g"] >= 0.6 * targets["protein_g"]

    # Dietary constraints are hard requirements.
    non_veg = [i["name"] for i in items if not ({"Vegan", "Vegetarian"} & set(i["tags"]))]
    assert not non_veg, f"non-vegetarian items in a vegetarian plan: {non_veg}"

    peanuts = [
        i["name"] for i in items
        if any("peanut" in a.lower() for a in i["allergens"])
    ]
    assert not peanuts, f"peanut items despite an allergy: {peanuts}"

    assert plan["content"]["summary"]
    assert all(i["reason"] for i in items), "every pick should be justified"


@pytest.mark.gemini
@needs_key
async def test_gemini_refines_an_existing_plan(live_api, live_auth):
    day = upcoming_weekday()
    resp = await live_api.post(
        "/plans/generate",
        headers=live_auth,
        json={
            "location_id": MOODY,
            "date": day,
            "constraints": "balanced day",
            "targets": {"calories": 2000, "protein_g": 120},
        },
    )
    if resp.status_code == 404:
        pytest.skip(f"no menu published for {day}")
    plan = resp.json()

    refined = await live_api.post(
        f"/plans/{plan['id']}/refine",
        headers=live_auth,
        json={"instruction": "Make it fully vegan and add more fiber."},
    )
    assert refined.status_code == 200, refined.text
    body = refined.json()

    assert body["revision_count"] == 1
    assert body["revisions"][-1]["tool_used"] in {
        "adjust_meal_items", "rewrite_meal_plan",
    }
    assert body["revisions"][-1]["rationale"]

    items = plan_items(body["content"])
    non_vegan = [i["name"] for i in items if "Vegan" not in i["tags"]]
    assert not non_vegan, f"still non-vegan after a vegan instruction: {non_vegan}"
    assert body["content"]["totals"]["fiber_g"] >= plan["content"]["totals"]["fiber_g"]
