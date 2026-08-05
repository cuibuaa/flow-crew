# Changelog

## [Unreleased]

### Added — absorbed from openworker (code-level comparison)

- **Approval inbox / park-and-resume.** A run that reaches a consequential action no longer has to choose between doing it autonomously and escalating (killing the run). A stage writes `<run_dir>/approval_request.json`; the engine records it in an append-only `<run_dir>/approvals.jsonl` and either auto-approves it via a standing rule or PARKS the run — new non-terminal `parked` status, process exits, project lock and daemon queue slot freed. `flowcrew inbox list|show|approve|deny|rules|revoke` resolves it and resumes the SAME runId, DAG and iteration. Idempotent on `(runId, requestId)`; **first resolution wins**, so two operators on two surfaces can never produce two decisions (append order is the arbiter — no lock, no read-modify-write). Standing rules ("always allow") are mintable ONLY for an `external`-risk action bound to an exact target; shell/write/untargeted actions ask every time.
- **Daemon queue policies.** Single-in-flight is now enforced at ADMISSION (`src/run-lock.ts`), not only inside a launched run: a busy project defers the task (`deferred` + `not_before` + reason) instead of launching into a conflict that the child would discover and die on. Deferring never consumes the retry budget; retries are queued with 30s-doubling backoff (capped 10 min) instead of relaunching inline; the tick sweep is reentrancy-guarded, drains the launch queue serially and polls running units concurrently; a catch-up sweep runs at daemon start and ADOPTS a queued task whose unit is already live rather than double-launching it.
- **Surgical param-fix retry** (`src/adapters/diagnose.ts`). When a failure's output tail names a fixable parameter — anchored on the attested `400 invalid_request` wire shape, not on guessed markers — the codex adapter retries once with exactly that parameter omitted (a dedicated sentinel, because `default` now *inherits* the global config that may be the source of the bad value), at most two distinct fixes. Timeouts and supervisor aborts are never "fixed". `RunResult.friendlyError` surfaces one actionable sentence instead of a bare exit code.

### Added — operator can now prove what the engine is doing

- **`flowcrew daemon status` / `restart` / `stop` / `logs`.** The orchestrator is `dist/cli.js daemon serve`; `flowcrew start` is the web dashboard. Nothing previously distinguished them, so a restart script matching the wrong name left a stale orchestrator running — for two days, silently, while every fix shipped in that window sat unloaded in `dist/` and a terminal run had its brief replayed against its own committed tree. The daemon now records a SHA-256 build identity at startup; `daemon status` reports the socket-owning pid, startup time, loaded build and registry health, and exits nonzero with `STALE` when `dist/` no longer matches what the process loaded. `daemon restart` resolves the listener from the Unix-socket inode in `/proc` — never from a command-line pattern — and refuses by default when a running task has no `run_id`, because such a task would have its brief replayed.
- **RPC responses carry the daemon pid and build**, so a registration can be attributed to a specific process rather than to "some daemon".
- **Public `spec/` suite and CI.** A clean clone previously failed `npm test` with "No test files found" while the PR template asked contributors to run it. `spec/` now carries the portable suite; CI runs the quality pipeline plus a second job that executes `spec/` in a container with `--network none`, a tmpfs `$HOME` (no `~/.fc`), and assertions that `codex` and `claude` are absent from `PATH` — the mechanical form of "if a test needs anything on your machine, it does not belong in `spec/`".
- **`guide/`** — run lifecycle (all 13 statuses, each marked terminal/successful and who writes it), approvals, rehearse, the brief contract, CLI, contributing.
- **`--campaign-context=inherit|skip`** replaces `--no-inherit-campaign` (kept as an alias). The two campaign flags act on independent dimensions — `--no-campaign` drops *attribution*, `--campaign-context=skip` keeps attribution and drops only *prior-phase context* — and the near-identical old names made that invisible.
- **Dashboard inbox consolidates everything waiting on a human**: approvals, deferred tasks with their reason and retry time, stale runs, and pending brief patches, with a real empty state.

### Fixed

- **A terminal run is no longer retried as a crash.** systemd reports only "the process exited nonzero", which cannot distinguish a crash from an engine verdict (`failed` / `reality_gate_failed` / `escalated` / `incomplete`). The daemon now pre-allocates the run identity before launch and settles a bound terminal run instead of replaying the brief — replaying meant re-running a brief against a tree the first attempt had already modified and committed.
- **Exit 127 with a command-not-found diagnostic is an environment defect, not a failed check.** A reality check that cannot execute provides no evidence that the requirement is unmet; three consecutive successful runs were failed by a check invoking `rg`, which is not installed here. A bare 127 without that diagnostic still fails hard.
- **An RPC timeout no longer claims the daemon is not running.** Connection failure and "written but unanswered" were collapsed into one message, so an operator who had in fact cancelled a task was told it never arrived — and repeated a destructive command.
- **Every dashboard path that starts work now honors project admission control.** `isProjectBusy` appeared zero times in the dashboard: approve, execute, rerun, stage rerun, gate re-evaluation and task creation each spawned a run while checking only that *this* task was idle, never whether the *project* was. All six now return 409 with no launch and no pre-mutation side effects.
- **A registry lock left by a killed writer no longer bricks task registration permanently.** Locks record owner pid, acquisition time and a token; a lock whose owner no longer exists is taken over with a warning, a live owner's lock is never stolen, and release only unlinks its own token. Previously a zero-byte leftover produced a bare `EEXIST` that reached no log — only the abandoned client socket.
- **Run-status semantics are derived from one vocabulary.** 143 status-literal comparisons across 14 files are now zero outside `store.ts`, with an AST gate that fails on any new one and names file:line. Adding `parked` had touched 11 files, missed two, and shipped two defects that executed a high-risk action twice.
- **A clean clone passes `npm test` again.** Four UI suites imported React through a hardcoded `../../ui/node_modules` path — available only after a separate install under `ui/` — so a fresh checkout failed at import time.

- `campaign.ts` read terminality as an inverted denylist, so any newly-added run status was misread as terminal and `pollRunCompletion` would fabricate an outcome from an unfinished run. Both it and `run-summary.ts` (whose hand-copied terminal set had already drifted) now derive from the engine's single source of truth.
- `terminal_states` frontmatter may now only declare a REAL terminal status. A brief could previously declare a non-terminal one and have it written into run.json *with* `completedAt` while every terminal guard reported false — an agent-reachable way to forge a run that no consumer treats as finished or alive.
- The supervisor ABORT poller was torn down after the first stage attempt, but the adapter-error backoff ladder (30s+60s+120s) and the cross-adapter fallback that follow are four more full-length agent runs: a stage in backoff was unkillable for minutes. The signal is now both passed to those attempts and kept live for them, and the backoff sleep checks it instead of sleeping on.
- The catch-all stage retry now preserves the failed attempt's `error`, so `buildRetryPreamble` can state the real cause; without it every non-timeout failure was announced to the agent as "timed out".

### Fixed — honest terminals, all exit doors (engine bugs #1-#7, found by live audit + wind-tunnel)

- **Confirm-fail no longer kills the research program.** A ship candidate that fails the brief's confirm gate is marked `confirmFailed`, excluded from kept/running-best (so the same unconfirmed number cannot re-trigger ship→confirm→fail forever), and the loop continues under the normal stop rules instead of terminating as a premature ceiling.
- **Ceiling floors are enforced on the research loop.** A `terminal_states.ceiling_hit.floor` (research semantics: measured rounds are the attempted stages) defers a premature policy ceiling while round/wall budget remains; forced commits under exhausted hard budgets are annotated honestly.
- **Engine-initiated terminals honor the declared artifact contract.** Research-loop, unified-gate, and budget-exhausted terminals all mirror the terminal report to the brief-declared `paths[0]` (never clobbering an agent-authored artifact) and set `terminalArtifact`.
- **Leftover pending stages are swept to `skipped`** (with the reason) on every terminal commit instead of freezing `pending` in run.json forever.
- **Terminal reality gate no longer false-blocks on the consumed round result.** The engine restores the last consumed `round_result.json` before running planner-authored checks that reference it.
- **Agent-authored `ship_report.md` can no longer bypass the confirm gate.** The unified terminal-state gate runs the same brief-declared confirm on a research run's `shipped` terminal file and rejects the artifact on failure (guidance hint, run continues).
- **codex adapter effort key fixed** (`model_reasoning_effort`, not the silently-ignored bare `reasoning_effort`) — effort pins never took effect before.

### Added

- **Model/effort inheritance.** `model: default` / `reasoning_effort: default` now resolve explicit pin → the user's global `~/.codex/config.toml` → CLI built-in default, so projects follow the user's own codex setup with zero per-project maintenance across CLI upgrades.
- **`flowcrew rehearse <brief.md>`** — pre-flight wind tunnel: runs the brief through the REAL scheduler against a scripted fake agent in an isolated temp project + temp FC home (seconds, zero tokens), validating the engine × brief contract: frontmatter, confirm wiring, stop rules vs ceiling floor, declared terminal paths, round-result plumbing. `--static-only`, `--keep`.
- **ScriptedAdapter** (`src/adapters/scripted.ts`) — deterministic per-stage playback adapter powering rehearse and the repo-local engine-scenario regression suite.
- **`FC_HOME` env / `setFcGlobalDir()`** — structural isolation of the global state root for tests and rehearsal (never write runs/campaign ledgers into the real `~/.fc`).
- Supervisor `reasoning_effort` is now a role default (`low`, overridable via `supervisor.reasoning_effort`) instead of inheriting the work-agent effort — an inherited global `max` would blow the 30s assess timeout and silently un-steer runs.

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
