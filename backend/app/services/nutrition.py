"""Normalise DineOnCampus menu payloads into flat, macro-bearing items."""

import re
from typing import Any

# DineOnCampus nutrient labels -> our field names.
#
# UH serves two labelling conventions side by side, apparently from two
# upstream feeds: some locations report "Protein (g)" and others plain
# "Protein", with the unit only in the sibling ``uom`` field. Moody Towers uses
# the first, Cougar Woods the second. Matching literal strings meant every
# macro but calories came back null for whole dining halls -- about 35% of
# campus -- so labels are normalised to a unit-less, lower-case key first.
#
# Keys here must be the *normalised* form. Watch the near-misses: "Calories
# From Fat", "Fat Calories", "Trans Fat" and "Saturated Fat + Trans Fat" all
# normalise to distinct keys and are deliberately absent, so none of them can
# be mistaken for calories, fat, or saturated fat.
NUTRIENT_MAP = {
    "calories": "calories",
    "protein": "protein_g",
    "total carbohydrates": "carbs_g",
    "carbohydrates": "carbs_g",
    "total fat": "fat_g",
    "saturated fat": "saturated_fat_g",
    "dietary fiber": "fiber_g",
    "fiber": "fiber_g",
    "sugar": "sugar_g",
    "sugars": "sugar_g",
    "sodium": "sodium_mg",
    "cholesterol": "cholesterol_mg",
    "potassium": "potassium_mg",
    "calcium": "calcium_mg",
    "iron": "iron_mg",
}

_UNIT_SUFFIX = re.compile(r"\s*\([^)]*\)\s*$")


def normalise_nutrient(name: str) -> str:
    """"Protein (g)" and "Protein" are the same nutrient; make them one key."""
    return _UNIT_SUFFIX.sub("", (name or "").strip()).strip().lower()

MACRO_FIELDS = (
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "saturated_fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
)

# Filter names that describe a diet rather than an allergen.
_DIET_TAGS = {
    "vegan",
    "vegetarian",
    "avoiding gluten",
    "good source of protein",
    "how good friendly",
}


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_item(raw: dict, category: str) -> dict:
    """Turn one menu item into a flat record with numeric macros."""
    nutrients: dict[str, float] = {}
    for entry in raw.get("nutrients") or []:
        field = NUTRIENT_MAP.get(normalise_nutrient(entry.get("name") or ""))
        if not field:
            continue
        value = _to_float(entry.get("valueNumeric"))
        if value is None:
            value = _to_float(entry.get("value"))
        # An item carrying both spellings reports the same number twice; keep
        # the first so the result does not depend on nutrient ordering.
        if value is not None and field not in nutrients:
            nutrients[field] = value

    if "calories" not in nutrients:
        cal = _to_float(raw.get("calories"))
        if cal is not None:
            nutrients["calories"] = cal

    tags, allergens = [], []
    for flt in raw.get("filters") or []:
        name = (flt.get("name") or "").strip()
        if not name:
            continue
        if name.lower() in _DIET_TAGS:
            tags.append(name)
        else:
            # A trailing "*" marks "may contain"; keep the base allergen name.
            allergens.append(name.rstrip("*").strip())
    for extra in raw.get("customAllergens") or []:
        label = (extra.get("name") if isinstance(extra, dict) else str(extra)) or ""
        if label:
            allergens.append(label.strip())

    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "category": category,
        "portion": raw.get("portion"),
        "description": (raw.get("desc") or "").strip() or None,
        "ingredients": (raw.get("ingredients") or "").strip() or None,
        "tags": sorted(set(tags)),
        "allergens": sorted(set(allergens)),
        **{field: nutrients.get(field) for field in MACRO_FIELDS},
    }


def flatten_menu(payload: dict, location_id: str, date: str) -> dict:
    """Extract period metadata and every item from a /menu response."""
    period = payload.get("period") or {}
    items: list[dict] = []
    for category in period.get("categories") or []:
        cat_name = category.get("name") or "Uncategorized"
        for raw in category.get("items") or []:
            items.append(parse_item(raw, cat_name))

    status = payload.get("status") or {}
    return {
        "location_id": location_id,
        "date": date,
        "period_id": period.get("id"),
        "period_name": period.get("name"),
        "closed": bool(payload.get("closedOnDate")),
        "status": status.get("message"),
        "categories": [c.get("name") for c in (period.get("categories") or [])],
        "items": items,
    }


def empty_totals() -> dict[str, float]:
    """Totals for a plan that selected nothing: genuinely zero, not unknown."""
    return {field: 0.0 for field in MACRO_FIELDS}


def sum_macros(
    rows: list[dict], servings_key: str = "servings"
) -> dict[str, float | None]:
    """Sum macros across chosen items, scaled by serving count.

    A macro that **no** row published comes back ``None``, not ``0.0``. UH omits
    a macro on a minority of items, and folding those omissions into a zero made
    the API state "0g protein" as fact — indistinguishable from a real zero, and
    the one kind of invented nutrition this service exists to prevent.

    Where only *some* rows carry the macro the known values are still summed:
    a partial total is more useful than discarding good data, and it errs low,
    which is the safe direction for a figure a student eats against.
    """
    totals: dict[str, float] = {field: 0.0 for field in MACRO_FIELDS}
    published: set[str] = set()
    for row in rows:
        try:
            servings = float(row.get(servings_key) or 1)
        except (TypeError, ValueError):
            servings = 1.0
        for field in MACRO_FIELDS:
            value = row.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                totals[field] += float(value) * servings
                published.add(field)
    return {
        field: round(totals[field], 1) if field in published else None
        for field in MACRO_FIELDS
    }
