"""Normalise DineOnCampus menu payloads into flat, macro-bearing items."""

from typing import Any

# DineOnCampus nutrient labels -> our field names.
NUTRIENT_MAP = {
    "Calories": "calories",
    "Protein (g)": "protein_g",
    "Total Carbohydrates (g)": "carbs_g",
    "Total Fat (g)": "fat_g",
    "Saturated Fat (g)": "saturated_fat_g",
    "Dietary Fiber (g)": "fiber_g",
    "Sugar (g)": "sugar_g",
    "Sodium (mg)": "sodium_mg",
    "Cholesterol (mg)": "cholesterol_mg",
    "Potassium (mg)": "potassium_mg",
    "Calcium (mg)": "calcium_mg",
    "Iron (mg)": "iron_mg",
}

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
        field = NUTRIENT_MAP.get(entry.get("name") or "")
        if not field:
            continue
        value = _to_float(entry.get("valueNumeric"))
        if value is None:
            value = _to_float(entry.get("value"))
        if value is not None:
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
    return {field: 0.0 for field in MACRO_FIELDS}


def sum_macros(rows: list[dict], servings_key: str = "servings") -> dict[str, float]:
    """Sum macros across chosen items, scaled by serving count."""
    totals = empty_totals()
    for row in rows:
        try:
            servings = float(row.get(servings_key) or 1)
        except (TypeError, ValueError):
            servings = 1.0
        for field in MACRO_FIELDS:
            value = row.get(field)
            if isinstance(value, (int, float)):
                totals[field] += float(value) * servings
    return {k: round(v, 1) for k, v in totals.items()}
