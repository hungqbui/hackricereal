"""Client for the public DineOnCampus v4 API.

The upstream sits behind Cloudflare, which fingerprints the TLS
handshake: plain Python HTTP clients get a 403 no matter what headers
they send. ``curl_cffi`` reproduces Chrome's TLS/JA3 signature, so it is
the primary transport; httpx is kept as a fallback for environments
where curl_cffi will not build (it will usually be blocked).
"""

import asyncio
from typing import Any

from ..config import get_settings

BASE_URL = "https://apiv4.dineoncampus.com"

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://dineoncampus.com",
    "Referer": "https://dineoncampus.com/",
    # Upstream answers differently depending on Sec-Fetch-Dest. A "document"
    # request -- which curl_cffi's Chrome impersonation sends by default, as if
    # the URL were opened in a tab -- gets the raw menu with no hours applied:
    # no closedOnDate, no status, and a full item list for a hall that is shut
    # that day. "empty" is what dineoncampus.com's own fetch() calls send, and
    # gets the real answer: closedOnDate true and no categories when closed.
    # These override the impersonation defaults.
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}

try:  # pragma: no cover - import-time capability probe
    from curl_cffi.requests import AsyncSession as _CurlSession

    HAS_CURL_CFFI = True
except ImportError:  # pragma: no cover
    _CurlSession = None
    HAS_CURL_CFFI = False


class DineOnCampusError(RuntimeError):
    pass


class DineOnCampusClient:
    """Every call goes to upstream. Nothing is cached, so a menu the hall
    republishes shows up on the next request rather than minutes later."""

    def __init__(self, site_id: str | None = None) -> None:
        settings = get_settings()
        self.site_id = site_id or settings.dineoncampus_site_id
        self._session: Any | None = None

    def _ensure_session(self) -> Any:
        """Sessions are created lazily so the client binds to the running loop."""
        if self._session is None:
            if HAS_CURL_CFFI:
                self._session = _CurlSession(
                    headers=_BROWSER_HEADERS, timeout=30, impersonate="chrome"
                )
            else:
                import httpx

                self._session = httpx.AsyncClient(
                    headers=_BROWSER_HEADERS, timeout=30.0, follow_redirects=True
                )
        return self._session

    async def aclose(self) -> None:
        if self._session is None:
            return
        closer = getattr(self._session, "close", None) or getattr(
            self._session, "aclose", None
        )
        if closer is not None:
            result = closer()
            if asyncio.iscoroutine(result):
                await result
        self._session = None

    async def _get(self, path: str, params: dict | None = None) -> Any:
        url = f"{BASE_URL}{path}"
        last_error: str | None = None

        for attempt in range(3):
            try:
                resp = await self._ensure_session().get(url, params=params)
            except Exception as exc:  # transport differs per backend
                last_error = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 403:
                    last_error = (
                        "Cloudflare returned 403"
                        + ("" if HAS_CURL_CFFI else " (install curl_cffi to fix)")
                    )
                elif resp.status_code >= 400:
                    last_error = f"HTTP {resp.status_code}"
                else:
                    try:
                        payload = resp.json()
                    except ValueError as exc:
                        last_error = f"invalid JSON: {exc}"
                    else:
                        return payload

            if attempt < 2:
                await asyncio.sleep(0.6 * (attempt + 1))

        raise DineOnCampusError(f"request to {path} failed: {last_error}")

    # ---------- endpoints ----------

    async def list_locations(self) -> list[dict]:
        """Flatten the site's buildings into a single location list."""
        data = await self._get(
            f"/sites/{self.site_id}/locations-public",
            {"for_menus": "true", "locale": "en"},
        )

        out: list[dict] = []

        def add(loc: dict, building: str | None) -> None:
            if loc.get("id"):
                out.append(
                    {
                        "id": loc["id"],
                        "name": loc.get("displayName") or loc.get("name"),
                        "building": building,
                        "sort_order": loc.get("sortOrder", 0),
                    }
                )

        for building in data.get("buildings") or []:
            for loc in building.get("locations") or []:
                add(loc, building.get("buildingName"))
        for loc in data.get("standaloneLocations") or []:
            add(loc, loc.get("buildingName"))
        return out

    async def location_details(self, location_id: str) -> dict:
        return await self._get(f"/locations/{location_id}/details")

    async def list_periods(self, location_id: str, date: str) -> dict:
        """Meal periods served at a location on a date."""
        data = await self._get(f"/locations/{location_id}/periods/", {"date": date})
        return {
            "location_id": location_id,
            "date": date,
            "periods": [
                {"id": p.get("id"), "name": p.get("name"), "slug": p.get("slug")}
                for p in (data.get("periods") or [])
                if p.get("id")
            ],
        }

    async def get_menu(self, location_id: str, date: str, period_id: str) -> dict:
        return await self._get(
            f"/locations/{location_id}/menu",
            {"date": date, "period": period_id},
        )
