"""Gemini generation and tool-based refinement, with the model mocked.

The network call is stubbed, but everything around it is real: prompt
construction, JSON/tool-call parsing, item validation against the menu,
macro recomputation, and revision bookkeeping.
"""

import json

import pytest

from .conftest import DATE_A, MOODY
from .test_meal_plan import assert_plan_is_coherent, plan_items
from .test_api import GENERATE, catalog_for


# ---------------------------------------------------------------------------
# Fake model plumbing
# ---------------------------------------------------------------------------


class _FunctionCall:
    def __init__(self, name, args):
        self.name = name
        self.args = args


class _Part:
    def __init__(self, function_call=None):
        self.function_call = function_call


class _Response:
    def __init__(self, text=None, function_call=None):
        self.text = text
        part = _Part(function_call)
        content = type("C", (), {"parts": [part]})()
        self.candidates = [type("Cand", (), {"content": content})()]


class FakeGemini:
    """Scriptable stand-in for the Gemini client."""

    def __init__(self):
        self.reply = None          # _Response, or an Exception to raise
        self.prompts: list[str] = []
        self.configs: list[object] = []

    def script_json(self, payload: dict | str):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        self.reply = _Response(text=text)

    def script_tool_call(self, name: str, args: dict):
        self.reply = _Response(function_call=_FunctionCall(name, args))

    # -- client surface --
    async def generate_content(self, **kwargs):
        self.prompts.append(kwargs.get("contents") or "")
        self.configs.append(kwargs.get("config"))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    @property
    def aio(self):
        models = type("M", (), {"generate_content": staticmethod(self.generate_content)})()
        return type("A", (), {"models": models})()


@pytest.fixture
def fake_gemini(app_env, monkeypatch) -> FakeGemini:
    """Make the app believe Gemini is configured, and script its replies."""
    from app.services import gemini as gemini_module

    fake = FakeGemini()
    settings = type(
        "S",
        (),
        {
            "gemini_model": "gemini-2.5-flash",
            "gemini_enabled": True,
            "gemini_api_key": "fake",
        },
    )()
    monkeypatch.setattr(gemini_module, "_client", lambda: (fake, settings))
    return fake


async def make_plan(api, headers, fake_gemini, catalog, per_period=2):
    """Generate a plan by scripting the model to pick real items."""
    periods = (
        await api.get(f"/dining/locations/{MOODY}/periods", params={"date": DATE_A})
    ).json()["periods"]

    by_period = {}
    for period in periods:
        menu = (
            await api.get(
                f"/dining/locations/{MOODY}/menu",
                params={"date": DATE_A, "period": period["id"]},
            )
        ).json()
        picks = [i for i in menu["items"] if (i["calories"] or 0) > 100][:per_period]
        by_period[period["id"]] = picks

    fake_gemini.script_json({
        "title": "Scripted day",
        "summary": "A scripted plan.",
        "meals": [
            {
                "period_id": pid,
                "notes": "n",
                "items": [
                    {"item_id": i["id"], "servings": 1, "reason": "protein"}
                    for i in picks
                ],
            }
            for pid, picks in by_period.items()
        ],
        "constraint_notes": ["high protein"],
        "warnings": [],
    })

    resp = await api.post("/plans/generate", headers=headers, json=GENERATE)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


async def test_generation_uses_gemini_and_validates_its_picks(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    assert plan["model"] == "gemini-2.5-flash"
    assert plan["title"] == "Scripted day"
    assert plan["content"]["constraint_notes"] == ["high protein"]
    assert_plan_is_coherent(plan["content"], catalog)


async def test_generation_prompt_carries_menu_targets_and_constraints(
    api, auth, fake_gemini
):
    headers, _ = auth
    catalog = await catalog_for(api)
    await make_plan(api, headers, fake_gemini, catalog)

    prompt = fake_gemini.prompts[0]
    assert "no peanuts" in prompt
    assert "calories: 2200" in prompt
    assert "protein_g: 140" in prompt
    assert DATE_A in prompt
    assert "Moody Towers Dining Commons" in prompt
    # Every period of the day is offered to the model.
    assert prompt.count("### PERIOD") == 4


async def test_generation_requests_structured_json(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    await make_plan(api, headers, fake_gemini, catalog)

    config = fake_gemini.configs[0]
    assert config.response_mime_type == "application/json"
    assert config.response_schema is not None
    assert "nutritionist" in config.system_instruction


async def test_fenced_json_is_parsed(api, auth, fake_gemini):
    headers, _ = auth
    menu = (
        await api.get(
            f"/dining/locations/{MOODY}/menu",
            params={
                "date": DATE_A,
                "period": (
                    await api.get(
                        f"/dining/locations/{MOODY}/periods", params={"date": DATE_A}
                    )
                ).json()["periods"][0]["id"],
            },
        )
    ).json()
    item = menu["items"][0]

    payload = {
        "title": "Fenced",
        "summary": "s",
        "meals": [
            {"period_id": menu["period_id"],
             "items": [{"item_id": item["id"], "servings": 1}]}
        ],
    }
    fake_gemini.script_json("```json\n" + json.dumps(payload) + "\n```")

    resp = await api.post("/plans/generate", headers=headers, json=GENERATE)
    assert resp.status_code == 201
    assert resp.json()["title"] == "Fenced"


async def test_unparseable_model_output_is_a_502(api, auth, fake_gemini):
    headers, _ = auth
    fake_gemini.script_json("not json at all")

    resp = await api.post("/plans/generate", headers=headers, json=GENERATE)
    assert resp.status_code == 502


async def test_model_failure_is_a_502(api, auth, fake_gemini):
    headers, _ = auth
    fake_gemini.reply = RuntimeError("quota exhausted")

    resp = await api.post("/plans/generate", headers=headers, json=GENERATE)
    assert resp.status_code == 502
    assert "quota exhausted" in resp.json()["detail"]


async def test_model_inventing_items_cannot_poison_the_plan(api, auth, fake_gemini):
    headers, _ = auth
    periods = (
        await api.get(f"/dining/locations/{MOODY}/periods", params={"date": DATE_A})
    ).json()["periods"]
    fake_gemini.script_json({
        "title": "Ghost food",
        "summary": "s",
        "meals": [{
            "period_id": periods[0]["id"],
            "items": [
                {"item_id": "ghost-1", "servings": 1, "reason": "imaginary"},
                {"item_id": "ghost-2", "servings": 2, "reason": "also imaginary"},
            ],
        }],
    })

    plan = (
        await api.post("/plans/generate", headers=headers, json=GENERATE)
    ).json()

    assert plan_items(plan["content"]) == []
    assert len(plan["content"]["warnings"]) == 2
    assert plan["content"]["totals"]["calories"] == 0


# ---------------------------------------------------------------------------
# Refinement via tool calls
# ---------------------------------------------------------------------------


async def test_refine_offers_both_tools_and_forces_a_call(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    target = plan_items(plan["content"])[0]
    fake_gemini.script_tool_call("adjust_meal_items", {
        "rationale": "Removed it.",
        "changes": [{
            "action": "remove",
            "period_id": plan["content"]["meals"][0]["period_id"],
            "item_id": target["item_id"],
        }],
    })
    await api.post(
        f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "drop it"}
    )

    config = fake_gemini.configs[-1]
    declared = {f.name for t in config.tools for f in t.function_declarations}
    assert declared == {"rewrite_meal_plan", "adjust_meal_items"}
    assert config.tool_config.function_calling_config.mode.name == "ANY"


async def test_refine_prompt_includes_the_current_plan_and_instruction(
    api, auth, fake_gemini
):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)
    target = plan_items(plan["content"])[0]

    fake_gemini.script_tool_call("adjust_meal_items", {
        "rationale": "ok",
        "changes": [{"action": "remove",
                     "period_id": plan["content"]["meals"][0]["period_id"],
                     "item_id": target["item_id"]}],
    })
    await api.post(
        f"/plans/{plan['id']}/refine",
        headers=headers,
        json={"instruction": "less sodium please"},
    )

    prompt = fake_gemini.prompts[-1]
    assert "less sodium please" in prompt
    assert target["item_id"] in prompt
    assert "CURRENT PLAN" in prompt


async def test_adjust_tool_removes_an_item_and_recomputes_macros(
    api, auth, fake_gemini
):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    before = plan["content"]["totals"]["calories"]
    victim = plan_items(plan["content"])[0]
    fake_gemini.script_tool_call("adjust_meal_items", {
        "rationale": "Dropped one item.",
        "changes": [{
            "action": "remove",
            "period_id": plan["content"]["meals"][0]["period_id"],
            "item_id": victim["item_id"],
        }],
    })

    refined = (
        await api.post(
            f"/plans/{plan['id']}/refine",
            headers=headers,
            json={"instruction": f"remove the {victim['name']}"},
        )
    ).json()

    ids = {i["item_id"] for i in plan_items(refined["content"])}
    assert victim["item_id"] not in ids
    assert refined["content"]["totals"]["calories"] == pytest.approx(
        before - victim["calories"] * victim["servings"], abs=0.15
    )
    assert_plan_is_coherent(refined["content"], catalog)
    assert refined["revision_count"] == 1
    assert refined["revisions"][-1]["tool_used"] == "adjust_meal_items"
    assert refined["revisions"][-1]["rationale"] == "Dropped one item."


async def test_adjust_tool_can_replace_and_reportion(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    meal = plan["content"]["meals"][0]
    old = meal["items"][0]
    used = {i["item_id"] for i in plan_items(plan["content"])}
    replacement = next(
        i for i in catalog.values() if i["id"] not in used and (i["calories"] or 0) > 100
    )

    fake_gemini.script_tool_call("adjust_meal_items", {
        "rationale": "Swapped and doubled.",
        "changes": [
            {"action": "replace", "period_id": meal["period_id"],
             "item_id": old["item_id"], "new_item_id": replacement["id"],
             "servings": 2, "reason": "more protein"},
        ],
    })

    refined = (
        await api.post(
            f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "swap"}
        )
    ).json()

    swapped = next(
        i for i in plan_items(refined["content"]) if i["item_id"] == replacement["id"]
    )
    assert swapped["servings"] == 2
    assert swapped["name"] == replacement["name"]
    assert old["item_id"] not in {i["item_id"] for i in plan_items(refined["content"])}
    assert_plan_is_coherent(refined["content"], catalog)


async def test_adjust_tool_can_add_an_item(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    used = {i["item_id"] for i in plan_items(plan["content"])}
    extra = next(i for i in catalog.values() if i["id"] not in used)
    count = len(plan_items(plan["content"]))

    fake_gemini.script_tool_call("adjust_meal_items", {
        "rationale": "Added fiber.",
        "changes": [{
            "action": "add",
            "period_id": plan["content"]["meals"][0]["period_id"],
            "item_id": extra["id"], "servings": 1, "reason": "fiber",
        }],
    })

    refined = (
        await api.post(
            f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "add fiber"}
        )
    ).json()

    assert len(plan_items(refined["content"])) == count + 1
    assert extra["id"] in {i["item_id"] for i in plan_items(refined["content"])}


async def test_rewrite_tool_replaces_the_whole_plan(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    vegan = [i for i in catalog.values() if "Vegan" in i["tags"]][:3]
    fake_gemini.script_tool_call("rewrite_meal_plan", {
        "title": "Vegan reset",
        "summary": "Rebuilt as a vegan day.",
        "meals": [{
            "period_id": plan["content"]["meals"][0]["period_id"],
            "notes": "all vegan",
            "items": [
                {"item_id": i["id"], "servings": 1, "reason": "vegan"} for i in vegan
            ],
        }],
        "constraint_notes": ["vegan"],
        "warnings": [],
    })

    refined = (
        await api.post(
            f"/plans/{plan['id']}/refine",
            headers=headers,
            json={"instruction": "make the whole day vegan"},
        )
    ).json()

    assert refined["title"] == "Vegan reset"
    assert len(refined["content"]["meals"]) == 1
    assert all("Vegan" in i["tags"] for i in plan_items(refined["content"]))
    assert refined["revisions"][-1]["tool_used"] == "rewrite_meal_plan"
    assert_plan_is_coherent(refined["content"], catalog)


async def test_refinements_accumulate_a_revision_history(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)
    period_id = plan["content"]["meals"][0]["period_id"]

    for n, item in enumerate(plan["content"]["meals"][0]["items"][:2]):
        fake_gemini.script_tool_call("adjust_meal_items", {
            "rationale": f"change {n}",
            "changes": [{"action": "remove", "period_id": period_id,
                         "item_id": item["item_id"]}],
        })
        refined = (
            await api.post(
                f"/plans/{plan['id']}/refine",
                headers=headers,
                json={"instruction": f"instruction {n}"},
            )
        ).json()

    assert refined["revision_count"] == 2
    numbers = [r["revision_number"] for r in refined["revisions"]]
    assert numbers == [0, 1, 2]
    assert [r["tool_used"] for r in refined["revisions"]] == [
        "initial", "adjust_meal_items", "adjust_meal_items",
    ]
    assert refined["revisions"][1]["instruction"] == "instruction 0"


async def test_unknown_tool_leaves_the_plan_untouched(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    fake_gemini.script_tool_call("delete_everything", {})
    resp = await api.post(
        f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "hmm"}
    )
    assert resp.status_code == 502

    after = (await api.get(f"/plans/{plan['id']}", headers=headers)).json()
    assert after["content"] == plan["content"]
    assert after["revision_count"] == 0
    assert len(after["revisions"]) == 1


async def test_no_tool_call_is_an_error(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    fake_gemini.reply = _Response(text="I would rather chat.")
    resp = await api.post(
        f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "hi"}
    )

    assert resp.status_code == 502
    assert "no tool call" in resp.json()["detail"].lower()


async def test_refinement_requires_gemini(api, auth):
    """Without a key, refinement is unavailable rather than silently greedy."""
    headers, _ = auth
    plan = (
        await api.post("/plans/generate", headers=headers, json=GENERATE)
    ).json()

    resp = await api.post(
        f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": "more fiber"}
    )
    assert resp.status_code == 503


async def test_empty_instruction_is_rejected(api, auth, fake_gemini):
    headers, _ = auth
    catalog = await catalog_for(api)
    plan = await make_plan(api, headers, fake_gemini, catalog)

    resp = await api.post(
        f"/plans/{plan['id']}/refine", headers=headers, json={"instruction": ""}
    )
    assert resp.status_code == 422
