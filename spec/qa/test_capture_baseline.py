"""Reproducible QA checks for the ux/performance baseline capture stage."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
RUN = Path("/home/qian/.fc/runs/2026-09-03T03-24-35-411585")
BASELINE_COMMIT = "e57684c234dcd904eb1b390c681892cd696ba952"


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def test_protocol_was_frozen_before_first_outcome() -> None:
    protocol = load_json(RUN / "measurement_protocol.json")
    assert protocol["baselineCommit"] == BASELINE_COMMIT
    assert protocol["protocolFrozenAt"] < protocol["firstOutcomeAt"]
    assert protocol["revisedAfterOutcomes"] is False
    assert protocol["expectedQualifyingMembers"] == {"item11": 28, "item15": 54, "item17": 5}
    assert protocol["feasibilityFloor"] == {"item11": 20, "item15": 42, "item17": 4}


def test_dependency_roots_are_real_and_lock_bound() -> None:
    layout = load_json(RUN / "dependency_layout.json")
    assert (PROJECT / "node_modules").is_dir() and not (PROJECT / "node_modules").is_symlink()
    assert (PROJECT / "ui/node_modules").is_dir() and not (PROJECT / "ui/node_modules").is_symlink()
    assert layout["lifecycleScriptsRun"] is False
    assert sha256_bytes((PROJECT / "package-lock.json").read_bytes()) == layout["protectedHashesStillMatch"]["package-lock.json"]
    assert sha256_bytes((PROJECT / "ui/package-lock.json").read_bytes()) == layout["protectedHashesStillMatch"]["ui/package-lock.json"]


def test_baseline_archive_has_git_identity_and_real_dependencies() -> None:
    archive = load_json(RUN / "baseline_archive.json")
    root = Path(archive["path"])
    head = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == BASELINE_COMMIT
    assert (root / "node_modules").is_dir() and not (root / "node_modules").is_symlink()
    assert (root / "ui/node_modules").is_dir() and not (root / "ui/node_modules").is_symlink()
    assert subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout == ""


def test_valid_baseline_build_test_and_lint_are_green() -> None:
    result = load_json(RUN / "baseline_results.json")["validBaseline"]
    assert result["build"]["exitCode"] == 0
    assert result["test"] == {
        "command": "npm run test",
        "exitCode": 0,
        "filesPassed": 179,
        "filesFailed": 0,
        "testsPassed": 1986,
        "testsFailed": 0,
        "testsSkipped": 4,
        "testsTotal": 1990,
        "log": "baseline_outputs/valid_test.log",
    }
    assert result["lint"]["exitCode"] == 0
    assert result["lint"]["errors"] == 0


def test_invalid_archive_probe_is_not_misreported_as_product_baseline() -> None:
    probe = load_json(RUN / "baseline_results.json")["invalidEnvironmentProbe"]
    assert probe["countedAsBaseline"] is False
    assert probe["testExitCode"] == 1
    assert probe["filesFailed"] == 2 and probe["testsFailed"] == 2
    assert {name.split(" > ", 1)[0] for name in probe["failedTests"]} == {
        "spec/criteria-lint.test.ts",
        "spec/packaging-contract.test.ts",
    }


def test_all_evidence_anchor_bytes_still_match() -> None:
    evidence = load_json(RUN / "evidence_anchors.json")
    assert {row["item"] for row in evidence["anchors"]} == set(range(1, 19))
    assert len(evidence["anchors"]) == 54
    for row in evidence["anchors"]:
        source = Path(row["file"]).read_bytes()
        start, end = row["byteStart"], row["byteEnd"]
        assert 0 <= start < end <= len(source), row["id"]
        assert sha256_bytes(source[start:end]) == row["sha256"], row["id"]


def test_mismatched_scope_request_has_no_historical_decision() -> None:
    evidence = load_json(RUN / "evidence_anchors.json")
    check = next(row for row in evidence["absenceChecks"] if row["id"] == "item2_mismatch_has_no_decision")
    assert check["matchingPaths"] == []
    assert not list(Path(check["directory"]).glob("scope_revision_decision_*.json"))


def test_operator_before_capture_contains_live_and_finished_views() -> None:
    index = load_json(RUN / "operator_before/index.json")
    captures = {row["name"]: row for row in index["captures"]}
    assert index["live"] == {"taskId": 2132, "runId": "2026-09-03T03-24-35-411585"}
    assert index["finished"] == {"taskId": 2130, "runId": "2026-09-02T08-37-37-fdc755"}
    assert captures["task_show_2132"]["exitCode"] == 0
    assert captures["task_show_2130"]["stdoutBytes"] > 100_000
    assert captures["help_events"]["exitCode"] == 1
    assert b"4578 unreadable run entries" in (RUN / "operator_before/watch_once.stdout").read_bytes()


def test_protected_checkout_files_and_deployed_dist_are_untouched() -> None:
    before = load_json(RUN / "protected_hashes_before.json")["targets"]
    assert sha256_bytes((PROJECT / "config/defaults.yaml").read_bytes()) == before["defaults"]["sha256"]
    assert sha256_bytes((PROJECT / "ui/tailwind.config.d.ts").read_bytes()) == before["tailwindDeclaration"]["sha256"]
    result = load_json(RUN / "baseline_results.json")["liveCheckout"]
    assert result["buildRun"] is False
    assert result["deployedDistSha256Before"] == result["deployedDistSha256After"]


def test_selected_item11_fixture_is_a_large_9p_tree() -> None:
    facts = load_json(RUN / "toolchain_machine.json")
    fixture = Path(facts["item11SelectedFixture"]["path"])
    assert facts["item11Mount"]["fstype"] == "9p"
    assert facts["item11RecordedFixture"]["exists"] is False
    assert fixture.is_dir()
    assert facts["item11SelectedFixture"]["eligibleFileCount"] >= 1_000


def test_replay_manifest_has_one_truthful_row_per_item() -> None:
    rows = load_json(RUN / "baseline_replay_manifest.json")["rows"]
    assert [row["item"] for row in rows] == list(range(1, 19))
    assert next(row for row in rows if row["item"] == 4)["plannedDisposition"] == "declined"
    assert "fail-closed" in next(row for row in rows if row["item"] == 4)["constraint"]
    assert all(row["plannedDisposition"] == "changed" for row in rows if row["item"] != 4)


def test_direct_count_observations_match_frozen_sources() -> None:
    observations = load_json(RUN / "baseline_observations.json")["counts"]
    supervise = Path("/home/qian/.fc/supervise/flowcrew-task-2130.service/out.log").read_bytes()
    warning = b"Ignoring stale scope revision request from another attempt"
    assert supervise.count(warning) == observations["item16StaleScopeWarnings"] == 781_538
    assert len(supervise) == observations["item16SuperviseLogBytes"] == 168_301_604
    assert (RUN / "operator_before/task_show_2130.stdout").stat().st_size == observations["item7FinishedTaskShowStdoutBytes"]


def test_only_externally_mutable_registry_changed_after_capture() -> None:
    comparisons = load_json(RUN / "protected_hashes_after.json")["comparisons"]
    assert comparisons["taskRegistry"]["expectedExternalMutation"] is True
    assert comparisons["taskRegistry"]["sha256Matches"] is False
    assert all(
        row["sha256Matches"] is True
        for name, row in comparisons.items()
        if name != "taskRegistry"
    )
