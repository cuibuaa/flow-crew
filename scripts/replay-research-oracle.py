"""Read-only local oracle audit. CI replays the portable fixture without this source tree.

Usage: python3 -B scripts/replay-research-oracle.py --evidence-root "$RSI_EVIDENCE_ROOT"
Never launches an evaluator, provider, daemon or model. Writes no files.
"""
import argparse
import copy
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--evidence-root", required=True, type=Path)
parser.add_argument("--allow-missing-projections", action="store_true",
                    help="explicitly replay preserved fixture fields if a historical source has disappeared")
args = parser.parse_args()
root = args.evidence_root
sys.path.insert(0, str(root / "loop"))
from rsi_loop.metrics import decide  # noqa: E402

read = lambda path: json.loads(path.read_text())
fixture = read(Path(__file__).resolve().parents[1] / "spec/fixtures/research-rsi-parity.json")
noise = read(root / "fast-cal-1-analysis/noise-stable12-v2.json")
guards = root / "review-guard-1109"
template = read(guards / "frozen-decide-input-1109e.json")


def projection(summary):
    summary_fields = ("set", "tasks", "complete", "expected_cells", "published_cells",
                      "evaluator_sha256", "review_guard_program_sha256")
    engine_fields = ("commit", "host_wall_seconds", "output_tokens", "hidden_passes", "cells",
                     "expected_cells", "hidden_results_available", "terminal_statuses",
                     "token_unknown_attempts", "review_guard")
    guard_fields = ("complete", "program_sha256", "evaluator_sha256", "case_set_sha256",
                    "status", "error", "reject_count", "engine", "cases")
    result = {key: summary[key] for key in summary_fields if key in summary}
    result["engines"] = {arm: {key: value[key] for key in engine_fields if key in value}
                         for arm, value in summary.get("engines", {}).items()}
    for engine in result["engines"].values():
        if not isinstance(engine.get("review_guard"), dict):
            continue
        guard = {key: engine["review_guard"][key] for key in guard_fields if key in engine["review_guard"]}
        engine["review_guard"] = guard
        if "engine" in guard:
            guard["engine"] = {"commit": guard["engine"]["commit"]}
        if "cases" in guard:
            guard["cases"] = [{key: case[key] for key in ("id", "task", "pass", "review_stage", "sessions") if key in case}
                              for case in guard["cases"]]
            for case in guard["cases"]:
                if "sessions" in case:
                    case["sessions"] = [{**{key: session[key] for key in ("stage", "model", "reasoning_effort")},
                                         "source": f"recorded-session-{index}"}
                                        for index, session in enumerate(case["sessions"])]
    return result


missing = set()


def guard_receipt(name, comparison, arm):
    path = guards / name / "summary.json"
    if path.exists():
        return read(path)
    if not args.allow_missing_projections:
        raise FileNotFoundError(path)
    # No invented replacement: consume exactly the pre-existing portable fields.
    # The independent original comparison still corroborates these identities.
    preserved = comparison["summary"]["engines"][arm]["review_guard"]
    inventory = next(item for item in fixture["inventory"] if item["source"] == str(path.relative_to(root)))
    assert all(preserved[field] == inventory[field] for field in ("program_sha256", "evaluator_sha256", "reject_count"))
    if name in ("baseline-main", "weak-fix-v3"):
        original = read(guards / "baseline-comparison.json")["fingerprints"]
        key = "main" if name == "baseline-main" else "round2_weak"
        assert all(preserved[field] == value for field, value in original[key].items())
    elif name == "main-fix-v2":
        original = read(guards / "round2-sensitivity-verdict.json")["fingerprints"]["main"]
        assert all(preserved[field] == value for field, value in original.items())
    missing.add(str(path.relative_to(root)))
    return copy.deepcopy(preserved)


for comparison in fixture["comparisons"]:
    name = comparison["id"]
    if name in ("eval-2461-1109", "eval-2460-1109", "fast-cal-1"):
        summary = read(root / name / "summary.json")
        cells = [json.loads(line) for line in (root / name / "cells.jsonl").read_text().splitlines() if line.strip()]
        if name == "fast-cal-1":
            summary["engines"]["cand"] = summary["engines"].pop("main2")
            for cell in cells:
                if cell["arm"] == "main2":
                    cell["arm"] = "cand"
        projected_cells = [{key: (cell.get("own_outcome") or {}).get("status") if key == "terminal" else cell.get(key)
                            for key in ("task", "arm", "host_wall_seconds", "output_tokens", "resolved", "terminal")} for cell in cells]
        assert projected_cells == comparison["cells"], name + ": cells differ"
        selected_noise = noise
    elif "--" in name:
        baseline, candidate = name.split("--")
        document = copy.deepcopy(template)
        summary, selected_noise = document["summary"], document["noise"]
        # Explicit counterfactual cost/noise template. Original guard fingerprints
        # are never relabeled; a cross-instrument comparison must still refuse.
        left = guard_receipt(baseline, comparison, "main")
        right = guard_receipt(candidate, comparison, "cand")
        summary["evaluator_sha256"] = selected_noise["evaluator_sha256"] = left["evaluator_sha256"]
        for arm, receipt in (("main", left), ("cand", right)):
            summary["engines"][arm]["commit"] = receipt["engine"]["commit"]
            summary["engines"][arm]["review_guard"] = receipt
    else:
        document = read(guards / (name + ".json"))
        summary, selected_noise = document["summary"], document["noise"]
    if name in ("sensitivity-input", "frozen-decide-input-1109e"):
        originals = ("main-v2", "weak") if name == "sensitivity-input" else ("frozen-main-1109e", "frozen-weak-1109e")
        for arm, source in zip(("main", "cand"), originals):
            path = guards / source / "summary.json"
            if not path.exists():
                if not args.allow_missing_projections:
                    raise FileNotFoundError(path)
                missing.add(str(path.relative_to(root)))
                continue  # The recorded sensitivity input itself remains authoritative.
            measured = projection({"engines": {arm: {"review_guard": read(path)}}})
            assert measured["engines"][arm]["review_guard"] == projection(summary)["engines"][arm]["review_guard"], name + ": guard source differs"
    actual = decide(summary, selected_noise)
    assert {key: actual[key] for key in ("keep", "reason")} == {key: comparison["expected"][key] for key in ("keep", "reason")}, name
    assert projection(summary) == comparison["summary"], name + ": summary projection differs"
    assert {key: selected_noise[key] for key in ("set", "tasks", "evaluator_sha256", "source_arms", "metrics")} == comparison["noise"]
    print(f"{name}: keep={actual['keep']} reason={actual['reason']}")
# Inventory every top-level guard round plus the two ordinary single-arm records.
observed = {str(path.relative_to(root)) for path in guards.glob("*/summary.json")}
observed |= {str(guards.relative_to(root) / path) for path in (
    Path("ownership/fresh-eval/summary.json"), Path("fix-ownership/fresh-eval/summary.json"))}
expected_sources = {item["source"] for item in fixture["inventory"]}
assert not observed - expected_sources, "new guard round requires explicit fixture inventory"
for item in fixture["inventory"]:
    path = root / item["source"]
    if not path.exists():
        if not args.allow_missing_projections:
            raise FileNotFoundError(path)
        missing.add(item["source"])
    if item["source"] in missing:
        continue
    summary = read(path)
    for field in ("complete", "program_sha256", "evaluator_sha256", "reject_count"):
        if field in item:
            assert item[field] == summary.get(field), item["source"] + ": " + field
if missing:
    print("Original source unavailable; preserved projection replay only: " + ", ".join(sorted(missing)))
print(f"{len(fixture['comparisons'])} oracle decisions match; {len(missing)} missing original source(s); no evaluation launched")
