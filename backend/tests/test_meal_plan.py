"""Sanity checks: does the planner compile a *health-aware* meal plan?

Three separable concerns are covered:

* **Integrity** -- macros in a stored plan are recomputed from the real
  menu, so a model that hallucinates an item or its nutrition cannot
  poison the numbers.
* **Health awareness** -- the plan moves toward the stated calorie and
  protein targets and never violates a dietary exclusion.
* **Prompting** -- the model is actually *given* the tags, allergens and
  targets it needs to make those decisions.
"""

import pytest

from app.services import gemini
from app.services.nutrition import MACRO_FIELDS

from .conftest import DATE_A, MOODY

TARGETS = {"calories": 2200, "protein_g": 140, "fiber_g": 30}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def recompute(content: dict, catalog: dict) -> dict:
    """Independently re-derive plan totals straight from the catalog."""
    totals = {field: 0.0 for field in MACRO_FIELDS}
    for meal in content["meals"]:
        for item in meal["items"]:
            source = catalog[item["item_id"]]
            for field in MACRO_FIELDS:
                value = source.get(field)
                if isinstance(value, (int, float)):
                    totals[field] += value * item["servings"]
    return {k: round(v, 1) for k, v in totals.items()}


def assert_plan_is_coherent(content: dict, catalog: dict) -> None:
    """Structural invariants every stored plan must satisfy."""
    assert content["title"]
    assert content["meals"]

    for meal in content["meals"]:
        for item in meal["items"]:
            assert item["item_id"] in catalog, "plan cites an item not on the menu"
            source = catalog[item["item_id"]]
            # Denormalised fields must agree with the menu.
            assert item["name"] == source["name"]
            assert item["category"] == source["category"]
            assert item["tags"] == source["tags"]
            assert item["allergens"] == source["allergens"]
            for field in MACRO_FIELDS:
                assert item[field] == source[field]
            assert 0.25 <= item["servings"] <= 4.0

        # Per-meal totals agree with that meal's items.
        expected = {field: 0.0 for field in MACRO_FIELDS}
        for item in meal["items"]:
            for field in MACRO_FIELDS:
                if isinstance(item[field], (int, float)):
                    expected[field] += item[field] * item["servings"]
        for field in MACRO_FIELDS:
            assert meal["totals"][field] == pytest.approx(expected[field], abs=0.15)

    # Day totals agree with the catalog, independently recomputed.
    reference = recompute(content, catalog)
    for field in MACRO_FIELDS:
        assert content["totals"][field] == pytest.approx(reference[field], abs=0.15)


def plan_items(content: dict) -> list[dict]:
    return [item for meal in content["meals"] for item in meal["items"]]


# ---------------------------------------------------------------------------
# Integrity: the model selects, the server does the arithmetic
# ---------------------------------------------------------------------------


def test_macros_come_from_the_menu_not_from_the_model(moody_menus):
    """A model that reports wrong nutrition must be ignored."""
    catalog = gemini.build_catalog(moody_menus)
    real_id, real = next(
        (k, v) for k, v in catalog.items() if v["calories"] and v["protein_g"]
    )
    lying_selection = {
        "title": "Liar",
        "summary": "s",
        "meals": [{
            "period_id": moody_menus[0]["period_id"],
            "items": [{
                "item_id": real_id,
                "servings": 1,
                "reason": "r",
                # These bogus numbers must never reach the stored plan.
                "calories": 99999,
                "protein_g": 12345,
            }],
        }],
    }

    content = gemini.hydrate_plan(lying_selection, catalog, moody_menus, {})
    item = plan_items(content)[0]

    assert item["calories"] == real["calories"]
    assert item["protein_g"] == real["protein_g"]
    assert content["totals"]["calories"] == pytest.approx(real["calories"])


def test_hallucinated_items_are_dropped_and_reported(moody_menus):
    catalog = gemini.build_catalog(moody_menus)
    real_id = next(iter(catalog))
    selection = {
        "title": "Half real",
        "summary": "s",
        "meals": [{
            "period_id": moody_menus[0]["period_id"],
            "items": [
                {"item_id": "does-not-exist", "servings": 1},
                {"item_id": real_id, "servings": 1},
            ],
        }],
    }

    content = gemini.hydrate_plan(selection, catalog, moody_menus, {})

    assert [i["item_id"] for i in plan_items(content)] == [real_id]
    assert any("does-not-exist" in w for w in content["warnings"])


def _one_item_plan(moody_menus, catalog, servings):
    selection = {
        "title": "t", "summary": "s",
        "meals": [{
            "period_id": moody_menus[0]["period_id"],
            "items": [{"item_id": next(iter(catalog)), "servings": servings}],
        }],
    }
    return gemini.hydrate_plan(selection, catalog, moody_menus, {})


@pytest.mark.parametrize(
    "requested,expected",
    [(99, 4.0), ("2", 2.0), (None, 1.0), (0.5, 0.5), ("garbage", 1.0)],
)
def test_servings_are_clamped_to_something_edible(moody_menus, requested, expected):
    catalog = gemini.build_catalog(moody_menus)
    content = _one_item_plan(moody_menus, catalog, requested)

    assert plan_items(content)[0]["servings"] == expected


@pytest.mark.parametrize("requested", [0, -3])
def test_non_positive_servings_drop_the_item(moody_menus, requested):
    """"Zero servings" means the model does not want it, not one serving."""
    catalog = gemini.build_catalog(moody_menus)
    content = _one_item_plan(moody_menus, catalog, requested)

    assert plan_items(content) == []
    assert content["warnings"]
    assert content["totals"]["calories"] == 0


def test_target_fit_reports_gap_against_targets(moody_menus):
    catalog = gemini.build_catalog(moody_menus)
    item_id, item = next(
        (k, v) for k, v in catalog.items() if (v["calories"] or 0) > 100
    )
    selection = {
        "title": "t", "summary": "s",
        "meals": [{
            "period_id": moody_menus[0]["period_id"],
            "items": [{"item_id": item_id, "servings": 1}],
        }],
    }

    content = gemini.hydrate_plan(selection, catalog, moody_menus, {"calories": 2000})
    fit = content["target_fit"]["calories"]

    assert fit["target"] == 2000
    assert fit["actual"] == pytest.approx(item["calories"])
    assert fit["delta"] == pytest.approx(item["calories"] - 2000)
    assert fit["pct_of_target"] == pytest.approx(item["calories"] / 2000 * 100, rel=1e-3)


def test_target_fit_is_empty_when_no_targets_given(moody_menus):
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(
        {"title": "t", "meals": []}, catalog, moody_menus, {}
    )
    assert content["target_fit"] == {}
    assert content["totals"]["calories"] == 0


def test_catalog_spans_every_period(moody_menus):
    catalog = gemini.build_catalog(moody_menus)
    total = sum(len(m["items"]) for m in moody_menus)

    assert len(catalog) > 100
    assert len(catalog) <= total  # ids may repeat across periods


# ---------------------------------------------------------------------------
# Health awareness
# ---------------------------------------------------------------------------


def test_plan_moves_toward_the_calorie_target(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, None, None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    assert_plan_is_coherent(content, catalog)
    calories = content["totals"]["calories"]
    assert 0.75 * TARGETS["calories"] <= calories <= 1.15 * TARGETS["calories"], (
        f"{calories} kcal is not close to the {TARGETS['calories']} kcal target"
    )


def test_plan_prioritises_protein(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, None, None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    protein = content["totals"]["protein_g"]
    calories = content["totals"]["calories"]

    assert protein >= 0.5 * TARGETS["protein_g"]
    # Protein should be a serious share of energy, not an afterthought.
    assert (protein * 4) / max(calories, 1) > 0.15


def test_plan_is_real_food_not_a_pile_of_condiments(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, None, None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)
    items = plan_items(content)

    assert items
    # The greedy planner used to fill a day with soy sauce and spinach
    # because they win on protein-per-calorie.
    assert all((i["calories"] or 0) >= 50 for i in items), (
        f"condiments selected: {[i['name'] for i in items if (i['calories'] or 0) < 50]}"
    )
    assert content["totals"]["sodium_mg"] < 9000


def test_plan_covers_the_days_meal_periods(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, None, None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    served = {m["period_id"] for m in moody_menus if m["items"]}
    planned = {m["period_id"] for m in content["meals"]}
    assert planned == served

    named = {m["period_name"] for m in content["meals"]}
    assert {"Breakfast", "Lunch", "Dinner"} <= named


def test_vegan_request_yields_only_vegan_items(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, "strictly vegan", None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    items = plan_items(content)
    assert items, "a vegan plan should still find food at a dining hall"
    offenders = [i["name"] for i in items if "Vegan" not in i["tags"]]
    assert not offenders, f"non-vegan items in a vegan plan: {offenders}"


def test_vegetarian_request_excludes_meat(moody_menus):
    selection = gemini.fallback_selection(moody_menus, TARGETS, "vegetarian", None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    for item in plan_items(content):
        assert {"Vegan", "Vegetarian"} & set(item["tags"]), item["name"]


@pytest.mark.parametrize(
    "phrase,allergen",
    [
        ("allergic to peanuts", "Peanuts"),
        ("no milk please", "Milk"),
        ("avoid soy", "Soy"),
        ("no pork", "Pork"),
    ],
)
def test_named_allergens_are_never_served(moody_menus, phrase, allergen):
    selection = gemini.fallback_selection(moody_menus, TARGETS, phrase, None)
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    offenders = [
        i["name"] for i in plan_items(content)
        if any(allergen.lower() in a.lower() for a in i["allergens"])
    ]
    assert not offenders, f"{phrase!r} still returned {offenders}"


def test_standing_dietary_profile_is_applied_without_a_request(moody_menus):
    """A user's saved 'vegan' note constrains a plan with no constraints text."""
    selection = gemini.fallback_selection(moody_menus, TARGETS, None, "I am vegan")
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    assert all("Vegan" in i["tags"] for i in plan_items(content))


def test_impossible_constraints_degrade_gracefully(moody_menus):
    selection = gemini.fallback_selection(
        moody_menus,
        TARGETS,
        "vegan, no soy, no wheat, no gluten, allergic to milk, no egg",
        None,
    )
    catalog = gemini.build_catalog(moody_menus)
    content = gemini.hydrate_plan(selection, catalog, moody_menus, TARGETS)

    # Whatever survives must still be valid and honest about shortfalls.
    assert_plan_is_coherent(content, catalog)
    assert content["warnings"]


def test_empty_menu_produces_a_warning_not_a_crash():
    empty = [{"period_id": "p1", "period_name": "Lunch", "items": []}]
    selection = gemini.fallback_selection(empty, TARGETS, None, None)
    content = gemini.hydrate_plan(selection, gemini.build_catalog(empty), empty, TARGETS)

    assert content["meals"] == []
    assert content["warnings"]
    assert content["totals"]["calories"] == 0


# ---------------------------------------------------------------------------
# The model is given what it needs to be health-aware
# ---------------------------------------------------------------------------


def test_prompt_exposes_macros_tags_and_allergens(moody_menus):
    prompt = gemini.build_menu_prompt(moody_menus)

    assert "Vegan" in prompt and "Vegetarian" in prompt
    assert "contains:" in prompt
    for token in ("cal ", "P ", "C ", "F ", "fiber ", "sod "):
        assert token in prompt
    for menu in moody_menus:
        assert menu["period_id"] in prompt
        assert menu["period_name"] in prompt


def test_prompt_lists_selectable_item_ids(moody_menus):
    prompt = gemini.build_menu_prompt(moody_menus)
    catalog = gemini.build_catalog(moody_menus)

    missing = [i for i in catalog if f"[{i}]" not in prompt]
    assert not missing, f"{len(missing)} items are unreachable by the model"


def test_request_prompt_carries_targets_and_constraints(moody_menus):
    prompt = gemini.build_request_prompt(
        moody_menus,
        {"calories": 2200, "protein_g": 140},
        constraints="no peanuts, high protein",
        dietary_notes="vegetarian",
        date=DATE_A,
        location_name="Moody Towers Dining Commons",
    )

    assert DATE_A in prompt
    assert "Moody Towers Dining Commons" in prompt
    assert "calories: 2200" in prompt
    assert "protein_g: 140" in prompt
    assert "no peanuts, high protein" in prompt
    assert "vegetarian" in prompt


def test_request_prompt_is_explicit_when_targets_are_absent(moody_menus):
    prompt = gemini.build_request_prompt(
        moody_menus, {}, None, None, DATE_A, "Moody"
    )
    assert "no explicit numeric targets" in prompt
    assert "(none on file)" in prompt


def test_oversized_periods_are_truncated_by_nutrition_value(moody_menus):
    """Truncation must keep the high-protein items, not an arbitrary slice."""
    lunch = next(m for m in moody_menus if m["period_name"] == "Lunch")
    prompt = gemini.build_menu_prompt([lunch], max_items_per_period=5)

    kept = [i for i in lunch["items"] if f"[{i['id']}]" in prompt]
    assert len(kept) == 5

    best = sorted(lunch["items"], key=lambda i: -(i["protein_g"] or 0))[:5]
    assert {i["id"] for i in kept} == {i["id"] for i in best}
