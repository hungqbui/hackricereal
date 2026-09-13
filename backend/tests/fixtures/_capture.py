"""Refresh the recorded DineOnCampus payloads used by the offline tests.

Run from the backend dir:  python tests/fixtures/_capture.py
"""
import asyncio, json, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from app.services.dineoncampus import DineOnCampusClient

HERE = pathlib.Path(__file__).parent
MOODY = "59b2b6e2ee596fc4596321b0"
COUGAR_WOODS = "599e466a3191a2fc7f3d0d0d"
DATE_A = "2026-09-15"
DATE_B = "2026-09-16"


async def main() -> None:
    client = DineOnCampusClient()
    try:
        (HERE / "locations.json").write_text(
            json.dumps(await client._get(
                f"/sites/{client.site_id}/locations-public",
                {"for_menus": "true", "locale": "en"}), indent=1))

        for label, loc, date in [
            ("moody_a", MOODY, DATE_A),
            ("moody_b", MOODY, DATE_B),
            ("cougarwoods_a", COUGAR_WOODS, DATE_A),
        ]:
            periods = await client.list_periods(loc, date)
            (HERE / f"periods_{label}.json").write_text(json.dumps(periods, indent=1))
            menus = {}
            for p in periods["periods"]:
                menus[p["id"]] = await client.get_menu(loc, date, p["id"])
            (HERE / f"menus_{label}.json").write_text(json.dumps(menus, indent=1))
            print(label, date, "periods:", [p["name"] for p in periods["periods"]])

        (HERE / "details_moody.json").write_text(
            json.dumps(await client.location_details(MOODY), indent=1))
    finally:
        await client.aclose()


asyncio.run(main())
