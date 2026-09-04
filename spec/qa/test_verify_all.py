"""Independent, reproducible checks for the ux/performance verification evidence."""

from __future__ import annotations

import base64
from collections import Counter
import gzip
import hashlib
import json
import math
import statistics
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
RUN = Path("/home/qian/.fc/runs/2026-09-03T03-24-35-411585")
REPORT = PROJECT / "docs/ux_perf_batch/verification_evidence.json"
BASELINE = "e57684c234dcd904eb1b390c681892cd696ba952"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assert_distribution(row: dict) -> None:
    samples = row["samples"]
    assert samples and all(math.isfinite(value) for value in samples)
    expected_median = statistics.median(samples)
    assert math.isclose(row["mean"], statistics.fmean(samples), rel_tol=1e-9)
    assert math.isclose(row["median"], expected_median, rel_tol=1e-9)
    assert row["reportedStatistic"] == "median"
    assert math.isclose(row["reportedValue"], expected_median, rel_tol=1e-9)
    tolerance = max(abs(expected_median) * 1e-6, 1e-12)
    below = sum(value < expected_median - tolerance for value in samples)
    equal = sum(abs(value - expected_median) <= tolerance for value in samples)
    assert row["reportedRank"] == below
    assert math.isclose(row["percentile"], 100 * (below + equal / 2) / len(samples), rel_tol=1e-9)


def vitest_outcomes(path: Path) -> dict[str, Counter[str]]:
    outcomes: dict[str, Counter[str]] = {
        "passed": Counter(), "failed": Counter(), "skipped": Counter(),
    }
    for file_result in load(path)["testResults"]:
        source = Path(file_result["name"])
        try:
            source_name = source.relative_to(PROJECT).as_posix()
        except ValueError:
            # Item 17's immutable baseline lives in an OS-temporary checkout.
            # Normalize both physical checkouts to the test identity Vitest
            # reports inside the project, without trusting the measurement
            # driver's already-normalized identity arrays.
            absolute_name = source.as_posix()
            marker = "/spec/"
            source_name = (
                f"spec/{absolute_name.split(marker, 1)[1]}"
                if marker in absolute_name
                else absolute_name
            )
        for assertion in file_result["assertionResults"]:
            status = assertion["status"]
            outcome = status if status in {"passed", "failed"} else "skipped"
            outcomes[outcome][f'{source_name} > {assertion["fullName"]}'] += 1
    return outcomes


def multiset_token(values: Counter[str]) -> list[str]:
    """Return the report's compact, independently reproducible identity token."""
    if not values:
        return []
    identities = sorted(values.elements())
    framed = "\n".join(
        f"{len(identity.encode('utf-8'))}:{identity}" for identity in identities
    )
    return [f"sha256-multiset:{digest(framed.encode('utf-8'))};count={values.total()}"]


def test_frozen_protocol_identity() -> None:
    protocol = load(RUN / "measurement_protocol.json")
    assert protocol["baselineCommit"] == BASELINE
    assert protocol["protocolFrozenAt"] < protocol["firstOutcomeAt"]
    assert protocol["revisedAfterOutcomes"] is False


def test_report_records_the_frozen_protocol_and_operator_evaluation_rule() -> None:
    report = load(REPORT)
    protocol = report["protocol"]
    assert report["session"]["baselineCommit"] == BASELINE
    assert report["session"]["rootDependenciesReal"] is True
    assert report["session"]["uiDependenciesReal"] is True
    assert protocol["expectedQualifyingMembers"] == {
        "item11": 28, "item15": 54, "item17": 5,
    }
    assert protocol["feasibilityFloor"] == {
        "item11": 20, "item15": 42, "item17": 4,
    }
    clarification = protocol["operatorEvaluationClarification"]
    assert clarification["guidanceId"] == "5c900f6ce2732adceb0d"
    assert clarification["thresholdChanged"] is False
    assert clarification["pairedOrderChanged"] is False
    assert clarification["outlierPolicyChanged"] is False


def test_every_byte_anchor_still_matches_source() -> None:
    anchors = load(RUN / "evidence_anchors.json")["anchors"]
    assert len(anchors) == 54
    assert {row["item"] for row in anchors} == set(range(1, 19))
    for row in anchors:
        source = Path(row["file"]).read_bytes()
        selected = source[row["byteStart"] : row["byteEnd"]]
        assert len(selected) == row["byteLength"], row["id"]
        assert digest(selected) == row["sha256"], row["id"]


def test_embedded_exact_replay_inputs_match_authorized_anchor_bytes() -> None:
    anchors = {row["id"]: row for row in load(RUN / "evidence_anchors.json")["anchors"]}
    catalog = load(PROJECT / "spec/fixtures/ux-perf-recorded-evidence.json")
    assert catalog["version"] == 1 and catalog["encoding"] == "gzip+base64"
    required = {
        "item1_attempt1_stale_output",
        "item1_engine_placeholder_shape",
        "item1_later_correct_metric",
        "item2_mismatched_request",
        "item2_accepted_request",
        "item2_accepted_decision",
        "item3_exact_before_after_test",
        "item4_first_plan_proposal",
        "item5_terminal_candidate",
        "item5_unit_exit",
        "item5_nonterminal_state_before_crash",
        "item5_first_indefinite_defer",
        "item6_copied_dispatch",
    }
    assert set(catalog["records"]) == required
    for anchor_id, row in catalog["records"].items():
        embedded = gzip.decompress(base64.b64decode(row["gzipBase64"], validate=True))
        anchor = anchors[anchor_id]
        source = Path(anchor["file"]).read_bytes()[anchor["byteStart"] : anchor["byteEnd"]]
        assert embedded == source, anchor_id
        assert len(embedded) == row["byteLength"] == anchor["byteLength"]
        assert digest(embedded) == row["sha256"] == anchor["sha256"]


def test_report_has_one_settled_row_per_item() -> None:
    report = load(REPORT)
    assert report["version"] == 1 and report["baselineCommit"] == BASELINE
    rows = report["dispositions"]
    assert [row["item"] for row in rows] == list(range(1, 19))
    declined = [row for row in rows if row["status"] == "declined"]
    assert [row["item"] for row in declined] == [4]
    assert "never-written" in declined[0]["constraint"] and declined[0]["currentPasses"] is True
    for row in rows:
        if row["status"] == "changed":
            assert row["baseFails"] is True and row["currentPasses"] is True, row["item"]
            assert row["evidence"], row["item"]


def test_exact_replays_cover_items_1_through_6_and_12() -> None:
    replays = load(REPORT)["replays"]
    assert set(replays) == {"1", "2", "3", "4", "5", "6", "12"}
    expected = {str(item) for item in range(1, 7)} | {"12"}
    assert {key for key, row in replays.items() if row["exactRecordedInput"]} == expected
    for key, row in replays.items():
        assert row["currentExitCode"] == 0, key
        assert row["anchors"], key
        if key != "4":
            assert row["baselineExitCode"] != 0, key
        else:
            assert row["historicalProposalRejected"] is True


def test_operator_surfaces_have_before_after_live_and_finished_views() -> None:
    surfaces = load(REPORT)["operatorSurfaces"]
    assert set(surfaces) == {"7", "8", "9", "10"}
    for item, row in surfaces.items():
        assert row["baselineExitCode"] != 0, item
        assert row["currentExitCode"] == 0, item
        assert row["before"] and row["after"], item
    assert surfaces["7"]["live"] and surfaces["7"]["finished"]
    assert surfaces["10"]["live"] and surfaces["10"]["finished"]


def test_all_timing_distributions_recompute() -> None:
    report = load(REPORT)
    for item in ("item11", "item15", "item17"):
        for row in report[item]["distributions"].values():
            assert_distribution(row)


def test_item11_and_item15_direct_independence_counters() -> None:
    report = load(REPORT)
    assert report["item11"]["mountType"] == "9p"
    assert report["item11"]["treeFileCount"] >= 1_000
    assert report["item11"]["qualifyingMembers"] >= 20
    for row in report["item11"]["currentInstrumentation"]:
        assert row["outsideFilesRead"] == row["outsideFilesHashed"] == 0
    assert report["item15"]["qualifyingMembers"] >= 42
    for row in report["item15"]["currentInstrumentation"]:
        assert row["registryBytesParsed"] == row["unchangedAppends"] == 0
    assert len({row["runFilesOpened"] for row in report["item15"]["currentInstrumentation"]}) == 1


def test_item17_clears_hard_speed_for_preserved_baseline_identities() -> None:
    item = load(REPORT)["item17"]
    guided = load(RUN / "stages/verify_all/item17_round4.json")["item17"]
    comparison = item["comparisonPopulation"]
    full_suite = item["fullSuite"]
    observations = guided["evidence"]["observations"]
    baseline_rows = [row for row in observations if row["implementation"] == "B"]
    current_rows = [row for row in observations if row["implementation"] == "C"]
    full_rows = guided["evidence"]["fullSuite"]
    assert [(row["pair"], row["implementation"]) for row in observations] == [
        (1, "B"), (1, "C"), (2, "C"), (2, "B"), (3, "B"),
        (3, "C"), (4, "C"), (4, "B"), (5, "B"), (5, "C"),
    ]

    baseline_trials = [vitest_outcomes(Path(row["jsonPath"])) for row in baseline_rows]
    current_trials = [vitest_outcomes(Path(row["jsonPath"])) for row in current_rows]
    full_trials = [vitest_outcomes(Path(row["jsonPath"])) for row in full_rows]
    baseline = baseline_trials[0]
    current_subset = current_trials[0]
    current_full = full_trials[0]
    assert all(trial == baseline for trial in baseline_trials)
    assert all(trial == current_subset for trial in current_trials)
    assert all(trial == current_full for trial in full_trials)
    assert baseline == current_subset
    assert all(baseline[outcome] <= current_full[outcome] for outcome in baseline)
    assert not baseline["passed"] & (current_full["failed"] | current_full["skipped"])
    assert not baseline["failed"] & (current_full["passed"] | current_full["skipped"])
    assert not baseline["skipped"] & (current_full["passed"] | current_full["failed"])
    assert sum((current_full[outcome] - baseline[outcome]).total() for outcome in baseline) == 66
    for outcome in ("passed", "failed", "skipped"):
        assert item["baselineOutcomes"][outcome] == multiset_token(baseline[outcome])
        assert item["currentOutcomes"][outcome] == multiset_token(current_subset[outcome])

    assert comparison["name"] == "baseline-identities"
    assert comparison["baselineOutcomes"] == {
        "passed": 1986,
        "failed": 0,
        "skipped": 4,
    }
    assert comparison["currentOutcomes"] == comparison["baselineOutcomes"]
    assert comparison["baselineOnlyIdentityCount"] == 0
    assert comparison["outcomeChangedIdentityCount"] == 0
    assert comparison["allBaselineIdentitiesRetained"] is True
    assert comparison["allBaselineOutcomesPreserved"] is True

    assert item["qualifyingPairs"] >= 4
    assert item["medianPairedImprovement"] >= 0.35
    assert item["hardThreshold"] == 0.35
    assert item["within_expected_range"] is True
    assert item["method_was_not_adjusted_to_match_expectation"] is True
    assert item["thresholdUnchanged"] is True
    assert item["pairedOrderUnchanged"] is True
    assert item["evaluationGuidanceId"] == "5c900f6ce2732adceb0d"
    assert item["pairedImprovements"] == [
        row["improvement"] for row in guided["pairedImprovements"]
    ]
    assert item["pairedTrials"] == guided["pairedImprovements"]
    distribution_mapping = {
        "baselineWallMs": "baselinePopulationBaselineWallMs",
        "currentWallMs": "baselinePopulationCurrentWallMs",
        "pairedImprovement": "baselinePopulationPairedImprovement",
        "currentFullSuiteWallMs": "currentFullSuiteWallMs",
    }
    for report_name, raw_name in distribution_mapping.items():
        for field in ("samples", "mean", "median", "reportedValue", "reportedRank", "unit"):
            assert item["distributions"][report_name][field] == guided["distributions"][raw_name][field]

    assert full_suite["command"] == "npm run test"
    assert full_suite["exitCode"] == 0
    assert full_suite["outcomes"]["failed"] == 0
    assert full_suite["outcomes"]["passed"] > comparison["currentOutcomes"]["passed"]
    assert full_suite["containsBaselinePopulation"] is True
    assert full_suite["additionalRegressionIdentities"] > 0
    assert full_suite["timingDistribution"] in item["distributions"]
    assert full_suite == guided["fullSuite"]


def test_complete_round4_repair_diff_is_narrow_and_authorized() -> None:
    repair = load(
        RUN
        / "gate_reevaluation/iteration_1/round_3/repair_diff.json"
    )
    assert repair["truncated"] is False
    assert repair["iteration"] == 1 and repair["round"] == 3
    assert len(repair["files"]) == 2
    by_path = {row["path"]: row for row in repair["files"]}
    assert set(by_path) == {
        "dist/.flowcrew-build-manifest.json", "vitest.ux-perf.config.ts",
    }
    config = by_path["vitest.ux-perf.config.ts"]
    assert config["status"] == "added" and config["before"]["exists"] is False
    assert config["after"]["text"] == (PROJECT / config["path"]).read_text()
    assert digest((PROJECT / config["path"]).read_bytes()) == config["after"]["sha256"]
    assert repair["authoritativeWrites"] == [
        {"path": "vitest.ux-perf.config.ts", "stageIds": ["repair_all"]},
    ]
    accepted = [
        row for row in repair["scopeRevisions"]
        if row["requestId"] == "repair-all-focused-replay-config-a4"
    ]
    assert len(accepted) == 1 and accepted[0]["accepted"] is True

    manifest = by_path["dist/.flowcrew-build-manifest.json"]
    before = json.loads(manifest["before"]["text"])
    after = json.loads(manifest["after"]["text"])
    assert {
        key for key in before if before[key] != after[key]
    } == {"builtAt"}


def test_diff_touched_focused_replay_command_is_runnable() -> None:
    scripts = load(PROJECT / "package.json")["scripts"]
    assert scripts["test:ux-perf"] == "vitest run --config vitest.ux-perf.config.ts"
    assert (PROJECT / "vitest.ux-perf.config.ts").is_file()
    assert int((RUN / "stages/verify_all/test_ux_perf_round4.exit").read_text()) == 0
    log = (RUN / "stages/verify_all/test_ux_perf_round4.log").read_text()
    assert "Test Files  5 passed (5)" in log
    assert "Tests  66 passed (66)" in log


def test_final_quality_commands_are_green_with_totals() -> None:
    suites = load(REPORT)["finalSuites"]
    for name in ("build", "test", "lint", "uiBuild"):
        assert suites[name]["exitCode"] == 0, name
        assert suites[name]["log"], name
    assert suites["test"]["filesFailed"] == suites["test"]["testsFailed"] == 0
    assert suites["test"]["filesPassed"] > 0 and suites["test"]["testsPassed"] > 0
    assert suites["lint"]["errors"] == 0
    exits = {
        "build": "build_round4_postwrite.exit",
        "test": "test_round4_postwrite.exit",
        "lint": "lint_round4_postwrite.exit",
        "uiBuild": "ui_build_round4_postwrite.exit",
        "typescriptNoEmit": "tsc_round4_postwrite.exit",
    }
    for name, filename in exits.items():
        recorded = int((RUN / "stages/verify_all" / filename).read_text().strip())
        assert recorded == suites[name]["exitCode"] == 0, name


def test_diff_touched_discovery_boundaries_were_reexecuted() -> None:
    focused = (RUN / "stages/verify_all/test_ux_perf_round4.log").read_text()
    full = (RUN / "stages/verify_all/test_round4_postwrite.log").read_text()
    assert "Tests  66 passed (66)" in focused
    assert "Tests  2052 passed | 4 skipped (2056)" in full


def test_declared_reality_checks_run_after_report_write() -> None:
    result = load(RUN / "stages/verify_all/reality_checks_round4.json")
    assert result["definitionSha256"] == "5955c9d3281683d837feac50664cd118589f7612fd1fe60ac2eba1580aaf0966"
    assert len(result["checks"]) == 3
    assert all(row["exitCode"] == 0 for row in result["checks"])


def test_safety_guarantees_and_protected_inputs_are_accounted_for() -> None:
    report = load(REPORT)
    guarantees = report["guarantees"]
    assert guarantees["mechanical"] and guarantees["wordingBacked"]
    assert all(row["catcher"] for row in guarantees["wordingBacked"])
    protected = report["protectedInputs"]
    assert protected["defaultsUnchanged"] is True
    assert protected["tailwindOperatorPreimageUnchanged"] is True
    assert protected["evidenceSourcesUnchanged"] is True
    assert protected["operatorProjectUnchanged"] is True


def test_repair_ledger_names_the_two_previously_omitted_negotiation_changes() -> None:
    ledger = load(RUN / "test_changes_repair_all.json")
    negotiation = [row for row in ledger["changes"] if row["file"] == "spec/negotiation.test.ts"]
    assert len(negotiation) == 2
    assert all(row["whyObsolete"] and row["replacementCoverage"] for row in negotiation)
