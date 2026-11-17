# Lifecycle event-log delivery report

## 1. Criterion evidence and validation

New runs declare `event-log-v1`. Lifecycle decisions are appended and flushed
before status-bearing caches; readers fold log bytes without writing. Legacy
runs display their snapshots until an accepted resume imports them once.
This is lifecycle replay only. Before references use local main `888cb0c`;
unprefixed references identify this delivery.

| Criterion | Verdict | Production evidence | Regression evidence |
| --- | --- | --- | --- |
| recorded-before-published | Met | `src/store.ts:1475` calls `recordRunLifecycle` before summary, snapshot and cursor. `src/run-lifecycle.ts:109` appends a decision batch; `src/append-boundary.ts:45` flushes the file, then its directory. | `lifecycle durability and failure retry`; `terminal publication`; `lifecycle crash then replay` covers all eight terminal statuses and every nonterminal producer below. |
| format-is-declared | Met | `src/store.ts:988` persists the admission declaration before the initial event, and `:998` includes it in the snapshot. `src/run-lifecycle-authority.ts:4` accepts only the closed value; log bytes, presence and times never select authority. | `records the exact declaration at admission and selects authority only from that value`; first-admission failure tests. |
| status-is-a-fold | Met | `src/run-lifecycle-fold.ts:13` has only event bytes as input. `src/run-lifecycle.ts:71` projects reads, `:80` reconciles caches under `src/store.ts:1188`'s lock. `src/store.ts:1365` fences stale whole snapshots. | `reads fold despite corrupt snapshot/cursor, without changing bytes or timestamps`; seven `reconciles on the next ... writer` cases; stale whole-snapshot regression; independent crash oracle. |
| crash-then-replay | Met | Admission fallback `src/run-lifecycle.ts:58`; log-first publication and locked reconciliation above; provenance import `:141`. | `covers EVERY consecutive write gap for ...` in `spec/lifecycle-crash.test.ts:213`: owned SIGKILL at each boundary, read every surface without writes, then open for writing and compare both caches with an independent reducer. |
| readers-do-not-write | Met | CLI `src/cli.ts:1529`, `:1617`; watch `src/watch.ts:750`; operational detail `src/cli-events.ts:362`; state view `src/run-state-view.ts:453`; UI detail `src/dashboard.ts:1128`; selected list entries use `readRunStateSafe`. | Crash-test `checkReads` hashes and compares nanosecond mtimes of snapshot, cursor and log across CLI status/list, watch, state/operational views and injected HTTP detail/list requests. SQLite candidate discovery/seeding remains permitted. |
| legacy-is-read-only | Met | `src/legacy-run-status.ts:4` is a seven-line display reader. It imports only enum resolution, returns a normalized display value, and has no transition or persistence calls. `projectRunLifecycle` branches on the recorded declaration only. | `keeps identical event bytes read-only while legacy snapshot displays differ on every surface`; characterization includes unknown status and historical `stopped`. |
| legacy-resume-imports-once | Met | `src/store.ts:1544` imports under the run lock; `src/scheduler/sched_loop/launch.ts:146`, `:176` call it before host-recovery/resume transitions. `src/run-lifecycle.ts:141` appends+flushes snapshot provenance, then records authority. | Accepted/repeated resume; legacy running recovery; interrupted file/directory fsync; complete JSON without final newline; unknown-status/layout refusals; `import-resume` and `import-short` crash cases. |
| light-tests | Met | Stub stage/provider outcomes, fixed clock in `spec/test-support/lifecycle-engine.ts:16`, stdout checkpoint/stdin acknowledgement protocol at `:86`. No backend or daemon is required. | The crash suite uses filesystem actions and event acknowledgements, never elapsed-time thresholds for its verdict. Independent order/fold mutations are described below. |


Final related invocation: **28 files / 872 tests; 872 passed, 0 failed** (`.cache/fix20/final-related-pass.json`). Crash/replay: **1 file / 23 tests; 23 passed, 0 failed** (`.cache/fix20/crash-final.json`). The per-case checkpoint output records 333 killed write gaps.

The inherited full validation of `659c7d1` reported 349 files / 5,104 tests,
5,084 passed and 20 failed; public-spec isolation reported 40 passed / 1 failed.
Those failures were deterministic. This fix does not claim that earlier report's
completion assertion. The launcher owns full declared validation and VERIFY;
neither command was run here. No full-suite total is assembled from subsets.

Build (`npm run build`), full production ESLint (zero errors, five existing
warnings) and `tsc --noEmit` passed. Builds use a byte-identical source copy inside
`.cache/fix20`, with staging in a sibling private directory; published backend/UI
payload hashes are checked by the unchanged test global setup. Test environments,
engine homes and sockets are private; all physical writes stay in this worktree.
Short fixture paths use owned aliases; the Landlock recheck uses physical paths
rather than `/proc` aliases. No timeout was increased, and no test was removed.

Both mutants built successfully in independent owned copies and each ran **all
22 parameter cases**, not a selected terminal example:

| Case | Write order reversal | First-fact fold reversal |
| --- | --- | --- |
| initialize | caught | survived |
| terminal:complete | caught | caught |
| terminal:failed | caught | caught |
| terminal:shipped | caught | caught |
| terminal:ceiling_hit | caught | caught |
| terminal:escalated | caught | caught |
| terminal:reality_gate_failed | caught | caught |
| terminal:cancelled | caught | caught |
| terminal:incomplete | caught | caught |
| pause | caught | caught |
| park | caught | caught |
| quota | caught | caught |
| validation-unfinished | survived | survived |
| resume | caught | caught |
| cancel | caught | caught |
| cancel-active | caught | caught |
| recovery-active | caught | caught |
| recovery-park | caught | caught |
| recovery-block | caught | caught |
| import-resume | caught | caught |
| terminal-short | caught | caught |
| import-short | caught | caught |

Write order moves `recordRunLifecycle` after run.json publication. The fold mutant
keeps the first versioned fact. Order is caught by 21/21 actual transitions; fold
by 20/21. Initialization has just one lifecycle event, so first and last facts
coincide: its fold survivor is expected, not a claim of mutation sensitivity.
Main removed validation-exhaustion parking; `validation-unfinished` retains that
case as a no-transition control with an explicit unfinished validation fact.
Both mutants correctly survive that control. The unrelated legacy-characterization
test is unselected in mutation runs. Raw assertions and per-case results are in
`.cache/fix20/mutant-{order,fold}.json`; there were no build or timeout failures.

The unmutated crash suite uses child write checkpoints and acknowledgments,
SIGKILL at every consecutive gap, read-only checks across all surfaces, then
locked replay of both caches. It includes the no-transition validation control.

| Case | Killed write gaps |
| --- | ---: |
| initialize | 14 |
| terminal:complete | 15 |
| terminal:failed | 15 |
| terminal:shipped | 15 |
| terminal:ceiling_hit | 15 |
| terminal:escalated | 15 |
| terminal:reality_gate_failed | 15 |
| terminal:cancelled | 15 |
| terminal:incomplete | 15 |
| pause | 10 |
| park | 10 |
| quota | 13 |
| validation-unfinished | 3 |
| resume | 10 |
| cancel | 15 |
| cancel-active | 20 |
| recovery-active | 30 |
| recovery-park | 12 |
| recovery-block | 17 |
| import-resume | 21 |
| terminal-short | 16 |
| import-short | 22 |

## 2. Lifecycle writers, publication order and bypass audit

Before: every ordinary serializer eventually used `main:src/store.ts:1443`:
summary -> run.json -> snapshot/cursor-based lifecycle observer -> cursor ->
index/campaign. The observer was also invoked for unchanged saves at `:1335`,
`:1395`, `:1547`. `main:src/run-events.ts:146` consulted the cursor and supplied
snapshot to invent observations, with no event fsync.

After: every ordinary writer takes the run lock, reconciles existing authoritative
status/cursor from the log, then applies its explicit producer decision. History
and stage metadata writes retain their existing order. Lifecycle publication is:

1. Read the log, decide whether this explicit status differs, append the versioned
   decision and any wrap-up notice, loop through short writes, fsync the log and
   fsync its parent directory.
2. For a terminal result, render and durably publish the summary.
3. Atomically write+flush run.json, including the folded cursor.
4. Atomically write+flush the sidecar cursor; then retire scratch, update index
   and campaign copies, and deliver the existing conclusion notices.

| Status producer / writer | Before -> after boundary | Transition and extra ordering |
| --- | --- | --- |
| Admission and initialization | `main:src/store.ts:959` -> `src/store.ts:973` | Reservations carry identity but no lifecycle status. Initialization durably declares authority in the reservation, then records initial `running` before either cache; newly created ancestor links are flushed. Workflow/stage directories retain their existing initialization order. |
| Ordinary terminal outcomes | `src/scheduler/sched_policy/run-completion.ts:54`, `:73`, `:84` -> `updateRunState` -> shared publication | All eight terminal enums, including validation downgrade to `incomplete`, use the same durable batch before summary/snapshot/cursor. Research and artifact policy decisions themselves are unchanged. |
| Iteration reset | `src/scheduler/sched_loop/iteration-setup.ts:181` -> `writeRunState` | Explicit `running` decision; unchanged lifecycle emits no new status event. |
| Relaunch and resume | `src/scheduler/sched_loop/launch.ts:218`, `:352` -> `updateRunState` | Legacy import precedes the transition; resume repends failed/skipped stage sidecars before the `running` lifecycle batch. |
| Deployment pause/park | `src/deployment-hold.ts:72` -> `updateRunState` | Settled-attempt check, `parked` lifecycle batch, caches. There is no separate `paused` run enum. |
| Provider-quota park | `src/scheduler/sched_settlement/stage-execution.ts:97`, `:102` -> `writeRunState` | Repend stage sidecar/aggregate, then explicit `parked` batch and caches. |
| Unfinished validation | `src/scheduler/sched_settlement/gate-validation.ts:173` | Main releases unfinished facts to review without parking; the crash control checks cache-only writes preserve the existing fold. |
| Cancellation | `src/run-control.ts:562` -> `run-completion.ts:124` -> `updateOperationalRunState` | Matching active stage ledgers close before `cancelled` batch and caches; interruption/completion notices follow. Existing terminal/unknown outcomes remain preserved. Public cancellation can now read a declared admission before run.json exists. |
| Host interruption | `src/restart-recovery.ts:106`, `:124`, `:240`, `:243` -> locked store APIs | Initial lock replay also covers early returns; recovery intent and stage-ledger settlement retain their existing evidence checks; explicit `parked` or `failed` decision precedes caches, then recovery notice. |
| Whole snapshot save | `main:src/store.ts:1508` -> `src/store.ts:1538` | Common publication; an outdated lifecycle sequence cannot reverse a newer decision. Cancellation fence remains. |
| Locked snapshot mutation and callback repeat | `main:src/store.ts:1513` -> `src/store.ts:1550`, `:1602` | Fresh log projection before mutator; all saves, including callback re-publication, route through the common boundary. |
| Operational / alternate-directory mutation | `main:src/store.ts:1526` -> `src/store.ts:1563` | Shared publication without requiring history hydration; authority cannot be silently added or removed. |
| Stage and recovery aggregate publishers | `main:src/store.ts:1640`, `:1653` -> `src/store.ts:1675`, `:1688` | Hold the same lock, then common run publication; a stage-only update cannot manufacture a new lifecycle from stale aggregate status. |
| Integrity restoration | `main:src/engine-integrity.ts:447` -> `src/engine-integrity.ts:451` | Restore log before caches, flush it before a status-bearing snapshot restore, fold status from that restored log, then reconcile both caches under lock. Opaque legacy preimages retain exact bytes. |
| Projection-only repair | New `src/run-lifecycle.ts:80`, `:101` | Flush existing log; write status and both cursors equal to its fold. No new lifecycle decision is appended. A missing wrap-up notice may be completed solely from a logged decision's structured obligation. |
| Legacy adoption | New `src/run-lifecycle.ts:141` | Append+fsync one `run_status_imported` with snapshot status/source; persist declaration+folded snapshot; persist cursor. Retry recognizes the complete import, flushes and adopts it without a duplicate. |

The audit searched all production status assignments (including object literals,
Object.assign and whole-snapshot APIs), every run.json/cursor carrier and every
`run_status_changed`/`run_status_imported` producer. Status assignments to tasks,
stages, research receipts and index rows were separated from run lifecycle.
Terminal callers across loop, admission, policy and settlement modules all call
`concludeRun`. Ordinary physical snapshot writers are the common serializer and
the projection/import helper; integrity restoration is the additional physical
writer listed above. No lifecycle observer remains. The general event API at
`src/run-events.ts:143` refuses lifecycle records, so no unflushed event publisher
can bypass the durable boundary. Static audit and actual write checkpoints are
complementary evidence; neither alone establishes every gap.

## 3. Fold, declaration, legacy display and import

`src/run-lifecycle-fold.ts:13` is the single pure reducer. It reads only supplied
UTF-8 bytes, in append order, accepting version-1 `run_status_changed` and
`run_status_imported` rows with known status and a string timestamp. Malformed or
incomplete JSON and unrelated notices contribute no status. A syntactically
complete final JSON object is accepted even before its final newline; retry
therefore cannot duplicate a complete import. It returns version-2 cache data:
sequence, status and observedAt. Timestamps do not reorder events.

The declaration is the literal `event-log-v1`, recorded at admission in the
reservation and snapshot, or after the durable legacy import. Its only decoder
is `src/run-lifecycle-authority.ts:4`. Its callers are read projection, admission
fallback, locked reconciliation, ordinary lifecycle publication/cursor writing,
legacy import, stale-snapshot protection in store, state-view admission fallback,
UI list vocabulary selection, and integrity restoration. Missing/undefined
selects legacy display; any unsupported recorded value fails closed. Layout
routing and recency ordering do not select lifecycle authority.

The legacy display module is seven physical lines, including comments/blanks.
It calls enum normalization only, preserving unknown text and the existing
`stopped` -> `cancelled` display alias. It has no filesystem import, persistence,
log read, resume, cancellation, recovery or transition function. A source import
search finds only its read-projection caller. Legacy producer decisions continue
to use the existing explicit control operations; this reader decides none.

`src/store.ts:1544` exposes the synchronous locked import. Accepted resume uses
it before any recovery or running transition, and before an accepted terminal
research re-entry returns its settled result. Refusal checks run before opening
for writing; undeclared and cancelled refusal diagnostics never open a writer. The event records
`type=run_status_imported`, `lifecycleVersion=1`, `snapshotSource=run.json`,
`snapshotStatus`, `runStatus`, run identity and timestamp. Import-event detection
is an idempotence key only; it never selects display authority. A crash before
the declaration retains legacy display. Declaration publication follows fsync;
subsequent reads and writes use only the log for lifecycle status.

## 4. Mechanisms, defects and production size

| Added or restructured production mechanism | What it replaces / why it remains |
| --- | --- |
| Durable append and shared directory fsync (`src/append-boundary.ts:16`, `src/engine-fs.ts:132`) | Refactors the existing append loop and atomic directory flush; only lifecycle appends pay fsync. Ancestor creation also flushes directory links. No high-volume diagnostic fsync was added. |
| Versioned pure fold (`src/run-lifecycle-fold.ts:13`) | Replaces mutable snapshot/cursor selection for declared runs. It reads event bytes only. |
| Closed declaration (`src/run-lifecycle-authority.ts:4`, `src/store.ts:988`) | Replaces implicit selection; stored `event-log-v1` alone chooses authority. Uses the existing admission reservation, not a second authority channel. |
| Seven-line legacy display reader (`src/legacy-run-status.ts:4`) | Replaces duplicated enum normalization in readers; no filesystem or transition operation. |
| Shared admission-aware snapshot reader (`src/run-lifecycle.ts:58`) | Replaces direct snapshot-only reads; the existing declaration-bearing reservation keeps the first durable fact readable before run.json. |
| Locked decision publication, projection and stale-snapshot fence (`src/run-lifecycle.ts:109`, `src/store.ts:1365`, `src/store.ts:1473`) | Replaces snapshot-first publication and `main:src/run-events.ts:146`'s cursor observer. Four observer hooks at main store lines 1345, 1411, 1458 and 1565 are gone. General unflushed event APIs reject lifecycle events. |
| Lock-entry replay and log-derived wrap-up completion (`src/run-lifecycle.ts:42`, `src/run-lifecycle.ts:80`) | Replaces cursor repair/backfill, retaining the existing wrap-up obligation entirely from a recorded decision. Never invents a lifecycle event from caches. |
| Provenance import (`src/run-lifecycle.ts:141`, `src/store.ts:1544`) | Replaces implicit legacy adoption with one durable import under the existing lock, after acceptance. Retry uses the import as an idempotence key, not an authority selector. |
| Log-first integrity restoration (`src/engine-integrity.ts:282`, `src/engine-integrity.ts:456`) | Replaces cache-first restoration and digest-only treatment of the authoritative log. Reuses existing preimage machinery; full carrier deletion now restores the log and caches together. Restoration verifies the staged digest. |
| Cancellation admission/replay (`src/run-control.ts:235`, `src/run-control.ts:547`) | Replaces snapshot-only target lookup and an unlocked terminal-control decision. Existing cancellation/refusal policy is retained after metadata publication settles under the existing lock. |
| Refusal boundary (`src/engine-continuation.ts:17`, `src/scheduler/sched_loop/launch.ts:59`) | Removes premature repair on a refused legacy/cancelled continuation; accepted routes already enter the import/replay lock, including settled research re-entry. |

There is no parallel cursor-observation implementation: its function, cursor
schema/dedupe construction, imports and all four call sites are deleted. Source
searches find lifecycle status event construction only at the locked decision
and explicit import boundaries. Existing status producers still use the shared
store serializer; integrity restoration is the additional physical writer.
No runtime option, flag, test-name/path/error-text rule or async store API was added.

Fix20 production defects were the refusal write before cancellation checks,
unrecoverable authoritative log after carrier deletion, and cancellation's
unlocked terminal decision in the log/cache gap. Existing regression tests stay.
Fixtures which overwrote declared facts now retain/log them; legacy fixtures
remove the declaration; filesystem probes reload setup-preloaded modules.
Integrity tests now demand trusted log restoration instead of counterfeit bytes,
and their original append read-count assertion still passes.

Physical line counts include comments/blanks in tracked `src/**/*.ts`; they
exclude every test, report, generated file and temporary source copy.

| Revision | Production files | Production lines |
| --- | ---: | ---: |
| Incoming 659c7d1 | 201 | 54,084 |
| New main 888cb0c | 198 | 54,366 |
| Rebased before Fix20 | 202 | 54,642 |
| Final | 202 | 54,655 |

Against new main: **408 added / 119 deleted production lines; net +289**,
in 21 production paths. Fix20 itself adds net 13 production lines after rebase.
The new guarantees require durable replay and an explicit historical-format
boundary which had no equivalent before; their total size does not claim a
line-for-line reduction. The net increase and restoration cost are explicit.

| Changed production module | main | Final |
| --- | ---: | ---: |
| src/append-boundary.ts | 31 | 52 |
| src/cli-events.ts | 599 | 602 |
| src/cli.ts | 1933 | 1941 |
| src/dashboard.ts | 1512 | 1513 |
| src/engine-continuation.ts | 84 | 88 |
| src/engine-fs.ts | 168 | 167 |
| src/engine-integrity.ts | 488 | 516 |
| src/legacy-run-status.ts | 0 | 7 |
| src/orchestrator.ts | 1721 | 1722 |
| src/restart-recovery.ts | 254 | 255 |
| src/run-control.ts | 558 | 562 |
| src/run-events.ts | 236 | 196 |
| src/run-lifecycle-authority.ts | 0 | 8 |
| src/run-lifecycle-fold.ts | 0 | 27 |
| src/run-lifecycle.ts | 0 | 163 |
| src/run-state-view.ts | 559 | 570 |
| src/scheduler/sched_loop/launch.ts | 384 | 389 |
| src/store.ts | 2136 | 2172 |
| src/watch.ts | 948 | 950 |

The complete diff spans about 40 paths (42); the extra paths above the original
35 are existing failing test files plus the refusal boundary. Production remains
21 paths. This task explicitly requires covering those previously skipped files.
Rebase conflicts were in store imports/fields, CLI status fields and state-view
hash/run fields; both lifecycle and main write-grant behavior were retained.
Main's review completeness and validation changes are retained, and production
Git ownership remains `src/git-facts.ts`, checked by the unchanged ownership tests.

The three append-log-specific ignore lines are removed. Two general report rules
replace both former per-directory lists, keeping tracked reports admissible to
the tracked-ignored-file check. All three archived input copies are removed from
the final worktree and never committed.

## 5. Measured durability and restoration cost

The same production primitives appended the same lifecycle JSON on this machine,
64 alternating-order pairs per mode. Values below are milliseconds; there is no
elapsed-time pass/fail threshold. File and parent-directory fsync are included.
Raw samples: `.cache/fix20/cost.json`.

| Work | Mean | Median | p95 |
| --- | ---: | ---: | ---: |
| Existing log, unflushed | 0.132 | 0.108 | 0.241 |
| Existing log, durable | 15.125 | 14.648 | 21.988 |
| New log, unflushed | 0.200 | 0.134 | 0.368 |
| New log, durable | 16.689 | 16.226 | 22.101 |

Added mean: 14.993 ms existing / 16.489 ms new. This excludes lock, fold, summary,
cache and index work; it does not add diagnostic flushing.

Restoration has a measured cost too: eight runs of the same guard over a fixed
4 KiB log and 32 identical diagnostic appends averaged **93.515 ms before /
179.250 ms after** (about 2.679 ms added per guarded append in this probe).
Only integrity code differs between the probe copies. The exact existing
2-prefix-read append assertion remains unchanged and passes; retained preimages
add clone/write work, not another full-prefix hash on each append. This cost
buys restoration after total carrier deletion; a digest cannot recover deleted
bytes. It reuses the existing preimage implementation and adds no log fsync.
These are loaded-machine observations, not a performance improvement claim.
Raw samples/scripts are under `.cache/fix20/integrity-*.json` and
`.cache/fix20/benchmark-integrity.mjs`.

## 6. GAP-REPORT corrections and next-slice contract

Sections 1–5 correctly describe the old stores as coordinated mutable authorities:
snapshot-first lifecycle publication, cursor-based event invention, unflushed
appends, index seeding on listing and separate stage/history/evidence/checkpoint
facts. Source tracing verified those claims; no correction to those baseline
claims was found. Their line numbers refer to an older baseline and must not be
used as delivered-tree references. This work did not rerun the historical
20-run census, six interrupted-attempt comparison or four original kill probes,
and does not claim their inherited measurements as new results.

Changed by this slice: lifecycle status and its cursor are now projections for
explicitly declared runs; locked recovery first replays those facts. This does
not replay stage attempts, plan/query state, validation, task queues, research
journals, notifications or the index. A log-first terminal decision can be visible
before summary/campaign/completion notices; consumers must not equate status
visibility with delivery of every later artifact. Existing terminal policy and
artifact-freshness producers were deliberately retained.

Later slices can use the stable declaration, versioned lifecycle event types,
pure fold/cursor contract and lock-entry repair boundary. Index discovery/status
columns may lag and existing seeding remains unchanged; a selected detail must
fold again. Stage and task work must not reconstruct lifecycle decisions from
these caches. Preserve unknown legacy status/layout refusals and the import's
provenance/idempotence. The full thin-engine design remains future work.

## 7. Deployment and rollback

The finisher did not operate the daemon, production store or operator socket.
At deployment the operator should stop or drain old writers before starting the
new build: the older engine is not aware that run.json and the cursor are caches.
Build the intended source generation, then switch the runtime through the
operator's normal deployment process. No eager migration is required. Existing
undeclared runs retain read-only snapshot display; accepted resume imports one
run at a time under its lock. New admissions declare authority immediately.

For rollback, stop the new writers and preserve complete run directories,
especially events.jsonl and declaration/import provenance. Reverting binaries
alone is unsafe for already-declared runs: old code would resume snapshot-first
publication and ignore leading log facts. Use the previous engine only with
undeclared runs or a consistent pre-deployment copy of its store. Continuing a
new-format run on old binaries needs a separate, explicit migration; deleting the
declaration or truncating events is not a supported rollback. The task does not
add a compatibility flag or operate that migration.
