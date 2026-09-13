"""Nutrition normalisation: the numbers a meal plan is optimised against.

These cross-check the parsed output against the raw recorded payload
rather than hard-coding values, so refreshing the fixtures cannot
quietly invalidate the suite.
"""

import pytest

from app.services.nutrition import (
    MACRO_FIELDS,
    empty_totals,
    flatten_menu,
    parse_item,
    sum_macros,
)

from .conftest import DATE_A, MOODY


def _raw_items(recorded, label="moody_a"):
    for payload in recorded[label]["menus"].values():
        for category in (payload.get("period") or {}).get("categories") or []:
            for item in category.get("items") or []:
                yield category.get("name"), item


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_every_macro_matches_the_raw_nutrient_block(recorded):
    """Parsed macros must equal the upstream nutrient values exactly."""
    label_to_field = {
        "Calories": "calories",
        "Protein (g)": "protein_g",
        "Total Carbohydrates (g)": "carbs_g",
        "Total Fat (g)": "fat_g",
        "Dietary Fiber (g)": "fiber_g",
        "Sodium (mg)": "sodium_mg",
    }

    checked = 0
    for category, raw in _raw_items(recorded):
        parsed = parse_item(raw, category)
        for nutrient in raw.get("nutrients") or []:
            field = label_to_field.get(nutrient.get("name"))
            if field is None:
                continue
            expected = float(nutrient["valueNumeric"])
            assert parsed[field] == pytest.approx(expected), (
                f"{raw['name']}: {field} parsed as {parsed[field]}, "
                f"upstream says {expected}"
            )
            checked += 1

    assert checked > 500, "fixture should cover a lot of nutrient values"


def test_menu_items_carry_usable_macros(moody_lunch):
    items = moody_lunch["items"]
    assert len(items) > 50

    with_macros = [
        i for i in items
        if i["calories"] is not None and i["protein_g"] is not None
    ]
    # Planning is meaningless if most items have no nutrition attached.
    assert len(with_macros) / len(items) > 0.9


def test_category_is_attached_to_each_item(moody_lunch):
    assert all(i["category"] for i in moody_lunch["items"])
    assert len(set(i["category"] for i in moody_lunch["items"])) > 3


def test_diet_tags_and_allergens_are_separated(moody_lunch):
    tags = {t for i in moody_lunch["items"] for t in i["tags"]}
    allergens = {a for i in moody_lunch["items"] for a in i["allergens"]}

    assert {"Vegan", "Vegetarian"} <= tags
    assert "Milk" in allergens or "Egg" in allergens
    # A diet tag must never be filed as an allergen, or exclusion logic
    # would start dropping vegan food for "containing Vegan".
    assert not (tags & allergens)


def test_may_contain_asterisk_is_normalised(recorded):
    """'Milk*' (may contain) must be recorded as the Milk allergen."""
    starred = [
        (category, raw)
        for category, raw in _raw_items(recorded)
        if any((f.get("name") or "").endswith("*") for f in raw.get("filters") or [])
    ]
    assert starred, "fixture should contain at least one may-contain marker"

    category, raw = starred[0]
    parsed = parse_item(raw, category)
    assert not any(a.endswith("*") for a in parsed["allergens"])


def test_vegan_items_are_also_vegetarian(moody_lunch):
    for item in moody_lunch["items"]:
        if "Vegan" in item["tags"]:
            assert "Vegetarian" in item["tags"], item["name"]


def test_missing_nutrients_become_none_not_zero():
    parsed = parse_item({"id": "x", "name": "Mystery", "nutrients": []}, "Cat")

    assert parsed["protein_g"] is None
    assert parsed["calories"] is None


def test_calories_fall_back_to_the_top_level_field():
    parsed = parse_item(
        {"id": "x", "name": "Only top-level", "calories": 240, "nutrients": []}, "Cat"
    )
    assert parsed["calories"] == 240


def test_unparseable_values_do_not_crash():
    parsed = parse_item(
        {
            "id": "x",
            "name": "Weird",
            "nutrients": [
                {"name": "Protein (g)", "valueNumeric": "n/a", "value": "n/a"},
                {"name": "Sodium (mg)", "valueNumeric": None, "value": "1,200"},
            ],
        },
        "Cat",
    )
    assert parsed["protein_g"] is None
    assert parsed["sodium_mg"] == 1200.0  # comma-formatted value still parses


def test_closed_location_is_reported(recorded):
    payload = dict(next(iter(recorded["moody_a"]["menus"].values())))
    payload["closedOnDate"] = True

    menu = flatten_menu(payload, MOODY, DATE_A)
    assert menu["closed"] is True


# ---------------------------------------------------------------------------
# Macro arithmetic
# ---------------------------------------------------------------------------


def test_sum_macros_scales_by_servings():
    rows = [
        {"calories": 200, "protein_g": 20, "sodium_mg": 300, "servings": 2},
        {"calories": 150, "protein_g": 5, "sodium_mg": 100, "servings": 0.5},
    ]
    totals = sum_macros(rows)

    assert totals["calories"] == pytest.approx(475.0)
    assert totals["protein_g"] == pytest.approx(42.5)
    assert totals["sodium_mg"] == pytest.approx(650.0)


def test_sum_macros_treats_missing_values_as_zero():
    totals = sum_macros([{"calories": 100, "protein_g": None, "servings": 1}])

    assert totals["calories"] == 100
    assert totals["protein_g"] == 0


def test_sum_macros_defaults_servings_to_one():
    assert sum_macros([{"calories": 100}])["calories"] == 100


def test_empty_totals_covers_every_macro_field():
    totals = empty_totals()
    assert set(totals) == set(MACRO_FIELDS)
    assert all(v == 0 for v in totals.values())


def test_summing_a_real_period_is_finite_and_positive(moody_lunch):
    rows = [dict(i, servings=1) for i in moody_lunch["items"]]
    totals = sum_macros(rows)

    assert totals["calories"] > 0
    assert totals["protein_g"] > 0
    assert all(isinstance(v, float) for v in totals.values())


# ---------------------------------------------------------------------------
# Database URL handling
# ---------------------------------------------------------------------------


def test_postgres_url_is_converted_for_asyncpg():
    from app.db import normalise_db_url

    url, connect_args = normalise_db_url(
        "postgres://user:pw@host.tsdb.cloud.timescale.com:39906/tsdb?sslmode=require"
    )

    assert url.startswith("postgresql+asyncpg://")
    # asyncpg rejects libpq's sslmode; it must become an ssl context instead.
    assert "sslmode" not in url
    assert "ssl" in connect_args


def test_sqlite_url_survives_normalisation():
    from app.db import normalise_db_url

    url, connect_args = normalise_db_url("sqlite+aiosqlite:///C:/tmp/test.db")

    assert url == "sqlite+aiosqlite:///C:/tmp/test.db"
    assert connect_args == {}


def test_missing_database_url_explains_itself():
    from app.db import normalise_db_url

    with pytest.raises(RuntimeError, match="DATABASE_URL is not set"):
        normalise_db_url("")
