# Artifact freshness report

Disposition: all six criteria have been rechecked against the worktree. The typed ownership refusal is preserved through quiescent conclusion, and the shipped guide now states the unverified legacy policy. The Finish section records final worktree checks and reversible mutations. Full configured validation remains launcher-owned and is not claimed here.

## 1. Criterion evidence

| Criterion | Production evidence | Focused regression evidence |
|---|---|---|
| no-mtime-ownership | `src/terminal-artifact-status.ts:80` owns content comparison; `src/scheduler/sched_admission/brief-contract.ts:94` delegates receipt ownership. Neither former owner imports or compares a file time. | `spec/terminal-artifact-status.test.ts:13`, “shows old on-disk artifacts as unverified regardless of timestamps”; `spec/terminal-freshness.test.ts:202`, “persists %s receipt launch content before adapters work and accepts changed bytes with old mtimes”. |
| preserved-mtime-accepted | `src/terminal-artifact-status.ts:83`, `src/scheduler/sched_admission/brief-contract.ts:94`. Only content identity differences count. | The configured/inferred launch tests above independently change terminal and receipt bytes, preserve year-2000 timestamps, and reach `shipped`. “rejects %s terminal bytes even with newer timestamps” also checks changed bytes with old timestamps (`spec/terminal-artifact-status.test.ts:60`). |
| touched-not-accepted | Same owner returns `stale` for equal identities; receipt counting additionally requires a nonempty regular file (`brief-contract.ts:93`). | “rejects %s terminal bytes even with newer timestamps” covers touch, identical rewrite, and inherited bytes. “refuses a %s receipt with unchanged bytes despite a newer mtime” (`spec/terminal-freshness.test.ts:233`) independently covers all three receipt cases. Existing identical terminal rewrite and non-writing-stage scheduler coverage remain. |
| legacy-unverified | Closed `ArtifactOwnership` union and typed refusal at `terminal-artifact-status.ts:76`; reader projection at `:94`; resume refusal in `src/scheduler/sched_loop/brief.ts:62`; terminal refusal in `src/scheduler/sched_policy/terminal.ts:101` and preserved quiescent conclusion at `:336`; floor refusal in `brief-contract.ts:87`. | Legacy on-disk helper test; “shows legacy terminal ownership as unverified in status and listing” (`spec/cli-status-project.test.ts:85`); daemon merge projection (`spec/cli-daemon-status.test.ts:217`); “shows unverified terminal ownership in run detail” (`spec/ui/Truthfulness.test.tsx:548`); legacy continuation, unconfigured legacy metadata, terminal decision, and receipt-floor refusal tests in `spec/terminal-freshness.test.ts`; “preserves the typed %s ownership refusal through quiescent conclusion” at `:309` checks both missing-baseline sources and the persisted run outcome. The shipped policy at `guide/brief-contract.md:574-584` now agrees with these readers and decisions. |
| one-owner | `artifactOwnership` at `terminal-artifact-status.ts:80` is the only current/stale/unverified classifier. Terminal boolean adapter at `:86`, reader projection at `:94`, and floor receipts at `brief-contract.ts:94` all use it. | Both independent mutations below fail against their own regression tests. |
| light-tests | No new real-time assertion, timer wait or sleep. Explicit adapter boundaries and fixed filesystem timestamps establish the properties. | `ScriptedAdapter` records the actual producer calls; launch tests inspect persisted metadata inside adapter calls, before writing. Direct identity/floor tests use fixed byte strings and timestamps. Resume tests compare exact persisted baselines. Both mutations fail at semantic assertions, not timeouts. |

The report's line numbers name the final source unless explicitly marked “before”. No declaration keys, flags, stage/attempt record fields, session hooks/deadlines, append-log lifecycle, or watchdog sampling/silence rules were changed. Frozen `docs/freshness/AUDIT-ROWS.md` retains SHA-256 `4e3e65678878710075ca27cd3699aee80d49b41223f4d226642925490bac53a6`.

## 2. Every production modification-time reader, before and after

Inventory method: `rg -n 'mtime|\.mtim|modifiedAt' src config ui/src`, followed through the callers of each actual stat read. Before references were checked on the starting tree, not copied from the audit map. All rows marked unchanged retain the same read and decision. Type declarations, comments, SQL column declarations and formatting-only references are distinguished from actual readers.

| Reader (before → after) | What it reads and still decides |
|---|---|
| `src/terminal-artifact-status.ts:85` → removed | Former legacy `mtime >= Date.parse(run.startedAt)` accepted a product. Replaced by content owner `:80`; missing baseline is unverified. The `artifactMtimeMs` test seam was removed too. |
| `src/scheduler/sched_admission/brief-contract.ts:133` → removed | Former glob counter compared receipt mtime to run start. Replaced by persisted enumeration and shared content owner at `:85-98`, `:135`. |
| `src/content-identity.ts:43` → unchanged | Compares descriptor mtime before/after hashing, together with size and ctime, to reject an unstable content read. Never compares against run/attempt time; SHA-256 and byte length determine equal/different content. |
| `src/stage-watchdog.ts:109` → unchanged | Legacy diagnostic ownership labels for `output.md`, `verdict_<stage>.json`, and `handoff_<stage>.md`, comparing to the running attempt start when generation content baselines are absent. These populate `outputObserved`, `verdictObserved`, `handoffObserved` and the diagnostic `finalizing` flag (`:120-122`, `:183`). Idle protection is **only** native stream byte progress or sampled process progress (`:184`); reconciliation advances the silence clock only from that protection (`:250-266`). This read does not settle a terminal artifact, satisfy a terminal floor, or grant idle protection. Sampling and silence verdict are byte-for-byte unchanged. |
| `src/config.ts:95` → unchanged | Defaults-file mtime invalidates a parsed configuration cache. |
| `src/fc-tasks.ts:568,1231` → unchanged | Stable no-follow file reads (device/inode/size/mtime/ctime) and session-directory publication stamps; fences ledger reads and invalidates projections. No terminal ownership. |
| `src/cli-ship-preflight.ts:405,409` → unchanged | Chooses the latest candidate run by run-state mtime, with ID tie-break; does not attribute terminal files. |
| `src/cli.ts:1417-1424` → unchanged | Orders run IDs by `run.json` or reservation mtime; status/list content provenance comes separately from the shared owner. |
| `src/session-wake.ts:74` → unchanged | Includes waiter-file mtime in a lock observation signature used for safe waiter handling. Wake deadlines and hooks unchanged. |
| `src/rollback-content-store.ts:43,61,73` → unchanged | Records pathname/descriptor identity and verifies stable captures, copies and hashes. Mtime is part of a consistency fence, never a run-start attribution rule. |
| `src/adapters/diagnose.ts:47` → unchanged | Adapter executable fingerprint/cache identity includes mtime and ctime. |
| `src/agent-task-progress.ts:42,58` → unchanged | Renders approximate completion time from the `DONE` sentinel mtime for legacy agent tasks. Does not establish a terminal artifact or floor receipt. |
| `src/watch.ts:230,557-558,859` → unchanged | Reads metadata and takes the newest engine evidence mtime for a quiescent-run quiet-period alert. This is an operator alert clock, not the terminal artifact classifier; the terminal mismatch alert delegates to `terminalArtifactStatusMismatch` (`:778`). |
| `src/daemon-identity.ts:130,152` → unchanged | Maximum backend/UI build mtime is diagnostic. Build freshness is content-hash identity. `src/cli-daemon.ts:564` only formats the recorded maximum. |
| `src/task-registry.ts:951,963,990` → unchanged | Detects same-size rewrites and maintains the incremental registry cache using inode, size, mtime and ctime. |
| `src/dashboard.ts:219-233` → unchanged | Workflow-file mtime invalidates stage-role cache. |
| `src/run-index.ts:50,160,222` → unchanged | Metadata identity for incremental index updates; persists run-state mtime for recency ordering. SQL/type references are carriers, not further filesystem reads. |
| `src/run-state-view.ts:289` → `:290` | Exposes artifact `modifiedAt` as metadata. New `terminalArtifacts` provenance is a separate closed projection (`:553`), fenced for consistency. Existence and modifiedAt make no ownership claim. |
| `src/run-drift.ts:151,491` → unchanged | File observation timestamps and registry scan-cache invalidation; reports file observation time and resource drift. |
| `src/project-validation.ts:528,536` → unchanged | Before/after inode/mtime/ctime/size token rejects an unchanged external validation report. This is a command report replacement check, not terminal product ownership or a run-start comparison. |
| `src/engine-integrity.ts:46` → unchanged | Stat token helps fence engine carrier integrity and append checks; content hashes remain the content proof. |
| `src/store.ts:1656` → `:1657` | Comment only about a removed historical mtime race; no modification-time read. |

No modification-time reader exists in `config/` or `ui/src/`. Remaining UI “freshness” values about dashboard build identity are unrelated to terminal ownership and unchanged. `src/orchestrator-rpc.ts:165` carries `buildNewestMtimeMs` as a type; it performs no filesystem read.

## 3. Shared owner and launch/persistence boundary

`artifactOwnership(baseline, identity)` lives in the existing `src/terminal-artifact-status.ts:80`. It reads `ContentIdentity` values from the existing `src/content-identity.ts` primitive: type, byte length, SHA-256, explicit absence, or unavailable. Missing baseline metadata and unavailable content produce `unverified`; an absent/non-file current identity or equal bytes produce `stale`; a different regular file produces `current`. There is no timestamp seam. The existing `terminalArtifactIdentity` canonical-root check remains the filesystem identity reader. Existing snapshot naming, declaration path checks, terminal-owner attribution, review/gate authority, publication and quarantine checks remain in their original paths.

`terminalReceiptGlob` (`src/scheduler/sched_admission/brief-contract.ts:126`) centralizes both the declared pattern and the existing inferred sibling `stage_*_verdict.md` pattern. `receiptIdentities` (`:135`) enumerates the same simple single-directory star glob, checks lexical/canonical containment, reads identities, and records enumeration errors explicitly. A successful empty enumeration is recorded absence for future matching names; missing enumeration metadata is never treated as that empty enumeration. The floor retains nonempty/file-kind requirements. Glob literals are escaped before matching.

`configureWorkflowBrief` (`src/scheduler/sched_loop/brief.ts:57-68`) captures terminal files and receipt enumerations together before producer execution and writes them to run-level `terminalArtifactBaselines` / `terminalReceiptBaselines` in `run.json` (`src/store.ts:440-442`). Capture requires fresh configuration, an engine-initialized content-format record and no resumed execution. Missing historical baseline metadata is refused, even if the launch path labels an unconfigured record as non-resuming. A resumed/configured run keeps its original values; it never takes a new historical snapshot. The scheduler calls configuration before loading/executing producers (`src/scheduler/sched_loop/run-workflow.ts:98-115`). No stage or attempt record format changes.

Tests “persists %s receipt launch content before adapters work and accepts changed bytes with old mtimes” inspect the durable launch record inside each adapter call for both inferred/configured patterns. “preserves launch baselines across resume and records absence before files exist” verifies persisted explicit file absence, empty receipt enumeration, and byte-for-byte baseline retention on resume. The unconfigured legacy test checks both values of the launch resuming flag. Boundary, missing, directory, empty-file and symlink-escape tests retain refusal coverage.

## 4. Old-run operator experience and readers

A declared or recorded old terminal artifact without a baseline is shown as `unverified`, regardless of its timestamp. Lifecycle status is not rewritten by a reader. `current`, `stale`, and `unverified` are closed values (`src/terminal-artifact-status.ts:76`; `ui/src/types.ts:250`).

- `flowcrew status` prints `Terminal artifact: result.md · unverified` (`src/cli.ts:1575`).
- `flowcrew list` includes `[result.md: unverified]` beside the lifecycle status (`src/cli.ts:1613`).
- The shared operational projection carries `terminalArtifacts` (`src/cli-events.ts:88,392`) into daemon task detail (`src/cli-daemon.ts:239`) and dashboard run detail (`src/dashboard.ts:532`). Task text detail and any task list carrying that projection render it (`src/cli-task.ts:198,226`). The daemon's index-only task listing (`src/cli-daemon.ts:286`) continues to report lifecycle only; it does not claim terminal file provenance or scan every run. Dashboard summary listings likewise summarize lifecycle without an artifact ownership claim.
- UI run detail renders the same closed value (`ui/src/components/RunDetail.tsx:569`). The canonical state view also includes fenced `terminalArtifacts` (`src/run-state-view.ts:318,553`).
- Watch mismatch discovery still uses the terminal helper (`src/watch.ts:778`); a legacy touched file cannot cause a newly discovered terminal-status mismatch. An already recorded terminal-artifact/status disagreement remains a historical diagnostic, independent of the ownership projection.
- Resume returns `incomplete` with typed run `reasonCode: artifact_ownership_unverified` before adapter work (`src/scheduler/sched_loop/brief.ts:62`). Direct terminal evaluation and floor evaluation also return this typed reason (`src/scheduler/sched_policy/terminal.ts:101,179`, `brief-contract.ts:87`). Quiescent conclusion preserves the same typed reason (`terminal.ts:336`), including refusals originating in receipt-floor evaluation. No baseline is synthesized. Run conclusion uses the existing conclusion mechanism with one added closed reason value (`src/scheduler/sched_policy/run-completion.ts:15`).

## 5. Mechanisms, comparable size, and author verification

Removed: legacy run-start timestamp fallback and its override seam (`terminal-artifact-status.ts`, before `:27,83-90`); the timestamp receipt counter (`brief-contract.ts`, before `:114-141`); implicit absent-path provenance from a missing terminal baseline key (before `terminal-artifact-status.ts:93`). Replaced by one content ownership classifier (after `terminal-artifact-status.ts:80`), a persisted receipt enumeration (after `brief-contract.ts:126-160`), and one shared reader projection (after `terminal-artifact-status.ts:94`). Launch capture before `brief.ts:56-59` now captures both sets and refuses unsupported historical records at after `:57-68`.

The repair replaces the unconditional quiescent `terminal_unmatched` reason at before `terminal.ts:336` with `evaluation.reasonCode ?? 'terminal_unmatched'` at after `:336`; it adds no state or production lines.

Net growth pays for the required receipt persistence, explicit unknown state, typed refusal, and reader exposure; it introduces no configurable policy, declaration surface, parallel publication channel, or new production file. The two independently implemented time policies are gone. Keeping the existing content primitive and run metadata avoids a new receipt format and producer protocol.

Counts use physical lines (`splitlines`) in exactly the same tracked paths on the starting tree and final worktree, including blank lines/comments. Changed production paths:

| File | Before | After |
|---|---:|---:|
| `src/cli-events.ts` | 602 | 604 |
| `src/cli-task.ts` | 422 | 424 |
| `src/cli.ts` | 1929 | 1932 |
| `src/run-state-view.ts` | 570 | 573 |
| `src/scheduler/sched_admission/brief-contract.ts` | 141 | 160 |
| `src/scheduler/sched_loop/brief.ts` | 68 | 76 |
| `src/scheduler/sched_policy/run-completion.ts` | 164 | 164 |
| `src/scheduler/sched_policy/terminal.ts` | 427 | 431 |
| `src/store.ts` | 2206 | 2207 |
| `src/terminal-artifact-status.ts` | 193 | 205 |
| `ui/src/components/RunDetail.tsx` | 746 | 747 |
| `ui/src/types.ts` | 358 | 359 |

Whole tracked `src/` + `config/`: 54,945 → 54,999 physical lines (+54). Whole tracked `ui/src/`: 4,353 → 4,355 (+2). Net production growth is 56 lines on the same file population. There are 10 changed `src/` files, no changed `config/` file, and two UI files, well within the scope bound.

Test changes: no test file was deleted. The obsolete “retains the legacy mtime evidence override without requiring a local content identity” case was replaced with explicit missing-baseline/recorded-absence checks because that seam and behavior were removed. The old on-disk mtime acceptance case now asserts unverified. The retained-file/directory legacy settlement and old-engine resume cases now assert typed refusal and zero adapter calls, retaining stage/attempt immutability and lifecycle-import assertions. The inferred/configured floor workflow now writes genuinely different receipt bytes; identical-byte rewrite is separately negative. Snapshot/ambiguity/watch/daemon, archival, research-final-iteration, review-ordering, and Git-fact publication fixtures now explicitly record launch absence for the paths whose freshness they assert. These preserve the original downstream policy assertions; in particular, negative review cases still reach review policy rather than passing merely because provenance was unknown. The review-ordering fixtures no longer manipulate mtimes as proof of freshness. The old real elapsed-time assertion in the fast-floor case and timestamp assertion in the rewrite case were removed; successful settlement and stage evidence are the observable assertions. New criterion tests have no sleeps or elapsed-time thresholds.

## Finish

Rechecked all six frontmatter criteria from the archived brief against the actual source and
worktree tests; the table above records the deciding functions and assertions. In particular:

- Quiescent conclusion uses `evaluation.reasonCode ?? 'terminal_unmatched'` at
  `src/scheduler/sched_policy/terminal.ts:336`. Both missing-terminal and missing-receipt
  regressions assert the real persisted `incomplete` outcome with
  `artifact_ownership_unverified`, not just the evaluator return value.
- `guide/brief-contract.md:574-584` now documents `unverified` reader ownership, typed
  continuation/settlement refusal, pre-work receipt content baselines, preserved old
  timestamps, and rejection of touched/identically rewritten bytes. Searched all shipped
  `guide/` and `skills/` text for timestamp/mtime ownership claims; no other obsolete policy
  remains. `spec/ship-docs.test.ts` stamps only the `skills/ship.md` body, which is unchanged;
  revision 50 and digest `7863a2955341` therefore remain valid.
- Independently re-inventoried every production `mtime`, `.mtim`, and `modifiedAt` reader
  and checked both removed decisions against `41ce2a5`. The inventory in section 2 is
  unchanged. The watchdog's remaining attempt-time comparison is diagnostic only;
  `protectedFromIdleAbort` and reconciliation use stream/process progress. Its source,
  session hooks, append-log lifecycle, strict declaration schema, and stage/attempt record
  formats are unchanged. Recounted 54,945 → 54,999 lines in tracked `src/` + `config/`,
  and 4,353 → 4,355 in tracked `ui/src/`; no test file was deleted.
- The frozen audit SHA-256 is still
  `4e3e65678878710075ca27cd3699aee80d49b41223f4d226642925490bac53a6`.

### Worktree verification and selection

`npm run build` exited **0** before tests, publishing backend and UI. Build scratch was
placed under the allowed reports directory, outside the checkout: the initial attempt to
stage inside the checkout was refused by the existing build-overlap guard. Targeted ESLint
on all ten changed `src/` modules exited **0**, with only the two existing `src/cli.ts`
warnings at lines 821 and 1632. `git diff --check` passed.

`select-specs.mjs` in the finish evidence directory mechanically computes the changed paths
against `41ce2a5`, parses all TypeScript/JavaScript string literals, resolves relative
static/dynamic/type imports and source-path references (including `.js` → `.ts`/`.tsx` and generated `dist/` → `src/` paths),
then takes the reverse dependency closure through `src/`, UI and spec helpers. It also
includes any spec mentioning a changed module path in a string, every `*.replay.ts(x)`,
every `spec/engine/` spec, changed specs, and `spec/spec-purity.test.ts`. A separate `rg`
path-mention audit found no unselected spec mentioning a changed module. The exact selection
and per-file dependency reasons are `finish-specs-expanded.txt` and `finish-specs-expanded.json`: **345 of
357** spec files, rather than the earlier report's direct-import-only selection.

The primary 344-file command is recorded as argv in `finish-test-command.json`:

```sh
nice -n 19 python3 <finish-evidence>/run-selected.py
# child: node_modules/.bin/vitest run <all 344 paths below> --maxWorkers=4 \
#   --cache=false --reporter=default --reporter=json --outputFile.json=<finish-evidence>/finish-tests.json
```

It uses the ordinary Vitest configuration, global source/build checks and per-file home
isolation, with a short private `t/` fixture parent inside this worktree. Raw output and
reporter data are `finish-tests.log`, `finish-tests.json` and `finish-tests.exit`.
Primary selection: 344 spec files; 5218 passed, 1 failed, 1 pending tests. Additional generated-path spec: 18 passed, 0 failed, 0 pending.

The primary batch exited **1** because `spec/ui-vitest-config.test.ts:85` still expected
51 UI cases after this task added the unverified-ownership rendering test. Direct UI
discovery confirmed **52**, including the new case, with the same three governed files.
Corrected the count to 52 and retained the file identities and clean-archive parity checks.
Re-ran that spec and `spec/spec-purity.test.ts` with normal setup: **exit 0, 2 files,
16 passed**, no skips (`finish-ui-discovery-fix-tests.log/json`). No production fix or
weakened discovery check was needed. The per-file list below uses these final results.

The build replay's existing npm-only guard does not run its case when Vitest is invoked
directly, so that spec was additionally run through `npm run test --
spec/ux-perf-build-tests.replay.ts --maxWorkers=1 --cache=false` with both default and JSON
reporters. It exited **0**, **1 passed**, no skips (`finish-live-build-replay.log/json`).
The additional `spec/skills-onboarding.test.ts` references the generated `dist/cli.js`;
including generated-path equivalents in the same mechanical selection added it to the
final list. Its separate normal-config `npm run test -- spec/skills-onboarding.test.ts
--maxWorkers=1 --cache=false` run exited **0**; raw results are
`finish-additional-tests.log/json`. Every selected spec is listed with its actual result:

```text
spec/acceptance-audit.qa.test.ts — 5 passed
spec/acceptance-gate-adversarial.qa.test.ts — 9 passed
spec/acceptance-gate-reevaluation.qa.test.ts — 3 passed
spec/acceptance-gate.qa.test.ts — 6 passed
spec/acceptance-loop.test.ts — 13 passed
spec/adapter-authentication.test.ts — 19 passed
spec/adapter-availability.test.ts — 59 passed
spec/adapter-credential-lifetime.test.ts — 15 passed
spec/adapter-diagnose.test.ts — 8 passed
spec/adapter-input-limit.test.ts — 53 passed
spec/adapter-native-diagnosis.test.ts — 7 passed
spec/admission-settlement.test.ts — 13 passed
spec/agent-safety-contract.test.ts — 14 passed
spec/agent-task-progress.test.ts — 6 passed
spec/api/campaign-schema.test.ts — 3 passed
spec/approval-integrity.test.ts — 4 passed
spec/artifact-literal-location.test.ts — 13 passed
spec/atomic-publication.test.ts — 12 passed
spec/attempt-attribution.test.ts — 16 passed
spec/attempt-closure-owner.test.ts — 4 passed
spec/attempt-cost.test.ts — 6 passed
spec/attempt-deadline-wip-regressions.test.ts — 4 passed
spec/attempt-history.test.ts — 4 passed
spec/attempt-signal-watch.test.ts — 4 passed
spec/audit-engine-boundaries-2.test.ts — 4 passed
spec/audit-partial-verification.test.ts — 7 passed
spec/author-output-cost.test.ts — 3 passed
spec/background-adapter-preflight.test.ts — 2 passed
spec/baseline-failure-identity.test.ts — 23 passed
spec/blocked-result-gate.test.ts — 7 passed
spec/brief-frontmatter.test.ts — 10 passed
spec/brief-outcome-gate.test.ts — 8 passed
spec/brief-preflight.test.ts — 6 passed
spec/brief-prose-admission.test.ts — 12 passed
spec/brief-request-evidence.test.ts — 1 passed
spec/brief-writer.test.ts — 48 passed
spec/build-distribution.test.ts — 2 passed
spec/build-identity.test.ts — 25 passed
spec/build-staging-cache.test.ts — 2 passed
spec/build-state-integrity.test.ts — 11 passed
spec/campaign-base-directory.test.ts — 5 passed
spec/campaign-context.test.ts — 13 passed
spec/campaign-page-api.test.ts — 2 passed
spec/campaign-page-client-contract.test.ts — 3 passed
spec/campaign-page-read-model.test.ts — 22 passed
spec/campaign-page-ui.test.tsx — 16 passed
spec/campaign-scale.test.tsx — 2 passed
spec/cancel-repended-daemon.test.ts — 2 passed
spec/cancellation-decision.test.ts — 3 passed
spec/cancellation-liveness.test.ts — 22 passed
spec/cancellation-park.test.ts — 8 passed
spec/cancellation-recovery-identity.test.ts — 22 passed
spec/cancellation-repend-paths.test.ts — 3 passed
spec/cancellation-settlement.test.ts — 20 passed
spec/claude-continuations.test.ts — 3 passed
spec/claude-parity-results.test.ts — 21 passed
spec/claude-sessions.test.ts — 62 passed
spec/cli-args.test.ts — 183 passed
spec/cli-daemon-status.test.ts — 10 passed
spec/cli-doctor.test.ts — 5 passed
spec/cli-export-inputs.test.ts — 1 passed
spec/cli-fc-tasks.test.ts — 22 passed
spec/cli-integrity.test.ts — 12 passed
spec/cli-inventory.test.ts — 94 passed
spec/cli-pipe.test.ts — 7 passed
spec/cli-status-project.test.ts — 3 passed
spec/cli-task.test.ts — 20 passed
spec/clock-diagnostics.test.ts — 16 passed
spec/clock-http-server.test.ts — 6 passed
spec/clock-identity.test.ts — 22 passed
spec/closed-loop-drift.test.ts — 5 passed
spec/codex-config-inheritance.test.ts — 17 passed
spec/condition-fact-resolution.test.ts — 6 passed
spec/continuation-compatibility.test.ts — 19 passed
spec/contract-reachability-before.test.ts — 9 passed
spec/contract-strict.test.ts — 36 passed
spec/control-validation.test.ts — 35 passed
spec/criteria-lint.test.ts — 3 passed
spec/d9-command-events.test.ts — 1 passed
spec/daemon-control-boundaries.test.ts — 17 passed
spec/daemon-deploy.test.ts — 24 passed
spec/daemon-reconciliation.test.ts — 40 passed
spec/daemon-scratch-startup.test.ts — 1 passed
spec/daemon-socket-selection.test.ts — 2 passed
spec/daemon-start.test.ts — 10 passed
spec/daemon-startup-retention.test.ts — 2 passed
spec/daemon-surface.test.ts — 6 passed
spec/daemon-tick-failure.test.ts — 3 passed
spec/darwin-branch-simulation.test.ts — 9 passed
spec/dashboard-approval.test.ts — 2 passed
spec/dashboard-campaign.test.ts — 8 passed
spec/dashboard-inbox-ownership.test.ts — 1 passed
spec/dashboard-task-lifecycle.test.ts — 33 passed
spec/dashboard-truthfulness.test.ts — 2 passed
spec/decision-graph.test.ts — 33 passed
spec/declared-contract-repair.test.ts — 24 passed
spec/declared-contract.test.ts — 24 passed
spec/declared-output-aliases.test.ts — 10 passed
spec/declared-replay.test.ts — 8 passed
spec/deployment-hold-history.test.ts — 17 passed
spec/deployment-hold.test.ts — 35 passed
spec/direct-workflow.test.ts — 12 passed
spec/dispatch-admission-parallel-warning.test.ts — 1 passed
spec/dispatch-document.test.ts — 3 passed
spec/doc-reviewer-contract.test.ts — 3 passed
spec/engine-batch-regressions.test.ts — 4 passed
spec/engine-boundaries-2.test.ts — 5 passed
spec/engine-boundaries-3.test.ts — 4 passed
spec/engine-boundaries-4.test.ts — 3 passed
spec/engine-boundaries-5.test.ts — 3 passed
spec/engine-boundaries-6.test.ts — 1 passed
spec/engine-boundaries-8.test.ts — 29 passed
spec/engine-carrier-writers.test.ts — 17 passed
spec/engine-generalization-contracts.test.ts — 7 passed
spec/engine-generalization-runtime.test.ts — 23 passed
spec/engine-generalization-setup.test.ts — 11 passed
spec/engine-instrument-fidelity.test.ts — 1 passed
spec/engine-integrity-settlement.test.ts — 2 passed
spec/engine-integrity.test.ts — 137 passed
spec/engine-perf-settlement.test.ts — 27 passed
spec/engine-principles-declaration-retry.test.ts — 3 passed
spec/engine-principles-declarations.test.ts — 15 passed
spec/engine-principles-durability.test.ts — 7 passed
spec/engine-principles-independent.test.ts — 105 passed
spec/engine-principles-integration.test.ts — 20 passed
spec/engine-principles-policies.test.ts — 2 passed
spec/engine-principles-state.test.ts — 31 passed
spec/engine-records-regressions.test.ts — 3 passed
spec/engine-remediation.test.ts — 11 passed
spec/engine-selfcollision.test.ts — 8 passed
spec/engine-truthfulness.test.ts — 7 passed
spec/engine/codex-cleanup.contract.test.ts — 2 passed
spec/engine/context.contract.test.ts — 5 passed
spec/engine/dispatch-retry-and-reject.contract.test.ts — 11 passed
spec/engine/engine-a-plus.contract.test.ts — 18 passed
spec/engine/engine-terminal-truthfulness.contract.test.ts — 2 passed
spec/engine/ledger.contract.test.ts — 2 passed
spec/engine/objective-frontmatter.contract.test.ts — 7 passed
spec/entry-guards.test.ts — 19 passed
spec/evidence-ledger.test.ts — 15 passed
spec/execution-default-source.test.ts — 3 passed
spec/external-output-directory.test.ts — 40 passed
spec/failure-evidence-transport.test.ts — 3 passed
spec/fc-tasks-wip-regressions.test.ts — 34 passed
spec/fc-tasks.test.ts — 46 passed
spec/fixed-plan-selection.test.ts — 11 passed
spec/fm-campaign-integration.test.ts — 18 passed
spec/forensic-validation.qa.test.ts — 4 passed
spec/frozen-field.test.ts — 6 passed
spec/gate-attempt-contract.test.ts — 20 passed
spec/gate-own-verdict.test.ts — 8 passed
spec/gate-repair-confirmation.test.ts — 35 passed
spec/gate-result.test.ts — 33 passed
spec/gate-retry-entry.test.ts — 5 passed
spec/gate-score-contract.test.ts — 8 passed
spec/gate-settlement-identity.test.ts — 7 passed
spec/git-facts-cli.test.ts — 7 passed
spec/git-facts-ownership.test.ts — 20 passed
spec/git-facts-process.test.ts — 6 passed
spec/git-facts-records.test.ts — 2 passed
spec/git-facts.test.ts — 94 passed
spec/git-metadata-scope.test.ts — 3 passed
spec/graceful-attempt-termination.test.ts — 8 passed
spec/guidance-feasibility-controls.test.ts — 12 passed
spec/guide.test.ts — 5 passed
spec/invocation-controls.test.ts — 10 passed
spec/invocation-input.test.ts — 11 passed
spec/iteration-log.test.ts — 1 passed
spec/jsonl-reader.test.ts — 9 passed
spec/land-archive.test.ts — 3 passed
spec/land.test.ts — 57 passed
spec/large-file-state.test.ts — 1 passed
spec/ledger-convergence.test.ts — 23 passed
spec/ledger-handoff.test.ts — 10 passed
spec/legacy-run-history.test.ts — 1 passed
spec/legacy-stage-history.test.ts — 2 passed
spec/lifecycle-crash.test.ts — 28 passed
spec/lifecycle-log.test.ts — 34 passed
spec/livelog-per-attempt.test.ts — 6 passed
spec/lock-liveness.test.ts — 21 passed
spec/lock-publication.test.ts — 36 passed
spec/loop-close-terminal.test.ts — 2 passed
spec/m11b-process-identity.test.ts — 5 passed
spec/m9-task-list.test.ts — 1 passed
spec/native-invocation-usage.test.ts — 15 passed
spec/negotiation.test.ts — 12 passed
spec/no-approvals.test.ts — 10 passed
spec/no-passwd-entry.test.ts — 3 passed
spec/od-validation-receipt.test.ts — 9 passed
spec/open-source-init.test.ts — 2 passed
spec/operator-ui.test.tsx — 3 passed
spec/orchestration-contract-regressions.test.ts — 18 passed
spec/orchestrator-rpc.test.ts — 44 passed
spec/orchestrator.test.ts — 111 passed
spec/parallel-scope-batch.test.ts — 5 passed
spec/parked-dead-shim.test.ts — 21 passed
spec/path-extraction.test.ts — 4 passed
spec/pivot-recovery.test.ts — 3 passed
spec/plan-retry-monotone.test.ts — 11 passed
spec/planner-admission-check.test.ts — 5 passed
spec/planner-carrier.test.ts — 2 passed
spec/planner-contract.test.ts — 8 passed
spec/planner-dispatch-condition.test.ts — 2 passed
spec/planner-output-contract.test.ts — 14 passed
spec/planner-read-source.test.ts — 1 passed
spec/portable-supervision-safety.test.ts — 14 passed
spec/project-validation.test.ts — 19 passed
spec/prompt-size.test.ts — 6 passed
spec/provider-liveness.test.ts — 12 passed
spec/provider-result-contract.test.ts — 143 passed
spec/published-inputs.test.ts — 8 passed
spec/push-liveness.test.ts — 2 passed
spec/push-rendering.test.ts — 8 passed
spec/quick-foreground.test.ts — 2 passed
spec/quick-ledger.test.ts — 11 passed
spec/race-legacy-ownership.test.ts — 2 passed
spec/readme-contract.test.ts — 11 passed
spec/reality-check-admission.test.ts — 8 passed
spec/reality-check-artifact-admission.test.ts — 3 passed
spec/reality-gate.test.ts — 27 passed
spec/reevaluation-fix.test.ts — 1 passed
spec/repair-plan-revision.test.ts — 6 passed
spec/repair-replan-budget.test.ts — 5 passed
spec/replan-evidence-retention.test.ts — 3 passed
spec/replan-stage-obligation.test.ts — 4 passed
spec/research-branch-applicability.test.ts — 10 passed
spec/research-loop.test.ts — 51 passed
spec/research-measurement.test.ts — 53 passed
spec/research-readers.test.ts — 4 passed
spec/restart-process-ownership.test.ts — 6 passed
spec/resume-continuation.test.ts — 16 passed
spec/resume-rejected-gate.test.ts — 9 passed
spec/retry-attempt-deadline.test.ts — 2 passed
spec/review-input-bound.test.ts — 19 passed
spec/run-conclusion.test.ts — 20 passed
spec/run-lock-portability.test.ts — 5 passed
spec/run-owned-state-scope.test.ts — 5 passed
spec/run-page-api.test.ts — 8 passed
spec/run-page-model.test.ts — 7 passed
spec/run-page-ui.test.tsx — 30 passed
spec/run-retention-integration.test.ts — 7 passed
spec/run-retention.test.ts — 72 passed
spec/run-status-totality.test.ts — 14 passed
spec/run-summary.test.ts — 23 passed
spec/run-tree-ownership.test.ts — 56 passed
spec/run-workflow-cleanup.test.ts — 3 passed
spec/runtime-settlement.test.ts — 6 passed
spec/safe-parallel.test.ts — 13 passed
spec/scheduler-loop-heartbeat.test.ts — 3 passed
spec/scheduler-retry-policy.test.ts — 22 passed
spec/scheduler-stall-history.test.ts — 2 passed
spec/scheduler-stall-ignored-content.test.ts — 4 passed
spec/scope-dotfile-authorization.test.ts — 1 passed
spec/scope-language.test.ts — 31 passed
spec/scratch-lifetime.test.ts — 24 passed
spec/session-integration.test.ts — 43 passed
spec/session-open-view.test.ts — 12 passed
spec/session-push-cost.test.ts — 1 passed
spec/session-push.test.ts — 41 passed
spec/session-reader-ownership.test.ts — 15 passed
spec/session-reuse.test.ts — 14 passed
spec/session-wake.test.ts — 40 passed
spec/settlement-reachable.test.ts — 5 passed
spec/shared-store-integrity.test.ts — 3 passed
spec/ship-cli.test.ts — 5 passed
spec/ship-docs.test.ts — 16 passed
spec/ship-preflight.test.ts — 44 passed
spec/ship-setup-baseline-reuse.test.ts — 22 passed
spec/ship-setup-record.test.ts — 13 passed
spec/ship-setup.test.ts — 56 passed
spec/signal-cli.test.ts — 2 passed
spec/single-author-legacy.test.ts — 8 passed
spec/skill-consolidation-contract.test.ts — 4 passed
spec/skills-onboarding.test.ts — 18 passed
spec/spec-purity.test.ts — 15 passed
spec/spec_runtime/declared-fixtures.test.ts — 3 passed
spec/spec_runtime/pivot-injection.test.ts — 4 passed
spec/spec_services/contract-audit.test.ts — 2 passed
spec/stage-attempt-clock.test.ts — 19 passed
spec/stage-budget.test.ts — 87 passed
spec/stage-duration-limit.test.ts — 49 passed
spec/stage-output-slimming.test.ts — 10 passed
spec/stage-progress.test.ts — 8 passed
spec/stage-record-correction.test.ts — 42 passed
spec/stage-settlement-products.test.ts — 26 passed
spec/stage-watchdog.test.ts — 13 passed
spec/stage-write-contract.test.ts — 5 passed
spec/stale-detection-liveness.test.ts — 8 passed
spec/state-root.test.ts — 2 passed
spec/status-literal-guard.test.ts — 4 passed
spec/store-identity.test.ts — 25 passed
spec/store.test.ts — 10 passed
spec/supervise-shim.test.ts — 14 passed
spec/supervised-lifecycle.test.ts — 4 passed
spec/supervision-cli-surfaces.test.ts — 6 passed
spec/supervision.test.ts — 5 passed
spec/supervisor-abort-attribution.test.ts — 3 passed
spec/supervisor-state-contract.test.ts — 12 passed
spec/task-registry-maintenance.test.ts — 6 passed
spec/task-registry.test.ts — 5 passed
spec/task-title-surfaces.test.ts — 2 passed
spec/terminal-artifact-acceptance.test.ts — 10 passed
spec/terminal-artifact-status.test.ts — 12 passed
spec/terminal-attempt-delta.test.ts — 5 passed
spec/terminal-final-contract-workflow.test.ts — 3 passed
spec/terminal-freshness.test.ts — 26 passed
spec/terminal-gate-authority.test.ts — 16 passed
spec/terminal-publication.test.ts — 19 passed
spec/terminal-review-order.test.ts — 1 passed
spec/terminal-review-settlement.test.ts — 5 passed
spec/terminal-study-completion.test.ts — 4 passed
spec/test-isolation.test.ts — 11 passed
spec/timeout-extension-write-time.test.ts — 1 passed
spec/typed-reality-checks.test.ts — 6 passed
spec/u1-status.test.ts — 3 passed
spec/ui-language.test.tsx — 5 passed
spec/ui-observability.test.tsx — 2 passed
spec/ui-redundancy.test.tsx — 2 passed
spec/ui-vitest-config.test.ts — 1 passed after correcting the UI count to 52
spec/ui/Inbox.test.tsx — 18 passed
spec/ui/Truthfulness.test.tsx — 32 passed
spec/ux-perf-build-tests.replay.ts — 1 skipped; npm replay: 1 passed
spec/ux-perf-dashboard-event.replay.ts — 1 passed
spec/ux-perf-engine-loop.replay.ts — 9 passed
spec/ux-perf-operator-surface.replay.tsx — 15 passed
spec/ux-perf-state-daemon.replay.ts — 22 passed
spec/validation-budget.test.ts — 16 passed
spec/validation-clock.test.ts — 8 passed
spec/validation-data-isolation.test.ts — 1 passed
spec/validation-dependency-sync.test.ts — 6 passed
spec/validation-environment-paths.test.ts — 1 passed
spec/validation-load.test.ts — 16 passed
spec/validation-ownership.test.ts — 55 passed
spec/validation-scheduling.test.ts — 6 passed
spec/validation-scratch.test.ts — 1 passed
spec/verify-contract-independent.qa.test.ts — 3 passed
spec/verify-contract-qa-edge.test.ts — 7 passed
spec/verify-engine-remediation.qa.test.ts — 12 passed
spec/verify-fc-tasks-gate.test.ts — 10 passed
spec/verify-fixes-gate.test.ts — 6 passed
spec/verify-ledger.qa.test.ts — 9 passed
spec/verify-totality-stage.test.ts — 2 passed
spec/watch.test.ts — 41 passed
spec/write-grant.test.ts — 56 passed
spec/write-scope-subtraction.test.ts — 49 passed
```

### Socket-path investigation

The archived summary reports two socket-path failures without identifying the original
fixture paths. Reproduced the environment sensitivity in unchanged
`spec/scratch-lifetime.test.ts` against both the final source and a `git archive 41ce2a5`
copy, built with the same dependencies. The original spec and scratch-allocation code
are byte-identical at base and final. All homes, sockets and temporary roots were private.

| Source | Fixture path | Direct exit | Result |
|---|---|---:|---|
| Final | Short worktree `t/`, normal global setup | 0 | 24 passed |
| `41ce2a5` | Same short parent, normal global setup | 0 | 24 passed |
| Final | Long private parent exceeding socket ABI | 1 | The two adapter socket cases fail |
| `41ce2a5` | Same long parent | 1 | Same two socket cases fail |
| Final | Short parent, probe-only global setup omitted | 0 | 24 passed |
| `41ce2a5` | Same shortened probe setup | 0 | 24 passed |

`finish-socket-probe.json` preserves the argv,
test identities and errors; individual JSON/log files retain raw output. The failing sockets are **143 bytes**, beyond the Linux 107-byte usable limit, and
Node reports `EADDRINUSE` for these oversized paths. This is an
existing path-length constraint reproducible at the base, not a freshness regression.
No engine guard or committed test infrastructure was changed. The short probe config
retains ordinary per-file setup, aliases and isolation; normal global setup was also
exercised successfully in the short-root comparisons and the selected suite. An initial
probe-only run omitted the parent package/Git-discovery fences and produced six CommonJS
fixture-loader errors on both trees; the corrected probe restores the ordinary `{}`
`package.json` and `gitdir: absent` fences before running. The unfenced results are kept
in `finish-socket-probe-unfenced.json`; they are harness failures, not source regressions.

### Mutations on final source

Re-ran the two removals independently in a disposable copy of the final `src/`, `spec/`
and `config/`, with copied per-file setup and the ordinary aliases. Only global build
generation validation was disabled so the intentional source mutation could be executed.
Fixed timestamps and semantic assertions decide each result; there are no sleeps or
elapsed-time assertions in the criterion cases. `mutations.py`, `finish-mutations.json`,
the three `.diff` files and per-run raw logs/JSON preserve exact patches and argv.

| Mutation | Baseline exit | Mutated exit | Restored exit | Intended assertion |
|---|---:|---:|---:|---|
| H04: reinsert the legacy `statSync(path).mtimeMs >= Date.parse(state.startedAt)` fallback before shared terminal ownership | 0 | 1 | 0 | `spec/terminal-artifact-status.test.ts:30`: touched legacy content incorrectly creates a terminal mismatch |
| H05: replace receipt `artifactOwnership(...)` with `statSync(join(projectDir, path)).mtimeMs >= startedAtMs ? 'current' : 'stale'` | 0 | 1 | 0 | `spec/terminal-freshness.test.ts:240`: unchanged touched receipt incorrectly satisfies the floor |
| Repair check: replace `evaluation.reasonCode ?? 'terminal_unmatched'` with `'terminal_unmatched'` | 0 | 1 | 0 | Both persisted-outcome assertions at `spec/terminal-freshness.test.ts:328` lose `artifact_ownership_unverified` |

H04 and H05 each fail exactly one selected semantic assertion; the reason-code reversal
fails both terminal and receipt cases. Restored source hashes equal the final worktree,
and all restored tests pass. The disposable mutation copy was removed; production source
was never mutated in the worktree.

All command parents used `nice -n 19`, without CPU pinning. Every started probe completed
and its owned children were stopped. Full configured validation was **not** run: the
launcher runs VERIFY once after the clean commit. These are related-test results, not
an invented full-validation total.
