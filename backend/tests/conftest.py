"""Shared fixtures.

Most tests run fully offline against payloads recorded from the real
DineOnCampus API (see ``tests/fixtures/_capture.py`` to refresh them).
Tests that genuinely need the network are marked ``live``; tests that
need a real Gemini key are marked ``gemini``. Both are deselected by
default -- see pytest.ini.
"""

import json
import os
import pathlib
import sys
from typing import Any

import pytest

BACKEND = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
FIXTURES = pathlib.Path(__file__).parent / "fixtures"

# Must be set before app.config is imported anywhere. app.db builds its
# engine at import time and now refuses an empty URL, so give any module
# that merely imports it a harmless target; the `app_env` fixture points
# tests that actually touch the database at a real temporary file.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production")
os.environ.setdefault("GEMINI_API_KEY", "")

MOODY = "59b2b6e2ee596fc4596321b0"
COUGAR_WOODS = "599e466a3191a2fc7f3d0d0d"
DATE_A = "2026-09-15"
DATE_B = "2026-09-16"

# (location_id, date) -> recorded fixture label
_RECORDED = {
    (MOODY, DATE_A): "moody_a",
    (MOODY, DATE_B): "moody_b",
    (COUGAR_WOODS, DATE_A): "cougarwoods_a",
}


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(scope="session")
def recorded() -> dict:
    """All recorded payloads, keyed by label."""
    data = {"locations": load_fixture("locations.json"),
            "details_moody": load_fixture("details_moody.json")}
    for label in set(_RECORDED.values()):
        data[label] = {
            "periods": load_fixture(f"periods_{label}.json"),
            "menus": load_fixture(f"menus_{label}.json"),
        }
    return data


@pytest.fixture(scope="session")
def moody_menus(recorded) -> list[dict]:
    """Moody's four periods on DATE_A, normalised into flat menus."""
    from app.services.nutrition import flatten_menu

    raw = recorded["moody_a"]["menus"]
    return [flatten_menu(payload, MOODY, DATE_A) for payload in raw.values()]


@pytest.fixture(scope="session")
def moody_lunch(moody_menus) -> dict:
    return next(m for m in moody_menus if m["period_name"] == "Lunch")


# ---------------------------------------------------------------------------
# Offline stub for the DineOnCampus client
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no JSON body")
        return self._payload


class RecordedUpstream:
    """A stand-in HTTP session that replays recorded payloads.

    It substitutes for the client's *transport*, not for ``_get``, so the
    real retry and error handling still run. Any request the
    recordings do not cover returns 404, so a test can never silently
    fall through to the live network.
    """

    def __init__(self, recorded: dict) -> None:
        self._recorded = recorded
        self.calls: list[tuple[str, dict]] = []

    async def get(self, url: str, params: dict | None = None) -> _FakeResponse:
        from app.services.dineoncampus import BASE_URL

        path = url[len(BASE_URL):] if url.startswith(BASE_URL) else url
        params = params or {}
        self.calls.append((path, dict(params)))
        try:
            return _FakeResponse(self._resolve(path, params))
        except LookupError:
            return _FakeResponse(None, status_code=404)

    async def close(self) -> None:
        return None

    def _resolve(self, path: str, params: dict) -> Any:
        if path.endswith("/locations-public"):
            return self._recorded["locations"]

        parts = path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "locations":
            location_id = parts[1]
            tail = parts[2] if len(parts) > 2 else ""

            if tail == "details":
                if location_id != MOODY:
                    raise LookupError(f"no recorded details for {location_id}")
                return self._recorded["details_moody"]

            date = params.get("date")
            label = _RECORDED.get((location_id, date))
            if label is None:
                raise LookupError(
                    f"no recording for location={location_id} date={date}"
                )

            if tail == "periods":
                return self._recorded[label]["periods"]

            if tail == "menu":
                menus = self._recorded[label]["menus"]
                period = params.get("period")
                if period not in menus:
                    # Mirrors upstream: an unknown period yields an empty menu.
                    return {
                        "locationId": location_id,
                        "date": date,
                        "period": None,
                        "closedOnDate": False,
                        "status": {"message": "No menu for this period."},
                    }
                return menus[period]

        raise LookupError(f"unrecorded path {path}")


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """Reload the app against a throwaway database.

    ``app.db`` builds its engine at import time, so the whole ``app``
    package is dropped from ``sys.modules`` and re-imported. Anything
    that patches app internals must depend on this fixture, or it will
    patch the pre-reload module objects and silently have no effect.
    """
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("JWT_SECRET", "test-secret-not-for-production")
    # Never call the real Gemini API from the offline suite, even if the
    # developer running the tests has a key exported.
    monkeypatch.setenv("GEMINI_API_KEY", "")

    for mod in [m for m in list(sys.modules) if m == "app" or m.startswith("app.")]:
        del sys.modules[mod]

    from app.main import app

    return app


@pytest.fixture
def upstream(recorded, monkeypatch, app_env) -> RecordedUpstream:
    """Swap the client's HTTP session for the recordings."""
    from app.services import dineoncampus

    stub = RecordedUpstream(recorded)
    monkeypatch.setattr(
        dineoncampus.DineOnCampusClient, "_ensure_session", lambda self: stub
    )
    # Exercise the retry path without paying its backoff in wall time.
    monkeypatch.setattr(dineoncampus.asyncio, "sleep", _no_sleep)
    return stub


async def _no_sleep(_seconds: float) -> None:
    return None


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------


@pytest.fixture
async def api(app_env, upstream):
    """A FastAPI test client wired to the recorded upstream."""
    from httpx import ASGITransport, AsyncClient

    async with app_env.router.lifespan_context(app_env):
        transport = ASGITransport(app=app_env)
        async with AsyncClient(
            transport=transport, base_url="http://test", timeout=60
        ) as client:
            yield client


@pytest.fixture
async def auth(api):
    """Register a user and return (headers, user_json)."""
    resp = await api.post(
        "/auth/register",
        json={
            "email": "coog@uh.edu",
            "password": "gocoogs2026",
            "full_name": "Test Coog",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["user"]
