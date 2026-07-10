# Changelog

## [Unreleased]
- No unreleased changes yet.

## [0.4.1] - 2026-07-10

### Changed

- **Bounded run-directory disk growth.** Each codex stage's `codex_home` — transient CLI cruft (~90 MB/stage, dominated by the `.tmp/plugins` git packs, ~99% of a run's on-disk size) — is now purged automatically when the stage **succeeds**, and **kept on failure/abort/timeout** for debugging (dropping only the already-checkpointed SQLite WAL/SHM). Previously it accumulated unboundedly, so `~/.fc/runs` could grow to hundreds of GB; it now stays at result-file scale (~KB per run). Extends the existing WAL-only cleanup — same automatic-cruft-cleanup category, no new config. `flowcrew clean --keep N` remains the manual escape hatch for pruning old run residue.

## [0.4.0] - 2026-07-05

FlowCrew 0.4.0 hardens the autonomous loop so that honesty becomes a property of the engine, not of the operator's diligence. It internalizes *verify-before-trust*, makes honest negatives first-class, adds self-remediation, and is validated across 6 task domains and 2 objective kinds (research `metric` and engineering `acceptance`).

### Highlights

- **Confirm-gate (verify-before-trust).** A brief-declared `research.confirm` command runs as an independent check before any `shipped` terminal; a candidate that beats the metric but fails confirmation is downgraded, not shipped. Generalizes the Reality-Gate mechanism to the ship path.
- **Honest terminal taxonomy.** Added a first-class `incomplete` status (budget-exhausted mid-search — distinct from a crash and from an honest ceiling); unified the terminal-status guard so honest negatives are never mislabeled `failed` or scored at baseline by the outer loop.
- **Anti-smoke integrity floors.** Brief-declared `research.integrity.field_floors` reject token/"smoke" rounds (e.g. `real_train_iters >= 150`) instead of banking them as results.
- **Self-remediation.** Planner failures (empty/invalid `dispatch.yaml`) now bounded-retry with a specific re-prompt instead of a fatal punt (`default_plan_stage_retries`); the supervisor gains a **REJECT** verdict to send an insufficient deliverable back for re-work (`default_supervisor_max_rejects`); a deterministic no-progress stage watchdog aborts stalled stages.
- **Fail-loud on degraded config.** A `workflow=research` run whose frontmatter fails to parse now fails loud (a `research_mode_degraded` event) instead of silently degrading to plain dispatch.
- **Observability precision.** Integrity-rejected round counts surface in the terminal report; run summaries derive their decision label from the true terminal status; a declared confirm-gate that is skipped on a non-ship terminal is recorded rather than silently dropped.
- **Literature scout + portfolio coverage.** The outer loop can expand its portfolio from web search before exploring, with a deterministic coverage floor and domain-ledger awareness to avoid re-proposing dead directions.
- **Regression-guarded.** The hardening above is developed against a task-agnostic engine-contract suite (policy, terminal/verdict, dispatch retry/reject, stall detection, confirm-gate).

## [0.2.0] - 2026-05-28

FlowCrew 0.2.0 is the first release positioned as a full agent workflow control plane rather than a browser-first alpha. It adds a Codex-default execution path, campaign memory, run knowledge graphs, deterministic Reality-Gate checks, supervisor steering, daemon/background task surfaces, and a rebuilt dashboard/documentation experience.

### Highlights

- **Codex-default execution**: project defaults now route agent stages through Codex by default, while still supporting Claude as a per-run or per-role override.
- **Recommended Claude Code -> Codex workflow**: README and skills now present the intended loop: discuss and shape the plan in Claude Code, then `/ship` the confirmed task to FlowCrew for Codex-backed execution.
- **Workspace dashboard redesign**: added workspace/campaign views, run detail pages, campaign KPIs, phase progress, run lists, brief revision panels, and knowledge graph panels.
- **Run Memory Graph**: added dashboard and documentation support for persisted goals, approaches, findings, insights, results, user hints, and dead ends.
- **Campaign intelligence**: added campaign iteration state, brief versioning, diagnosis/review surfaces, cross-campaign knowledge graph support, plateau/regression triggers, and research workflow policy support.
- **Reality-Gate framework**: added deterministic evidence checks that can block unsupported terminal success, plus an audit command for retrospective verification.
- **Supervisor and daemon runtime**: added supervisor escalation, background task registry, daemon/task CLI surfaces, and run summary parsing.
- **Release-facing documentation refresh**: rewrote the README, refreshed screenshots and demo assets, and added focused reference docs for architecture, campaigns, CLI, configuration, Reality-Gate, and skills.

### Changed

- Raised the package version to `0.2.0`.
- Kept generated framework campaign logs local-only via `.gitignore`.
- Removed older dashboard screenshots and replaced them with current workspace, campaign, agent, architecture, and run-memory visuals.

## [0.1.0-alpha]

Public alpha release for early feedback on the browser-first multi-agent workflow experience.

### Added / Improved

- Added campaign iteration visibility in the dashboard.
- Added research-injection and campaign pivot surfaces.
- Improved campaign trigger logic with previous run history.
- Added safe campaign ID persistence.
- Added existing campaign selection when creating new tasks.
- Removed internal `new:` prefixes from campaign names.
- Improved the live monitor with DAG, attempt history, and output panels.
- Persisted task settings across page reloads.
