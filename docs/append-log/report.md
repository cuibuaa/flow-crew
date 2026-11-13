# Lifecycle event-log delivery report

## 1. Criterion evidence and validation

The lifecycle decision is recorded durably before publication. New runs declare
`event-log-v1`; old runs retain snapshot display until an accepted resume imports
that snapshot once. This covers lifecycle status only, not complete run replay.
References without a revision identify this delivered tree. Before references use
local `main` at `ad94786`.

| Criterion | Verdict | Production evidence | Regression evidence |
| --- | --- | --- | --- |
| recorded-before-published | Met | `src/store.ts:1457` calls `recordRunLifecycle` before summary, snapshot and cursor. `src/run-lifecycle.ts:109` appends a decision batch; `src/append-boundary.ts:45` flushes the file, then its directory. | `lifecycle durability and failure retry`; `terminal publication`; `lifecycle crash then replay` covers all eight terminal statuses and every nonterminal producer below. |
| format-is-declared | Met | `src/store.ts:979` persists the admission declaration before the initial event, and `:988` includes it in the snapshot. `src/run-lifecycle-authority.ts:4` accepts only the closed value; log bytes, presence and times never select authority. | `records the exact declaration at admission and selects authority only from that value`; first-admission failure tests. |
| status-is-a-fold | Met | `src/run-lifecycle-fold.ts:13` has only event bytes as input. `src/run-lifecycle.ts:71` projects reads, `:80` reconciles caches under `src/store.ts:1178`'s lock. `src/store.ts:1355` fences stale whole snapshots. | `reads fold despite corrupt snapshot/cursor, without changing bytes or timestamps`; seven `reconciles on the next ... writer` cases; stale whole-snapshot regression; independent crash oracle. |
| crash-then-replay | Met | Admission fallback `src/run-lifecycle.ts:58`; log-first publication and locked reconciliation above; provenance import `:141`. | `covers EVERY consecutive write gap for ...` in `spec/lifecycle-crash.test.ts:211`: owned SIGKILL at each boundary, read every surface without writes, then open for writing and compare both caches with an independent reducer. |
| readers-do-not-write | Met | CLI `src/cli.ts:1528`, `:1615`; watch `src/watch.ts:750`; operational detail `src/cli-events.ts:362`; state view `src/run-state-view.ts:452`; UI detail `src/dashboard.ts:1127`; selected list entries use `readRunStateSafe`. | Crash-test `checkReads` hashes and compares nanosecond mtimes of snapshot, cursor and log across CLI status/list, watch, state/operational views and injected HTTP detail/list requests. SQLite candidate discovery/seeding remains permitted. |
| legacy-is-read-only | Met | `src/legacy-run-status.ts:4` is a seven-line display reader. It imports only enum resolution, returns a normalized display value, and has no transition or persistence calls. `projectRunLifecycle` branches on the recorded declaration only. | `keeps identical event bytes read-only while legacy snapshot displays differ on every surface`; characterization includes unknown status and historical `stopped`. |
| legacy-resume-imports-once | Met | `src/store.ts:1528` imports under the run lock; `src/scheduler/sched_loop/launch.ts:144`, `:174` call it before host-recovery/resume transitions. `src/run-lifecycle.ts:141` appends+flushes snapshot provenance, then records authority. | Accepted/repeated resume; legacy running recovery; interrupted file/directory fsync; complete JSON without final newline; unknown-status/layout refusals; `import-resume` and `import-short` crash cases. |
| light-tests | Met | Stub stage/provider outcomes, fixed clock in `spec/test-support/lifecycle-engine.ts:16`, stdout checkpoint/stdin acknowledgement protocol at `:87`. No backend or daemon is required. | The crash suite uses filesystem actions and event acknowledgements, never elapsed-time thresholds for its verdict. Independent order/fold mutations are described below. |

Validation records (runner totals, without constructing a full-suite total):

- Initial related-file invocation: 26 files / 631 tests: 628 passed, 3 failed
  in the two integration files subsequently repaired and rechecked below.
- After repairing the failing integrations: 4 files / 282 tests passed, including
  all lifecycle unit regressions, all 137 integrity tests, all 94 Git fact tests
  and all 19 terminal-publication tests.
- Additional daemon/status readers: 2 files / 19 tests passed.
- Changed-source ESLint: zero errors; two existing cli.ts warnings, on the
  unchanged workflow assignment and unused printGuideUsage helper.
- Final build passed; every copied input/output hash matched the delivered tree.

Both deliberate mutations ran in an isolated copy inside the worktree, after a
successful build of each mutant. The unchanged crash test
`covers EVERY consecutive write gap for terminal:failed` rejected both:

| Mutation | Result | Independent assertion |
| --- | --- | --- |
| Move recordRunLifecycle after run.json publication | Exit 1; 1 test failed, 22 unselected | `spec/lifecycle-crash.test.ts:105`: cache `failed`, event oracle `running` at the cache write. |
| Fold only the first lifecycle event | Exit 1; 1 test failed, 22 unselected | `spec/lifecycle-crash.test.ts:98`: production sequence/status `1/running`, independent oracle `2/failed` after the event append. |

An initial draft of the second mutation did not typecheck and was not counted;
the tested mutation typechecked, built and then failed the actual crash assertion.
Both temporary source mutations were restored; neither was applied to delivery.

The crash file passed all 23 tests: 22 transition cases, 340 owned
SIGKILL gaps, plus the identical-log/different-legacy-display case. No elapsed-time
timeout failed. Recorded gaps by transition:

| Transition | Gaps checked |
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
| validation-park | 10 |
| resume | 10 |
| cancel | 15 |
| cancel-active | 20 |
| recovery-active | 30 |
| recovery-park | 12 |
| recovery-block | 17 |
| import-resume | 21 |
| terminal-short | 16 |
| import-short | 22 |

The complete declared validator/VERIFY command is deliberately left to the task
launcher, as required by the task's final instruction. The finisher runs only
related tests and does not claim full-suite validation.

Builds use `npm run build` on a byte-identical source copy inside ignored scratch.
This satisfies the task's write boundary while respecting the existing guard
against staging beneath that build's source root. Backend/UI payloads are copied
back and `assertDistFresh` checks every current input and published output hash
before tests. The first direct build correctly refused overlapping staging; its
source and guard were not changed. Temporary copies, logs and results remain
untracked under `.cache/finish/`.

## 2. Lifecycle writers, publication order and bypass audit

Before: every ordinary serializer eventually used `main:src/store.ts:1427`:
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
| Admission and initialization | `main:src/store.ts:950` -> `src/store.ts:964` | Reservations carry identity but no lifecycle status. Initialization durably declares authority in the reservation, then records initial `running` before either cache; newly created ancestor links are flushed. Workflow/stage directories retain their existing initialization order. |
| Ordinary terminal outcomes | `src/scheduler/sched_policy/run-completion.ts:54`, `:73`, `:84` -> `updateRunState` -> shared publication | All eight terminal enums, including validation downgrade to `incomplete`, use the same durable batch before summary/snapshot/cursor. Research and artifact policy decisions themselves are unchanged. |
| Iteration reset | `src/scheduler/sched_loop/iteration-setup.ts:181` -> `writeRunState` | Explicit `running` decision; unchanged lifecycle emits no new status event. |
| Relaunch and resume | `src/scheduler/sched_loop/launch.ts:216`, `:352` -> `updateRunState` | Legacy import precedes the transition; resume repends failed/skipped stage sidecars before the `running` lifecycle batch. |
| Deployment pause/park | `src/deployment-hold.ts:72` -> `updateRunState` | Settled-attempt check, `parked` lifecycle batch, caches. There is no separate `paused` run enum. |
| Provider-quota park | `src/scheduler/sched_settlement/stage-execution.ts:97`, `:102` -> `writeRunState` | Repend stage sidecar/aggregate, then explicit `parked` batch and caches. |
| Validation-resource park | `src/scheduler/sched_settlement/gate-validation.ts:189`, `:193` -> `updateRunState` | Existing validation evidence first; explicit `parked` batch before lifecycle caches. |
| Cancellation | `src/run-control.ts:559` -> `run-completion.ts:124` -> `updateOperationalRunState` | Matching active stage ledgers close before `cancelled` batch and caches; interruption/completion notices follow. Existing terminal/unknown outcomes remain preserved. Public cancellation can now read a declared admission before run.json exists. |
| Host interruption | `src/restart-recovery.ts:106`, `:124`, `:240`, `:243` -> locked store APIs | Initial lock replay also covers early returns; recovery intent and stage-ledger settlement retain their existing evidence checks; explicit `parked` or `failed` decision precedes caches, then recovery notice. |
| Whole snapshot save | `main:src/store.ts:1492` -> `src/store.ts:1522` | Common publication; an outdated lifecycle sequence cannot reverse a newer decision. Cancellation fence remains. |
| Locked snapshot mutation and callback repeat | `main:src/store.ts:1497` -> `src/store.ts:1534`, `:1602` | Fresh log projection before mutator; all saves, including callback re-publication, route through the common boundary. |
| Operational / alternate-directory mutation | `main:src/store.ts:1510` -> `src/store.ts:1547` | Shared publication without requiring history hydration; authority cannot be silently added or removed. |
| Stage and recovery aggregate publishers | `main:src/store.ts:1622`, `:1653` -> `src/store.ts:1657`, `:1688` | Hold the same lock, then common run publication; a stage-only update cannot manufacture a new lifecycle from stale aggregate status. |
| Integrity restoration | `main:src/engine-integrity.ts:447` -> `src/engine-integrity.ts:447` | Restore log before caches, flush it before a status-bearing snapshot restore, fold status from that restored log, then reconcile both caches under lock. Opaque legacy preimages retain exact bytes. |
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

`src/store.ts:1528` exposes the synchronous locked import. Accepted resume uses
it before any recovery or running transition. The event records
`type=run_status_imported`, `lifecycleVersion=1`, `snapshotSource=run.json`,
`snapshotStatus`, `runStatus`, run identity and timestamp. Import-event detection
is an idempotence key only; it never selects display authority. A crash before
the declaration retains legacy display. Declaration publication follows fsync;
subsequent reads and writes use only the log for lifecycle status.

## 4. Removed/added mechanisms, defects and size

Removed: cursor/snapshot-based observation/backfill in
`main:src/run-events.ts:146`, and its four ordinary/no-op save hooks in store.
Replaced: mutable lifecycle selection in status/watch/details with a bytes-only
fold and lock-entry cache reconciliation. Added: lifecycle-only durable append,
closed declaration reader, required legacy reader/import, and admission fallback.
No feature flag retains the old observer. High-volume event appends stay unflushed;
store public signatures stay synchronous. The separate reducer/declaration/legacy
modules keep lifecycle policy out of the already-large store.

The net source increase is necessary for the durable boundary, pure replay,
explicit historical-format policy and their failure/retry cases, which had no
previous equivalent. It replaces the old observation mechanism; stage/index/task
replay, extra authority channels and new runtime options were not added.

The independent finish review reproduced and fixed three inherited defects:

- Public cancellation returned RUN_NOT_FOUND after the first lifecycle event but
  before run.json. `src/run-control.ts:544` now uses the same declaration-bearing
  admission fallback as readers. New test: `cancels through the public coordinator
  after the first event but before the first snapshot`.
- Operational mutations could silently add authority to a legacy snapshot without
  import. `src/run-lifecycle.ts:112` now rejects that adoption at the common
  boundary, before appending. New test: `refuses authority adoption by an
  operational mutation without the resume import`. Both new tests failed against
  the inherited implementation and passed after the fixes.
- Integrity restoration unconditionally parsed every snapshot preimage as JSON,
  leaving a corrupted replacement in place for opaque legacy bytes.
  `src/engine-integrity.ts:469` now preserves those preimages byte for byte and
  folds only declared JSON records. Existing regression: `voids a successful
  child overwriting run.json`.

Two integration fixtures were also corrected without changing production policy:
`spec/engine-integrity.test.ts:630` retains admission facts when appending a
concurrent parent diagnostic; `spec/git-facts.test.ts:271` checks that summary Git
termination still propagates synchronously and leaves snapshot bytes unchanged,
while the preceding logged decision remains readable. Its held-Git retry now
publishes actual conclusion metadata: replay makes a pure status-only retry a
no-op. Neither failure was a timeout, and no timeout was extended.

Production physical-line counts use tracked `.ts` files beneath src, including
comments/blanks, comparing local main with delivery. Source-only temporary copies
are excluded. The total is 197 -> 201 source files and 53,808 -> 54,084 physical source lines
(net +276). Module counts:

| Module | Before | After |
| --- | ---: | ---: |
| src/store.ts | 2,112 | 2,148 |
| src/run-events.ts | 236 | 196 |
| src/append-boundary.ts | 31 | 52 |
| src/engine-fs.ts | 168 | 167 |
| src/engine-integrity.ts | 488 | 512 |
| src/run-lifecycle.ts | 0 | 163 |
| src/run-lifecycle-fold.ts | 0 | 27 |
| src/run-lifecycle-authority.ts | 0 | 8 |
| src/legacy-run-status.ts | 0 | 7 |

The delivery changes 35 paths including this report, below the approximate
40-file bound.

The initial inherited implementation was committed unchanged before rebase. The
rebase resolved only leading import conflicts in dashboard and orchestrator,
retaining both lifecycle imports and main's Git owner imports. All production Git
execution still uses `src/git-facts.ts`; its source-ownership test is retained.
The ignore file now permits only this report beneath docs/append-log, leaving all
three frozen inputs untracked and ignored.

## 5. Measured durable-append cost

The actual production primitives `appendTextRecord` and
`appendDurableTextRecord` appended the same versioned lifecycle JSON record on
the same worktree filesystem. Each mode has 64 alternating-order pairs. Existing
files were created and flushed before sampling; new-file samples use unique
names in an already-created directory. The durable primitive includes file and
parent-directory fsync in both modes. Native monotonic measurements impose no
pass/fail duration threshold.

| Work | Mean ms | Median ms | p95 ms |
| --- | ---: | ---: | ---: |
| Existing log, unflushed | 0.315 | 0.190 | 0.554 |
| Existing log, durable | 20.300 | 14.670 | 24.364 |
| New log, unflushed | 0.214 | 0.186 | 0.434 |
| New log, durable | 15.227 | 13.451 | 21.257 |

Added mean cost: 19.985 ms for an existing log, 15.013 ms for a new one. The machine
was loaded; these are observations, not a claim that first creation is faster.
The benchmark excludes lock acquisition, ancestor creation, fold scanning,
summary rendering, snapshot/cursor writes and index work. A terminal lifecycle
batch includes its wrap-up notice in the same flush. The measurement script and
raw per-sample milliseconds are retained in ignored finisher scratch, alongside
the test logs. No operator data or backend was used.

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
