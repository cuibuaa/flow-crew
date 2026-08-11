# Changelog

## [0.7.0] - 2026-08-11

### Changed — the launch path is composed of tested commands instead of remembered steps

- **`ship-preflight`, `ship-setup`, `watch`, `land`, and `audit-report` replace steps an
  operator used to carry in their head.** The `ship` skill drops from 995 lines to 300, not by
  cutting content but by moving each rule to the layer that has ground truth: what a command
  can check, it checks; what the planner owns, the planner states; only judgement stays as
  prose. Both front ends now derive the same procedure from the same file — verified by
  running the real `claude` and `codex` CLIs against one brief and comparing their rehearsal
  digests, which had silently diverged: one front end was executing an older contract because
  it inferred execution order from heading order.

### Fixed — guards that refused for the wrong reason, or never refused at all

- **`land --remove` could not succeed on any repository that gitignores its build output.** It
  graded regenerable paths for display and then refused on the raw count, so fail-closed had
  become fail-always, and an operator who cannot use a guard removes worktrees by hand. Hand
  removal is what lost a 2,379-line generator. Removal now takes
  `--acknowledge-regenerable=<count>` matching the audited figure, re-derived at removal time
  so a stale number refuses; anything the grader could not prove regenerable still refuses
  unconditionally and cannot be acknowledged away. An injected probe found the complementary
  hole: ignored source directly beneath a dependency root graded as an installed dependency,
  so a correct acknowledgement authorised deleting it. It now grades as source.

- **`ship-setup` recorded the validation baseline before dependencies existed and printed
  `READY`.** All three roles exited 127, every gate degraded to "failed with an unparseable
  identity", and the headline said the workspace was ready. A guard that never fires is worse
  than one that always does, because nothing about the run looks wrong. A target that cannot
  run the project's own commands now refuses and writes no ready record.

- **Explicitly declared brief inputs could vanish without a message.** The heuristic that
  keeps prose scanning from treating ordinary words as paths was also applied to the explicit
  declaration list, where the key already states that the value is a path. A bare directory
  name was discarded silently. Declarations are now taken at their word, and an unresolvable
  one is reported as unresolved rather than dropped.

- **Ready records are keyed by what the brief says, not only where it lives.** Five
  consecutive invocations with different briefs produced a byte-identical record path, so
  nothing downstream could verify that the brief being launched was the brief that was
  baselined.

- **Terminal evaluation was inside `if (!failed)`, and an unmatched terminal persisted no
  conclusion at quiescence.** A settled batch could therefore leave no decision at all.
  Evaluation is now unconditional and records an explicit `incomplete` rather than silence: a
  run that cannot decide must say so. Both directions of status mismatch are surfaced without
  changing what the persisted lifecycle status means.

- **A launch target silently ran a smaller suite than its baseline was measured on.** Version
  control cannot populate an ignored directory in a fresh worktree, so a target held 150 of
  the source's 193 discoverable test files and every "full suite green" claim covered that
  smaller set. This is the same root cause 0.6.2 named and could not act on — a contract test
  living in `tests/`, gitignored, never running. Setup now completes the target and refuses,
  before recording a baseline, when it cannot.

- **A gate whose brief supplied no metric could reject a passing verdict indefinitely.** The
  implementation had nothing left to change while the repair loop kept running. The contract
  is stated at the planner layer and checked mechanically. Adversarial verification then found
  the guard could be bypassed outright: raw JSON `1e400` parses to `Infinity`, which satisfied
  a finite threshold. The candidate search filters on `Number.isFinite` before selecting a
  value, which closes all four sources — the original defect was a guard present on one path
  and absent from another, so the shared selector was the place to fix it.

### Changed — the test suite verifies properties instead of fastening onto values

- **An audit of every collected test module found 35 weak verification sites**: 20 overfit a
  fixture value, 8 guarded source text where behaviour was claimed, 5 policed style, and 2
  could not fail under any input. The proportions are the finding. Tautologies are the shape
  that is easy to grep for and they were rarest; the common defect is a well-formed assertion
  aimed at the wrong thing, which goes red when a fixture changes legitimately and stays green
  when the logic breaks in a way that preserves the number. Finding those required tracing a
  value's provenance across functions — the one that motivated the audit had its literal and
  its assertion 23 lines apart, in different functions, and no same-line search finds it.

  31 sites became relational or structural checks derived from what they test, each proved
  capable of failing through a transcribed red-then-green mutation. Exact values that are
  genuine contracts stayed exact rather than being loosened into range checks, which would
  have widened what passes. The 4 assertions removed without replacement are listed with the
  property now unguarded and why that is acceptable.

- **Documentation describes the surface instead of tallying it.** Counts of commands and
  statuses helped no reader decide anything and needed editing in three places on every
  addition. The CLI reference is now checked against the dispatcher's own command list, which
  cannot go stale and fails when a command goes undocumented.

## [0.6.2] - 2026-08-09

### Fixed — three defects found while running research tasks through the engine

- **A gate could be made unpassable by a naming difference between two files it wrote
  itself.** A gate wrote `verdict.metric = "failing_checks"` — its own health metric, zero
  checks failing — beside `metric.json.metric = "max_abs_train_spearman_to_vanilla_momentum"`,
  the domain metric its brief had asked it to report. Both files agreed the gate passed.
  `validateVerdictAgainstMetricFile` rejected the pair for the naming difference alone, so
  `readGateVerdict` returned `pass:false` for a file that said `pass:true` — every time, no
  matter what the stage did. On one run all four audits were rejected this way, fifteen times
  in the log; it escaped only when the three-round repair budget ran out, after ~2.5h of
  repair rounds that had nothing to repair. A rename is evidence of self-deception only when
  there is a failure for it to hide, so the check now also requires the metric file to
  indicate one — an explicit `pass: false`, or a numeric value missing its own threshold. The
  case the guard exists for, a failing domain metric replaced by a different passing one,
  still rejects. The violation now names both sides; it was a bare `metric name redefined`
  carrying neither, so the clash could not be diagnosed from the message.

  The repair stage was also handed the archived verdict as its "rejection evidence" — a file
  saying `pass:true` — with no way to see what the engine had objected to.
  `engine_verdict_<gate>.json` now records the engine's effective verdict and reason beside
  it, and the re-evaluation preamble points at it.

  This was never caught because its contract test lives in `tests/`, which is gitignored
  **and** outside the CI command. Every existing case sets `metric.pass === false`, which
  returns at the first branch and never reaches the name comparison, so the breaking
  combination was never constructed. One fixture even uses that exact clash but asserts null
  via the `phaseComplete` early return. That file now lives in `spec/`.

- **A run is no longer called stale just because it is quiet.** Both stale sites demoted a
  running campaign purely because neither `state.json` nor `iteration_log.jsonl` had been
  touched for 30 minutes. A single long stage — a fetch, a test suite, a research backtest —
  is silent for far longer than that while its scheduler works normally, so live runs were
  reported lost. Silence is now checked against the process holding the run: only a live
  process bound to *that* run suppresses the warning, so an absent, malformed or dead
  `scheduler.pid` still goes stale, and a recycled pid bound to a different run does not
  suppress. This deliberately does not reuse `hasLiveScheduler`, which guards
  `performStartupRecovery` rewriting a run to `failed` and must therefore over-report
  liveness; the two fail safe in opposite directions and must not be merged.

### Changed — the default campaign follows the repository, not the directory

- **Worktrees of one repository now share one campaign.** The default campaign name was
  `slug(basename(projectDir))`, so every linked git worktree got a campaign of its own and a
  single line of work split across as many campaigns as there were worktrees — auditing what
  a project had actually tried meant opening all of them. Any directory inside a repository
  now resolves to its main worktree.

  Two cases move: a linked worktree, and a subdirectory of a repository — `repo/src/deep`
  gave `deep` and now gives `repo`. **A checkout's own root, the common case, is unchanged**,
  as are an explicit `--campaign`, `defaults.yaml::campaign`, and any directory that is not a
  repository. If you have been running from worktrees, your next run lands in a campaign
  named for the repository rather than the worktree; the earlier campaign directories stay as
  they are. Inside a worktree `flowcrew quick` now prints which directory the name came from,
  since it no longer matches the one you are standing in.

## [0.6.1] - 2026-08-08

### Fixed — a 0.6.0 launch regression, and nullable fields in declared schemas

- **The agent runs under a login shell again.** v0.5.0 used `bash -lc`; v0.6.0 dropped the
  `-l` while the supervisor was rewritten around the portable shim. The systemd user
  manager's PATH does not include nvm or `~/.local/bin`, and only the login profile puts
  them there, so on a machine where `codex` or `claude` was plainly installed every
  background launch failed with *"No adapter CLI is installed or visible on PATH"*. `-lc` is
  accepted by `/bin/bash`, `/bin/sh` and `/bin/dash`, so this does not narrow which shells
  can host a run. Three CI axes missed it because a runner's PATH is already complete.

- **`type: [string, "null"]` in a declared schema can pass.** A union arrived as an array,
  which is truthy, so validation ran — but every type comparison then checked a string
  against an array and could not match, so a nullable field failed for *both* `null` and a
  string, i.e. always, regardless of content. The error read `expected string,null`, which
  was the array flattened by string interpolation. Unions now pass if any member matches, an
  empty union constrains nothing, and errors render as `string|null`. This affected both
  reality-gate `json-schema-match` checks and the research loop's per-round `result_schema`
  enforcement, so a brief that declared an optional reason field the standard way had its
  terminal state blocked by a false negative.

## [0.6.0] - 2026-08-07

### Changed — supervision no longer requires a service manager

- **A background run is owned by a portable shim, not by systemd.** Off a systemd user
  session — macOS, a container, a WSL2 install without systemd enabled — `flowcrew task
  cancel` could never confirm: `NodeSystemd.isActive` threw `ENOENT`, the catch discarded a
  *terminal* process-fallback record and returned the string `unverified:systemctl-error`,
  which was in neither `STOPPED_UNIT_STATES` nor the active set. The task pinned in
  `cancelling`, the daemon retried the same failing cancellation every 30s with no timeout
  and no route out, and cancelling an already-finished task wiped its terminal record. A
  small Node shim now owns each run and writes its exit status to disk atomically, so the
  outcome survives even the death of FlowCrew's own daemon — the one capability nothing in
  the Node supervisor ecosystem provides, because every one of them learns of an exit from
  an in-memory `child.on('exit')` in a live parent. Where a systemd user session exists it
  is still used for cgroup cleanup and tree-kill, but the recorded exit status, not systemd,
  is what the engine treats as truth.
- **Unit state is a closed six-member union.** The same string was previously read with
  opposite fail directions in two files, and a third, unimported copy of
  `STOPPED_UNIT_STATES` lived in `cancellation-client.ts` behind a `typeof x === 'string'`
  guard: once the state became an object that guard would have rejected every valid daemon
  response and silently re-run the coordinator inside the CLI — while still printing
  `Task #N cancelled` and exiting 0. `unitIsStopped` is now an exhaustive switch with a
  `never` check, so a seventh variant is a compile error rather than a silently pinned task.
- **`terminal-unknown` is a first-class outcome.** A `SIGKILL`ed shim records no exit status
  and may leave its agent alive, reparented. The engine does not round that to `failed`:
  the run ends marked unrecoverable and `flowcrew task cancel` refuses to report success.
- **Process identity is portable.** Linux keeps its exact `/proc` start-time token; Darwin
  binds by `ps -o lstart=` plus the recorded argv. `ps` is resolved absolutely rather than
  through `PATH` — a caller that strips service-manager tools from `PATH` must not thereby
  lose the ability to identify its own processes. On Linux this was invisible because procfs
  answers first; on macOS, where there is no procfs fallback, it broke everything downstream.

### Added — CI that can actually catch this class of defect

- **Three supervision axes, not one.** `quality` (systemd present), a new
  `no-service-manager` job that symlink-farms a `PATH` without `systemctl`/`systemd-run`/
  `journalctl`, and the existing blocking `macos` job (no procfs at all). Varying one axis
  silently pins the other at its Linux value, which is why every earlier "macOS is covered"
  claim was untestable. `macos-latest` is pinned to `macos-15`: GitHub's docs page and the
  runner-images README currently disagree about which release it points at.
- **Distribution jobs.** `npm pack` + global install exercising the documented first steps
  (the only way to catch a missing `files` entry, which no in-repo test can see), a cold
  `git clone` over HTTPS with a cold npm cache, and the four adapter-installation states.
  They run on `main` and `tests` pushes.
- **Verified on real hardware.** Darwin 24.6.0 arm64, GitHub run 31162993188, all ten jobs
  green. Every prior macOS claim in this repository was inferred from Linux.

### Fixed

- **A passing gate still dispatched a fix stage.** `gate_phase0` passing correctly skipped
  its fix stage; `gate_phase2` passing dispatched one anyway, which then re-ran the gate —
  about 24 minutes per occurrence.
- **`flowcrew status` and `/fc-status` are project-scoped.** They reported the most recent
  run on the whole machine, possibly belonging to an unrelated project.
- **The stage timeout had two sources of truth.** `config/defaults.yaml` said 60 minutes and
  the ship skill's confirmation message said 5, so a run driven by the skill timed out on
  the first attempt of every substantial stage. The skill no longer carries a number.
- **Replanning could drop an undone stage while the run still reported `complete`.**
- **A task title took the YAML frontmatter delimiter as its name**, so any brief with
  frontmatter was listed as `---`.
- **Two timing-sensitive specs made "CI is green" unreliable** as a judgement.
- **`flowcrew quick --background` registered a task without checking that an adapter CLI
  existed** to execute it: the submit path returned before the availability check.

### Changed — documentation states only what has been verified

- Three false platform claims removed; two known issues that this release fixes removed.
  Known issues is now defects only — a deliberate limitation is stated where the feature is
  described, so fixing a bug cannot silently rewrite a design decision.
- The README leads with what the tool does rather than with prerequisites; the value
  proposition moved from 31% depth to the first screen, and about 670 words of restatement
  and design rationale moved to `guide/` or were cut. A `spec/readme-contract.test.ts`
  pins the properties that cut relied on, including the passages that carry the project's
  voice, so a future trim cannot quietly remove them.
- Worked examples are labelled as illustrative shapes rather than transcripts: the one
  brief in the repository that runs as written is `examples/hello-research.brief.md`.

## [0.5.0] - 2026-08-06

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

- **Adapter selection stopped guessing, and stopped lying about the guess.** With no agent CLI installed, `flowcrew start` used to print `Auto-detected: claude` — because the detector had no way to express "none found" and fell back to a hardcoded name — and then silently rewrote the project's `defaults.yaml` on that false premise. Selection now lives in one place (`src/adapters/availability.ts`), the shipped template seeds the `auto` sentinel instead of a hardcoded `codex`, `flowcrew init` decides once and says why, `flowcrew doctor` diagnoses read-only, and the new `flowcrew adapter [auto|codex|claude]` is the one place that writes. Runtime paths never prompt and never write; with no CLI at all a launch now refuses with both real install commands instead of creating a run that dies at its first stage.
- **`npm i -g @anthropic/claude-code` does not exist.** Both places that printed it — including the last line before a hard exit — named a package that 404s; the correct `@anthropic-ai/claude-code` appeared nowhere in the repo. A test now pins every install hint to a real package name.
- **A failed run prints why it failed.** The cause and its fix were already computed and stored in `run.json`, then discarded before printing, leaving only `plan: failed`.
- **A YAML typo under `## Reality checks` no longer deletes every gate in silence.** A parse failure fell through to an empty check list, which is indistinguishable from "no checks were declared", so `rehearse` printed `Contract ready` and the run reached a terminal state with zero evidence checks. A parse failure is now a hard failure; a brief that declares no such section remains admissible, as before.
- **`flowcrew doctor` can no longer go green for someone else's checkout.** Its PATH check was a bare `which`, so any other install's `npm link` satisfied it; it now resolves through realpath and names the other install when they differ.
- **A brief containing a single quote could not be launched in the background.** The daemon rebuilt the relaunch command with the brief embedded as raw text, which survives neither `shellJoin` nor systemd's own `ExecStart` unescaping, so the relaunched CLI digested different bytes than the operator admitted and refused before creating a run. The brief now travels `--brief-input-base64`, the byte-safe channel the admission record already used.
- **The published package was missing the CLI's runtime inputs.** `files` omitted `skills/` (which is what `/ship` is), `examples/` (the brief the quickstart tells you to rehearse) and `guide/`. A test now pins the allowlist, and a second one derives the README's command total from the dispatch table so the two cannot drift.
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
