"""Auth, plan persistence, and per-user isolation over HTTP."""

import pytest

from .conftest import COUGAR_WOODS, DATE_A, DATE_B, MOODY
from .test_meal_plan import assert_plan_is_coherent, plan_items

GENERATE = {
    "location_id": MOODY,
    "date": DATE_A,
    "constraints": "high protein, no peanuts",
    "targets": {"calories": 2200, "protein_g": 140},
}


async def catalog_for(api, location_id=MOODY, date=DATE_A) -> dict:
    """Every item served that day, as the plan endpoints see it."""
    periods = (
        await api.get(f"/dining/locations/{location_id}/periods", params={"date": date})
    ).json()["periods"]

    catalog = {}
    for period in periods:
        menu = (
            await api.get(
                f"/dining/locations/{location_id}/menu",
                params={"date": date, "period": period["id"]},
            )
        ).json()
        for item in menu["items"]:
            catalog[item["id"]] = item
    return catalog


# ---------------------------------------------------------------------------
# Health / meta
# ---------------------------------------------------------------------------


async def test_health_reports_database_and_gemini_state(api):
    body = (await api.get("/health")).json()

    assert body["status"] == "ok"
    assert body["database"]["connected"] is True
    assert body["database"]["error"] is None
    assert body["gemini"]["configured"] is False


async def test_health_never_leaks_connection_details(api, monkeypatch):
    """/health is unauthenticated, so a DB failure must not describe itself."""
    from app import main as main_module

    class Boom:
        def connect(self):
            raise RuntimeError(
                "password authentication failed for user 'tsdbadmin' at "
                "m0qsxa168g.ms25ftg8ju.tsdb.cloud.timescale.com:39906"
            )

        async def dispose(self):  # called by the app's lifespan shutdown
            return None

    monkeypatch.setattr(main_module, "engine", Boom())
    body = (await api.get("/health")).json()

    assert body["database"]["connected"] is False
    assert body["database"]["error"] == "RuntimeError"

    rendered = str(body)
    for secret in ("password", "tsdbadmin", "timescale.com", "39906"):
        assert secret not in rendered


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def test_register_returns_a_usable_token(api):
    resp = await api.post(
        "/auth/register",
        json={"email": "new@uh.edu", "password": "password123", "full_name": "New"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "new@uh.edu"
    assert "password" not in str(body["user"])

    me = await api.get(
        "/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200
    assert me.json()["id"] == body["user"]["id"]


async def test_email_is_normalised_and_unique(api):
    await api.post("/auth/register", json={"email": "Dup@UH.edu", "password": "password123"})
    again = await api.post(
        "/auth/register", json={"email": "dup@uh.edu", "password": "password123"}
    )
    assert again.status_code == 409

    login = await api.post(
        "/auth/login", json={"email": "  DUP@uh.EDU  ", "password": "password123"}
    )
    assert login.status_code == 200


async def test_wrong_password_is_rejected(api, auth):
    resp = await api.post(
        "/auth/login", json={"email": "coog@uh.edu", "password": "not-the-password"}
    )
    assert resp.status_code == 401


async def test_short_password_is_rejected(api):
    resp = await api.post("/auth/register", json={"email": "x@uh.edu", "password": "short"})
    assert resp.status_code == 422


async def test_password_is_stored_hashed(api, auth):
    """The database must never hold the plaintext password."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import User

    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.email == "coog@uh.edu"))

    assert user is not None
    assert user.password_hash != "gocoogs2026"
    assert user.password_hash.startswith("$2b$")


@pytest.mark.parametrize(
    "headers",
    [None, {"Authorization": "Bearer nonsense"}, {"Authorization": "Basic abc"}],
)
async def test_protected_routes_require_a_valid_token(api, headers):
    resp = await api.get("/plans", headers=headers or {})
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------


async def test_profile_requires_a_token(api):
    assert (await api.get("/profile")).status_code in (401, 403)
    assert (await api.put("/profile", json={"diet": "vegan"})).status_code in (401, 403)


async def test_profile_has_defaults_before_first_save(api, auth):
    headers, _ = auth
    body = (await api.get("/profile", headers=headers)).json()

    assert body["calorie_goal"] == 2200
    assert body["diet"] == "none"
    assert body["allergies"] == []
    assert body["updated_at"] is None


async def test_profile_partial_updates_persist(api, auth):
    headers, _ = auth
    first = await api.put(
        "/profile",
        headers=headers,
        json={
            "diet": "vegetarian",
            "allergies": ["Peanut", "Tree Nut"],
            "avoid": ["mushrooms"],
            "schedule": {"breakfast": "08:00", "lunch": "12:30", "dinner": "18:30"},
        },
    )
    assert first.status_code == 200, first.text

    # A later save of one field leaves the others alone.
    second = await api.put("/profile", headers=headers, json={"calorie_goal": 2600})
    assert second.status_code == 200

    body = (await api.get("/profile", headers=headers)).json()
    assert body["calorie_goal"] == 2600
    assert body["diet"] == "vegetarian"
    assert body["allergies"] == ["Peanut", "Tree Nut"]
    assert body["avoid"] == ["mushrooms"]
    assert body["schedule"]["lunch"] == "12:30"
    assert body["updated_at"] is not None


@pytest.mark.parametrize(
    "patch",
    [
        {"calorie_goal": 50},
        {"protein_goal": 9000},
        {"diet": "carnivore"},
        {"schedule": {"lunch": "noon"}},
        {"allergies": ["x"] * 21},
    ],
)
async def test_profile_rejects_invalid_values(api, auth, patch):
    headers, _ = auth
    assert (await api.put("/profile", headers=headers, json=patch)).status_code == 422


async def test_profiles_are_per_user(api, auth):
    headers, _ = auth
    await api.put("/profile", headers=headers, json={"diet": "vegan"})

    other = await api.post(
        "/auth/register", json={"email": "other@uh.edu", "password": "password123"}
    )
    other_headers = {"Authorization": f"Bearer {other.json()['access_token']}"}
    assert (await api.get("/profile", headers=other_headers)).json()["diet"] == "none"


# ---------------------------------------------------------------------------
# Plan generation
# ---------------------------------------------------------------------------


async def test_generate_persists_a_coherent_plan(api, auth):
    headers, user = auth
    resp = await api.post("/plans/generate", headers=headers, json=GENERATE)

    assert resp.status_code == 201, resp.text
    plan = resp.json()

    assert plan["user_id"] == user["id"]
    assert plan["plan_date"] == DATE_A
    assert plan["constraints_text"] == GENERATE["constraints"]
    assert plan["sources"]["location_id"] == MOODY
    assert plan["sources"]["location_name"] == "Moody Towers Dining Commons"
    assert plan["revision_count"] == 0

    assert_plan_is_coherent(plan["content"], await catalog_for(api))

    # Reading it back gives the same plan.
    fetched = await api.get(f"/plans/{plan['id']}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["content"] == plan["content"]


async def test_generated_plan_only_uses_that_days_menu(api, auth):
    """The strongest cross-check: every chosen item is on the right day."""
    headers, _ = auth
    plan = (await api.post("/plans/generate", headers=headers, json=GENERATE)).json()

    todays = set(await catalog_for(api, date=DATE_A))
    other_day = set(await catalog_for(api, date=DATE_B))
    chosen = {i["item_id"] for i in plan_items(plan["content"])}

    assert chosen <= todays
    # And it is not accidentally drawing from the other date.
    assert not (chosen - todays) & other_day


async def test_plan_records_an_initial_revision(api, auth):
    headers, _ = auth
    plan = (await api.post("/plans/generate", headers=headers, json=GENERATE)).json()

    assert len(plan["revisions"]) == 1
    revision = plan["revisions"][0]
    assert revision["revision_number"] == 0
    assert revision["tool_used"] == "initial"


async def test_generate_can_target_a_single_period(api, auth):
    headers, _ = auth
    periods = (
        await api.get(f"/dining/locations/{MOODY}/periods", params={"date": DATE_A})
    ).json()["periods"]
    dinner = next(p for p in periods if p["name"] == "Dinner")

    plan = (
        await api.post(
            "/plans/generate",
            headers=headers,
            json={**GENERATE, "period_ids": [dinner["id"]]},
        )
    ).json()

    assert plan["sources"]["period_ids"] == [dinner["id"]]
    assert {m["period_id"] for m in plan["content"]["meals"]} == {dinner["id"]}


async def test_generate_falls_back_to_saved_profile_goals(api, auth):
    headers, _ = auth
    await api.put(
        "/profile", headers=headers, json={"calorie_goal": 1800, "protein_goal": 90}
    )

    plan = (
        await api.post(
            "/plans/generate",
            headers=headers,
            json={"location_id": MOODY, "date": DATE_A},
        )
    ).json()

    assert plan["targets"] == {"calories": 1800, "protein_g": 90}
    assert "calories" in plan["content"]["target_fit"]

    # Explicit targets on the request still win over the saved goals.
    explicit = (await api.post("/plans/generate", headers=headers, json=GENERATE)).json()
    assert explicit["targets"] == GENERATE["targets"]


async def test_generate_without_a_profile_sets_no_targets(api, auth):
    headers, _ = auth
    plan = (
        await api.post(
            "/plans/generate",
            headers=headers,
            json={"location_id": MOODY, "date": DATE_A},
        )
    ).json()

    assert plan["targets"] == {}


async def test_offline_planner_honours_saved_allergies(api, auth):
    headers, _ = auth
    await api.put("/profile", headers=headers, json={"allergies": ["Milk", "Egg"]})

    plan = (
        await api.post(
            "/plans/generate",
            headers=headers,
            json={"location_id": MOODY, "date": DATE_A},
        )
    ).json()

    items = plan_items(plan["content"])
    assert items
    for item in items:
        allergens = {a.lower() for a in item["allergens"]}
        assert not {"milk", "egg"} & allergens, item["name"]


async def test_generate_rejects_a_period_not_served_that_day(api, auth):
    headers, _ = auth
    resp = await api.post(
        "/plans/generate",
        headers=headers,
        json={**GENERATE, "period_ids": ["6aa5f5c5271b6d7019756f99"]},
    )

    assert resp.status_code == 400
    assert "not served" in resp.json()["detail"]


async def test_generate_rejects_a_period_from_another_location(api, auth):
    """Cougar Woods period ids must not be usable against Moody."""
    headers, _ = auth
    cw = (
        await api.get(
            f"/dining/locations/{COUGAR_WOODS}/periods", params={"date": DATE_A}
        )
    ).json()["periods"]

    resp = await api.post(
        "/plans/generate",
        headers=headers,
        json={**GENERATE, "period_ids": [cw[0]["id"]]},
    )
    assert resp.status_code == 400


async def test_generate_surfaces_upstream_failure(api, auth):
    headers, _ = auth
    resp = await api.post(
        "/plans/generate",
        headers=headers,
        json={**GENERATE, "date": "2031-01-01"},  # no recording -> upstream 404
    )
    assert resp.status_code == 502


# ---------------------------------------------------------------------------
# The week plan
# ---------------------------------------------------------------------------


def _week(board_id="board-1", dates=(DATE_A, DATE_B)):
    return {"id": board_id, "query": "high protein", "periods": [], "dates": list(dates)}


async def _generate_week(api, headers, board, dates):
    for date in dates:
        resp = await api.post(
            "/plans/generate", headers=headers, json={**GENERATE, "date": date, "board": board}
        )
        assert resp.status_code == 201, resp.text


async def test_week_plan_is_saved_and_restored(api, auth):
    headers, _ = auth
    assert (await api.get("/plans/week", headers=headers)).json() is None

    # Days finish out of order; the week still comes back in date order.
    await _generate_week(api, headers, _week(), [DATE_B, DATE_A])

    week = (await api.get("/plans/week", headers=headers)).json()
    assert week["board_id"] == "board-1"
    assert week["location_id"] == MOODY
    assert week["query"] == "high protein"
    assert week["dates"] == [DATE_A, DATE_B]
    assert [plan["plan_date"] for plan in week["plans"]] == [DATE_A, DATE_B]
    assert all(plan["sources"]["kind"] == "week" for plan in week["plans"])


async def test_a_recommendation_is_not_a_week_plan(api, auth):
    headers, _ = auth
    plan = (await api.post("/plans/generate", headers=headers, json=GENERATE)).json()

    assert plan["sources"]["kind"] == "meal"
    assert (await api.get("/plans/week", headers=headers)).json() is None


async def test_newest_week_wins_and_clearing_does_not_resurrect_an_older_one(api, auth):
    headers, _ = auth
    await _generate_week(api, headers, _week("board-1", [DATE_A]), [DATE_A])
    await _generate_week(api, headers, _week("board-2", [DATE_B]), [DATE_B])
    assert (await api.get("/plans/week", headers=headers)).json()["board_id"] == "board-2"

    assert (await api.delete("/plans/week/board-2", headers=headers)).status_code == 204
    assert (await api.get("/plans/week", headers=headers)).json() is None
    # The plans themselves are kept.
    assert len((await api.get("/plans", headers=headers)).json()) == 2


async def test_week_plans_are_per_user(api, auth):
    headers, _ = auth
    await _generate_week(api, headers, _week(), [DATE_A])

    other = await api.post(
        "/auth/register", json={"email": "other@uh.edu", "password": "password123"}
    )
    other_headers = {"Authorization": f"Bearer {other.json()['access_token']}"}

    assert (await api.get("/plans/week", headers=other_headers)).json() is None
    assert (await api.delete("/plans/week/board-1", headers=other_headers)).status_code == 204
    assert (await api.get("/plans/week", headers=headers)).json()["board_id"] == "board-1"


async def test_board_ids_are_validated(api, auth):
    headers, _ = auth
    resp = await api.post(
        "/plans/generate",
        headers=headers,
        json={**GENERATE, "board": {**_week(), "id": "not/a valid id"}},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Listing, isolation, deletion
# ---------------------------------------------------------------------------


async def test_plans_are_listed_newest_first_and_filterable(api, auth):
    headers, _ = auth
    await api.post("/plans/generate", headers=headers, json=GENERATE)
    await api.post("/plans/generate", headers=headers, json={**GENERATE, "date": DATE_B})

    listed = (await api.get("/plans", headers=headers)).json()
    assert len(listed) == 2

    only_b = (await api.get("/plans", headers=headers, params={"date": DATE_B})).json()
    assert [p["plan_date"] for p in only_b] == [DATE_B]


async def test_many_plans_belong_to_one_user(api, auth):
    headers, user = auth
    for _ in range(3):
        assert (
            await api.post("/plans/generate", headers=headers, json=GENERATE)
        ).status_code == 201

    listed = (await api.get("/plans", headers=headers)).json()
    assert len(listed) == 3
    assert len({p["id"] for p in listed}) == 3

    for summary in listed:
        full = (await api.get(f"/plans/{summary['id']}", headers=headers)).json()
        assert full["user_id"] == user["id"]


async def test_pagination(api, auth):
    headers, _ = auth
    for _ in range(3):
        await api.post("/plans/generate", headers=headers, json=GENERATE)

    page = (
        await api.get("/plans", headers=headers, params={"limit": 2, "offset": 0})
    ).json()
    rest = (
        await api.get("/plans", headers=headers, params={"limit": 2, "offset": 2})
    ).json()

    assert len(page) == 2 and len(rest) == 1
    assert not {p["id"] for p in page} & {p["id"] for p in rest}


async def test_a_users_plans_are_invisible_to_others(api, auth):
    headers, _ = auth
    plan_id = (
        await api.post("/plans/generate", headers=headers, json=GENERATE)
    ).json()["id"]

    other = await api.post(
        "/auth/register", json={"email": "other@uh.edu", "password": "password123"}
    )
    other_headers = {"Authorization": f"Bearer {other.json()['access_token']}"}

    assert (await api.get("/plans", headers=other_headers)).json() == []
    # 404 rather than 403, so plan ids cannot be probed.
    assert (await api.get(f"/plans/{plan_id}", headers=other_headers)).status_code == 404
    assert (
        await api.delete(f"/plans/{plan_id}", headers=other_headers)
    ).status_code == 404
    assert (
        await api.post(
            f"/plans/{plan_id}/refine",
            headers=other_headers,
            json={"instruction": "change it"},
        )
    ).status_code == 404

    # Still intact for its owner.
    assert (await api.get(f"/plans/{plan_id}", headers=headers)).status_code == 200


async def test_delete_removes_the_plan_and_its_revisions(api, auth):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import PlanRevision

    headers, _ = auth
    plan_id = (
        await api.post("/plans/generate", headers=headers, json=GENERATE)
    ).json()["id"]

    assert (await api.delete(f"/plans/{plan_id}", headers=headers)).status_code == 204
    assert (await api.get(f"/plans/{plan_id}", headers=headers)).status_code == 404

    async with SessionLocal() as session:
        remaining = await session.scalar(
            select(func.count()).select_from(PlanRevision)
        )
    assert remaining == 0


async def test_unknown_plan_id_is_404(api, auth):
    headers, _ = auth
    resp = await api.get(
        "/plans/00000000-0000-0000-0000-000000000000", headers=headers
    )
    assert resp.status_code == 404


async def test_malformed_plan_id_is_422(api, auth):
    headers, _ = auth
    assert (await api.get("/plans/not-a-uuid", headers=headers)).status_code == 422
