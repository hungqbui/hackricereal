"""Gemini-backed meal-plan generation, refinement, and hydration.

Two guarantees matter here:

1. The model only *selects* items (id + servings + reason). Every macro
   number in a stored plan is recomputed server-side from the real menu
   payload, so the LLM can never invent nutrition data.
2. Refinement runs through function calling. The model must call one of
   two tools - "rewrite_meal_plan" (full rewrite) or "adjust_meal_items"
   (targeted add/remove/swap) - which is the hook for adapting a plan to
   new instructions over time.

If no API key is configured the module falls back to a deterministic
greedy planner so the API stays usable in a demo.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..config import get_settings
from .nutrition import MACRO_FIELDS, empty_totals, sum_macros

SYSTEM_INSTRUCTION = """\
You are a campus dining nutritionist for the University of Houston.

You are given the real menu served at a dining location on a specific
date, broken into meal periods. Build a day's meal plan by SELECTING
items from that menu.

Hard rules:
- Only use item_id values that appear in the provided catalog. Never
  invent an item or an id.
- Every meal period you were given should get a sensible selection
  unless the user's constraints rule it out; explain any period you
  intentionally leave empty in `notes`.
- servings may be fractional (0.5) or greater than 1 to hit macro
  targets, but keep it realistic for a dining hall tray (0.5 to 3).
- Respect dietary constraints strictly. Treat any allergen the user
  names as an absolute exclusion, and prefer items tagged Vegan or
  Vegetarian when the user asks for those diets.
- Optimize toward the stated nutrition targets: get close on calories
  and protein first, then fiber, then keep sodium and saturated fat
  reasonable.
- Favour variety across categories. Do not stack three servings of one
  item when alternatives exist.

In `reason`, say in one short clause why the item earns its place
(for example "34g protein anchors the day"). Put any compromise you had
to make in `warnings`.
"""

REFINE_INSTRUCTION = """\
You are refining an existing campus meal plan based on a new instruction
from the user.

You MUST respond by calling exactly one tool:
- `adjust_meal_items` when the instruction is a targeted tweak (swap one
  item, drop something, change a portion, add more protein).
- `rewrite_meal_plan` when the instruction changes the plan's premise
  (a new diet, a very different calorie target, "start over").

Only reference item_id values from the catalog below. Preserve the parts
of the plan the user did not ask you to change. Explain what you changed
and why in `rationale`.
"""

# The model returns selections only; the server fills in all nutrition.
SELECTION_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING", "description": "Short name for the day's plan."},
        "summary": {
            "type": "STRING",
            "description": "Two or three sentences on the strategy behind the plan.",
        },
        "meals": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "period_id": {"type": "STRING"},
                    "notes": {"type": "STRING"},
                    "items": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "item_id": {"type": "STRING"},
                                "servings": {"type": "NUMBER"},
                                "reason": {"type": "STRING"},
                            },
                            "required": ["item_id", "servings"],
                        },
                    },
                },
                "required": ["period_id", "items"],
            },
        },
        "constraint_notes": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "description": "How each user constraint was honoured.",
        },
        "warnings": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "description": "Targets that could not be met with this menu.",
        },
    },
    "required": ["title", "summary", "meals"],
}

ADJUST_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "rationale": {
            "type": "STRING",
            "description": "What changed and why, in one or two sentences.",
        },
        "changes": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "action": {
                        "type": "STRING",
                        "enum": ["add", "remove", "replace", "set_servings"],
                    },
                    "period_id": {
                        "type": "STRING",
                        "description": "Period the change applies to.",
                    },
                    "item_id": {
                        "type": "STRING",
                        "description": "Existing item to act on (remove/replace/set_servings), or the item to add.",
                    },
                    "new_item_id": {
                        "type": "STRING",
                        "description": "Replacement item id, for action=replace.",
                    },
                    "servings": {"type": "NUMBER"},
                    "reason": {"type": "STRING"},
                },
                "required": ["action", "period_id"],
            },
        },
        "warnings": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["rationale", "changes"],
}


class GeminiUnavailable(RuntimeError):
    """Raised when no API key is configured."""


class GeminiError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Catalog / prompt construction
# --------------------------------------------------------------------------


def build_catalog(menus: list[dict]) -> dict[str, dict]:
    """Map item_id -> item record across every period of the day."""
    catalog: dict[str, dict] = {}
    for menu in menus:
        for item in menu.get("items") or []:
            item_id = item.get("id")
            if item_id:
                catalog[item_id] = item
    return catalog


def _fmt_item(item: dict) -> str:
    def num(field: str, suffix: str = "") -> str:
        value = item.get(field)
        return f"{value:g}{suffix}" if isinstance(value, (int, float)) else "?"

    bits = [
        f"[{item['id']}] {item.get('name')}",
        f"({item.get('category')}"
        + (f", {item['portion']}" if item.get("portion") else "")
        + ")",
        f"cal {num('calories')}",
        f"P {num('protein_g', 'g')}",
        f"C {num('carbs_g', 'g')}",
        f"F {num('fat_g', 'g')}",
        f"fiber {num('fiber_g', 'g')}",
        f"sod {num('sodium_mg', 'mg')}",
    ]
    if item.get("tags"):
        bits.append("tags: " + ",".join(item["tags"]))
    if item.get("allergens"):
        bits.append("contains: " + ",".join(item["allergens"]))
    return " | ".join(bits)


def build_menu_prompt(menus: list[dict], max_items_per_period: int = 250) -> str:
    """Render the day's menus as a compact catalog the model can cite.

    The cap is a guard against a pathological payload, not a routine
    trim: a busy dining-hall lunch runs ~130 items, so a real day is
    never truncated. Anything the model cannot see, it cannot serve.
    """
    blocks: list[str] = []
    for menu in menus:
        header = (
            f"### PERIOD {menu.get('period_name') or '?'} "
            f"(period_id: {menu.get('period_id')})"
        )
        items = [i for i in (menu.get("items") or []) if i.get("id")]
        if not items:
            blocks.append(header + "\n(no items served)")
            continue
        # Keep the highest-information items if a period is unusually large.
        if len(items) > max_items_per_period:
            items = sorted(
                items,
                key=lambda i: (i.get("protein_g") or 0, i.get("calories") or 0),
                reverse=True,
            )[:max_items_per_period]
        lines = [_fmt_item(i) for i in items]
        blocks.append(header + "\n" + "\n".join(lines))
    return "\n\n".join(blocks)


def build_request_prompt(
    menus: list[dict],
    targets: dict,
    constraints: str | None,
    dietary_notes: str | None,
    date: str,
    location_name: str | None,
) -> str:
    target_lines = [
        f"- {k}: {v}" for k, v in (targets or {}).items() if v is not None
    ] or ["- (no explicit numeric targets; aim for a balanced ~2000 kcal day)"]

    parts = [
        f"DATE: {date}",
        f"LOCATION: {location_name or 'campus dining'}",
        "",
        "NUTRITION TARGETS (per day):",
        *target_lines,
        "",
        "STANDING DIETARY PROFILE:",
        dietary_notes or "(none on file)",
        "",
        "REQUEST FROM THE USER:",
        constraints or "(no extra constraints; build a balanced day)",
        "",
        "AVAILABLE MENU:",
        build_menu_prompt(menus),
    ]
    return "\n".join(parts)


# --------------------------------------------------------------------------
# Hydration: turn model selections into a stored plan with real macros
# --------------------------------------------------------------------------


def _target_fit(totals: dict[str, float], targets: dict) -> dict:
    fit: dict[str, dict] = {}
    for field, target in (targets or {}).items():
        if target is None or field not in totals:
            continue
        actual = totals.get(field, 0.0)
        delta = round(actual - float(target), 1)
        pct = round(actual / float(target) * 100, 1) if float(target) else None
        fit[field] = {
            "target": float(target),
            "actual": actual,
            "delta": delta,
            "pct_of_target": pct,
        }
    return fit


def hydrate_plan(
    selection: dict,
    catalog: dict[str, dict],
    menus: list[dict],
    targets: dict,
) -> dict:
    """Resolve selected ids against the real menu and recompute all macros."""
    period_names = {
        m.get("period_id"): m.get("period_name") for m in menus if m.get("period_id")
    }
    warnings = list(selection.get("warnings") or [])
    meals: list[dict] = []
    all_rows: list[dict] = []

    for meal in selection.get("meals") or []:
        rows: list[dict] = []
        for chosen in meal.get("items") or []:
            item_id = chosen.get("item_id")
            item = catalog.get(item_id)
            if item is None:
                warnings.append(
                    f"Dropped unrecognised item id {item_id!r} returned by the model."
                )
                continue
            raw_servings = chosen.get("servings")
            try:
                # Missing means "one serving"; an explicit 0 or negative
                # means the model does not want the item at all.
                servings = 1.0 if raw_servings is None else float(raw_servings)
            except (TypeError, ValueError):
                servings = 1.0
            if servings <= 0:
                warnings.append(
                    f"Dropped {item.get('name')!r}: model requested "
                    f"{raw_servings} servings."
                )
                continue
            servings = max(0.25, min(servings, 4.0))

            rows.append(
                {
                    "item_id": item_id,
                    "name": item.get("name"),
                    "category": item.get("category"),
                    "portion": item.get("portion"),
                    "servings": round(servings, 2),
                    "reason": chosen.get("reason"),
                    "tags": item.get("tags") or [],
                    "allergens": item.get("allergens") or [],
                    **{f: item.get(f) for f in MACRO_FIELDS},
                }
            )

        period_id = meal.get("period_id")
        meals.append(
            {
                "period_id": period_id,
                "period_name": period_names.get(period_id) or meal.get("period_name"),
                "notes": meal.get("notes"),
                "items": rows,
                "totals": sum_macros(rows),
            }
        )
        all_rows.extend(rows)

    totals = sum_macros(all_rows) if all_rows else empty_totals()
    return {
        "title": selection.get("title") or "Meal plan",
        "summary": selection.get("summary"),
        "meals": meals,
        "totals": totals,
        "target_fit": _target_fit(totals, targets),
        "constraint_notes": list(selection.get("constraint_notes") or []),
        "warnings": warnings,
    }


def content_to_selection(content: dict) -> dict:
    """Inverse of hydrate: compact a stored plan back into model-facing form."""
    return {
        "title": content.get("title"),
        "summary": content.get("summary"),
        "meals": [
            {
                "period_id": meal.get("period_id"),
                "notes": meal.get("notes"),
                "items": [
                    {
                        "item_id": it.get("item_id"),
                        "servings": it.get("servings", 1),
                        "reason": it.get("reason"),
                    }
                    for it in (meal.get("items") or [])
                ],
            }
            for meal in (content.get("meals") or [])
        ],
        "constraint_notes": content.get("constraint_notes") or [],
        "warnings": content.get("warnings") or [],
    }


def apply_adjustments(selection: dict, payload: dict) -> dict:
    """Apply an `adjust_meal_items` tool call to a selection in place."""
    updated = json.loads(json.dumps(selection))  # deep copy
    meals_by_period = {m.get("period_id"): m for m in updated.get("meals") or []}

    for change in payload.get("changes") or []:
        action = (change.get("action") or "").lower()
        period_id = change.get("period_id")
        meal = meals_by_period.get(period_id)
        if meal is None:
            meal = {"period_id": period_id, "notes": None, "items": []}
            updated.setdefault("meals", []).append(meal)
            meals_by_period[period_id] = meal

        items = meal.setdefault("items", [])
        item_id = change.get("item_id")

        if action == "add":
            if item_id:
                items.append(
                    {
                        "item_id": item_id,
                        "servings": change.get("servings") or 1,
                        "reason": change.get("reason"),
                    }
                )
        elif action == "remove":
            meal["items"] = [i for i in items if i.get("item_id") != item_id]
        elif action == "set_servings":
            for entry in items:
                if entry.get("item_id") == item_id:
                    entry["servings"] = change.get("servings") or entry.get("servings", 1)
                    if change.get("reason"):
                        entry["reason"] = change["reason"]
        elif action == "replace":
            new_id = change.get("new_item_id")
            if not new_id:
                continue
            replaced = False
            for entry in items:
                if entry.get("item_id") == item_id:
                    entry["item_id"] = new_id
                    entry["servings"] = change.get("servings") or entry.get("servings", 1)
                    entry["reason"] = change.get("reason") or entry.get("reason")
                    replaced = True
            if not replaced:
                items.append(
                    {
                        "item_id": new_id,
                        "servings": change.get("servings") or 1,
                        "reason": change.get("reason"),
                    }
                )

    if payload.get("warnings"):
        updated["warnings"] = list(payload["warnings"])
    return updated


# --------------------------------------------------------------------------
# Gemini calls
# --------------------------------------------------------------------------


def _client():
    settings = get_settings()
    if not settings.gemini_enabled:
        raise GeminiUnavailable("GEMINI_API_KEY is not configured.")
    try:
        from google import genai
    except ImportError as exc:  # pragma: no cover
        raise GeminiUnavailable("google-genai is not installed.") from exc
    return genai.Client(api_key=settings.gemini_api_key), settings


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise GeminiError(f"Model did not return valid JSON: {exc}") from exc


async def generate_selection(
    menus: list[dict],
    targets: dict,
    constraints: str | None,
    dietary_notes: str | None,
    date: str,
    location_name: str | None,
) -> tuple[dict, str]:
    """Ask Gemini for a structured selection. Returns (selection, model)."""
    client, settings = _client()
    from google.genai import types

    prompt = build_request_prompt(
        menus, targets, constraints, dietary_notes, date, location_name
    )
    try:
        resp = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=SELECTION_SCHEMA,
                temperature=0.4,
            ),
        )
    except Exception as exc:  # SDK raises provider-specific errors
        raise GeminiError(f"Gemini generation failed: {exc}") from exc

    return _parse_json(resp.text), settings.gemini_model


async def refine_selection(
    current: dict,
    menus: list[dict],
    instruction: str,
    targets: dict,
    dietary_notes: str | None,
    date: str,
    location_name: str | None,
) -> tuple[dict, str, str, str]:
    """Refine a plan via forced function calling.

    Returns (new_selection, tool_used, rationale, model).
    """
    client, settings = _client()
    from google.genai import types

    tools = [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="rewrite_meal_plan",
                    description=(
                        "Replace the entire meal plan with a new selection. Use when "
                        "the instruction changes the plan's premise."
                    ),
                    parameters=SELECTION_SCHEMA,
                ),
                types.FunctionDeclaration(
                    name="adjust_meal_items",
                    description=(
                        "Apply targeted add/remove/replace/set_servings changes to the "
                        "existing plan. Use for tweaks that preserve the overall plan."
                    ),
                    parameters=ADJUST_SCHEMA,
                ),
            ]
        )
    ]

    prompt = "\n".join(
        [
            f"DATE: {date}",
            f"LOCATION: {location_name or 'campus dining'}",
            "",
            "NUTRITION TARGETS:",
            json.dumps(targets or {}, indent=2),
            "",
            "STANDING DIETARY PROFILE:",
            dietary_notes or "(none on file)",
            "",
            "CURRENT PLAN (item ids and servings):",
            json.dumps(content_to_selection(current), indent=2),
            "",
            "NEW INSTRUCTION FROM THE USER:",
            instruction,
            "",
            "AVAILABLE MENU:",
            build_menu_prompt(menus),
        ]
    )

    try:
        resp = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=REFINE_INSTRUCTION,
                tools=tools,
                tool_config=types.ToolConfig(
                    function_calling_config=types.FunctionCallingConfig(mode="ANY")
                ),
                temperature=0.3,
            ),
        )
    except Exception as exc:
        raise GeminiError(f"Gemini refinement failed: {exc}") from exc

    call = None
    candidates = resp.candidates or []
    if candidates and candidates[0].content and candidates[0].content.parts:
        for part in candidates[0].content.parts:
            if getattr(part, "function_call", None):
                call = part.function_call
                break
    if call is None:
        raise GeminiError("Model returned no tool call during refinement.")

    args = dict(call.args or {})
    if call.name == "rewrite_meal_plan":
        new_selection = args
        rationale = args.get("summary") or "Plan rewritten for the new instruction."
    elif call.name == "adjust_meal_items":
        new_selection = apply_adjustments(content_to_selection(current), args)
        new_selection.setdefault("title", current.get("title") or "Meal plan")
        new_selection["summary"] = args.get("rationale") or current.get("summary")
        rationale = args.get("rationale") or "Plan adjusted."
    else:
        raise GeminiError(f"Model called unknown tool {call.name!r}.")

    return new_selection, call.name, rationale, settings.gemini_model


# --------------------------------------------------------------------------
# Deterministic fallback (no API key configured)
# --------------------------------------------------------------------------

_DEFAULT_SPLIT = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.32, "everyday": 0.08}

# Below this, an item is a condiment/garnish rather than part of a meal.
_MIN_ITEM_CALORIES = 50
_MAX_ITEMS_PER_PERIOD = 6


def _constraint_filter(constraints: str | None, dietary_notes: str | None):
    """Very small keyword matcher used only by the offline fallback."""
    text = " ".join(filter(None, [constraints or "", dietary_notes or ""])).lower()
    want_vegan = "vegan" in text
    want_vegetarian = "vegetarian" in text or want_vegan
    gluten_free = "gluten" in text and ("no gluten" in text or "gluten-free" in text or "avoid" in text)
    excluded = {
        word
        for word in [
            "peanut", "tree nut", "nut", "milk", "dairy", "egg", "soy",
            "fish", "shellfish", "wheat", "sesame", "pork", "beef", "mushroom",
        ]
        if re.search(rf"\b(no|without|avoid|free of|allergic to)\b[^.,;]*\b{word}", text)
    }

    def keep(item: dict) -> bool:
        tags = {t.lower() for t in item.get("tags") or []}
        allergens = {a.lower() for a in item.get("allergens") or []}
        if want_vegan and "vegan" not in tags:
            return False
        if want_vegetarian and not ({"vegan", "vegetarian"} & tags):
            return False
        if gluten_free and "avoiding gluten" not in tags:
            return False
        for term in excluded:
            if any(term in a for a in allergens):
                return False
        return True

    return keep


def fallback_selection(
    menus: list[dict],
    targets: dict,
    constraints: str | None,
    dietary_notes: str | None,
) -> dict:
    """Greedy planner: fill each period toward its calorie share, best protein first."""
    keep = _constraint_filter(constraints, dietary_notes)
    cal_target = float((targets or {}).get("calories") or 2000)
    protein_target = float((targets or {}).get("protein_g") or 0)

    served = [m for m in menus if m.get("items")]
    if not served:
        return {
            "title": "No menu available",
            "summary": "The dining location published no items for this date.",
            "meals": [],
            "constraint_notes": [],
            "warnings": ["No menu items were returned for the requested date."],
        }

    weights = []
    for menu in served:
        slug = (menu.get("period_name") or "").strip().lower()
        weights.append(_DEFAULT_SPLIT.get(slug, 1.0 / len(served)))
    total_weight = sum(weights) or 1.0

    meals, warnings, dropped_all = [], [], True
    for menu, weight in zip(served, weights):
        budget = cal_target * (weight / total_weight)
        pool = [
            i
            for i in menu["items"]
            if i.get("id") and isinstance(i.get("calories"), (int, float)) and keep(i)
        ]
        # Condiments and garnishes wreck a greedy protein-density sort
        # (soy sauce is all protein-per-calorie and all sodium), so keep
        # them out unless the period has nothing substantial.
        substantial = [i for i in pool if (i.get("calories") or 0) >= _MIN_ITEM_CALORIES]
        if substantial:
            pool = substantial
        if not pool:
            meals.append(
                {
                    "period_id": menu.get("period_id"),
                    "notes": "No items matched the dietary constraints.",
                    "items": [],
                }
            )
            continue
        dropped_all = False

        # Iterative greedy: at each step take the item that best closes the
        # remaining calorie and protein gap, discounting repeated
        # categories so a tray does not end up as five sides.
        protein_budget = protein_target * (weight / total_weight) if protein_target else 0.0
        chosen, used_cal, used_protein = [], 0.0, 0.0
        categories: dict[str, int] = {}
        remaining = list(pool)

        while remaining and len(chosen) < _MAX_ITEMS_PER_PERIOD:
            cal_gap = budget - used_cal
            if cal_gap <= budget * 0.10:
                break
            protein_gap = max(protein_budget - used_protein, 0.0)

            best, best_score = None, 0.0
            for item in remaining:
                cal = float(item.get("calories") or 0)
                if cal <= 0 or cal > cal_gap * 1.15:
                    continue
                protein = float(item.get("protein_g") or 0)
                fiber = float(item.get("fiber_g") or 0)
                sodium = float(item.get("sodium_mg") or 0)

                score = min(cal, cal_gap) / max(cal_gap, 1.0)
                if protein_gap > 0:
                    score += 2.0 * (min(protein, protein_gap) / protein_gap)
                score += 0.30 * min(fiber, 10.0) / 10.0
                score -= 0.20 * min(sodium, 1500.0) / 1500.0
                score /= 1.0 + 0.6 * categories.get(item.get("category") or "", 0)

                if score > best_score:
                    best, best_score = item, score

            if best is None:
                break

            remaining.remove(best)
            cal = float(best.get("calories") or 0)
            protein = float(best.get("protein_g") or 0)
            chosen.append(
                {
                    "item_id": best["id"],
                    "servings": 1,
                    "reason": f"{protein:g}g protein for {cal:g} kcal",
                }
            )
            cat = best.get("category") or ""
            categories[cat] = categories.get(cat, 0) + 1
            used_cal += cal
            used_protein += protein

        meals.append(
            {
                "period_id": menu.get("period_id"),
                "notes": f"Targeted ~{budget:.0f} kcal for this period.",
                "items": chosen,
            }
        )

    if dropped_all:
        warnings.append("No menu items satisfied the stated dietary constraints.")
    warnings.append(
        "Generated by the offline fallback planner (GEMINI_API_KEY not configured)."
    )

    notes = []
    if constraints:
        notes.append(f"Applied keyword filtering for: {constraints}")
    if protein_target:
        notes.append(f"Prioritised protein density toward {protein_target:g}g.")

    return {
        "title": "Balanced day (offline planner)",
        "summary": (
            "Greedy selection maximising protein per calorie within each meal "
            "period's calorie budget."
        ),
        "meals": meals,
        "constraint_notes": notes,
        "warnings": warnings,
    }
