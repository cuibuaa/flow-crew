# Operations

For an operator: how do I prepare, inspect, steer and preserve engine work?
Command syntax belongs to [CLI](cli.md); typed stage requests belong to [agent protocol](agent-protocol.md).

## Identities and lifecycle

A daemon **task** has a numeric registry ID. A **run** has its own persistent identity and
stage graph. A stage **execution** is one attempt under a deadline; a gate **re-evaluation**
is a separate counter. A **campaign** groups run history. A conversation **ledger entry**
expresses human wrap-up intent and may link to an exact daemon task; it is optional.

| Run status | Meaning |
|---|---|
| `pending` | Queued, not executing |
| `running` | Executing; inspect process identity as well as stored status |
| `parked` | Paused for a decision or proven resumable interruption; not terminal |
| `complete` | Successful terminal engineering completion |
| `shipped` | Successful terminal research ship decision |
| `ceiling_hit` | Successful process-level research ceiling; not a metric win |
| `failed`, `reality_gate_failed` | Terminal execution/check failure |
| `escalated` | Terminal unresolved or irreparable outcome |
| `cancelled` | Terminal explicit stop; compatible settled work requires explicit resume |
| `incomplete` | Terminal insufficient completion |

Archived `stopped` is read as `cancelled` without rewriting the archived record.
Unknown archived status values remain unknown; consequential actions refuse inferred semantics.
Stages separately use pending/running/complete/failed/skipped. A daemon task can be pending,
deferred, running, cancelling, done, stuck, needs_summary, cancelled, failed or reality_gate_failed.
Deferred does not mean rejected; cancelling does not prove that children have closed.

The daemon serializes tasks by canonical project guard and queues conflicts; different projects
can run concurrently. A parked run releases its execution slot. A foreground quick run also
uses the project lock. Do not edit an active run's project: scope restoration cannot distinguish
an unrelated human edit from every stage-caused change.

Sources: [lifecycle vocabulary](../src/lifecycle-status.ts), [task registry](../src/task-registry.ts),
[orchestrator](../src/orchestrator.ts), [run lock](../src/run-lock.ts).

## Setup validation

`ship-preflight` gathers prior-run/campaign/input/output/build facts and discovers validation
commands. It runs no project build, test or lint.
Exit zero means collection completed, not that launch is ready.

`ship-setup` requires the exact brief, source project, base, new branch and target. It checks
source/base inputs, creates or proves the reusable managed worktree, materializes missing
input descendants and compares target content. Target-owned copies of regular files/directories
isolate target writes; internal
links are relocated within the target tree. Existing target entries resolving outside it or
content/type collisions refuse. Do not replace a refusal with manual source symlinks.

Setup discovers validation from configuration or the brief's explicit argv declarations.
It executes the target baseline under the configured command bound and writes a ready record
bound to the exact brief digest and canonical target. A failed setup can leave a diagnostic
worktree; it does not publish a ready record for a blocker.

Ordinary red checks can establish `no_regression_from_baseline`. Failure extraction uses
complete joined output before bounding persisted text. Complete structural TAP and recognized
FAIL/FAILED, cross-mark and compiler diagnostic lines can supply identities. Truncated recovered
identities are partial lower bounds. Partial red-to-red comparisons stay unresolved;
green-to-red needs a known complete failure inventory to establish regression; unknown/partial
current failures stay unresolved. Red-to-green passes. If both baseline and current results
cannot run or fail without identifiable failures, the delta passes and the gate judges its own
checks. Missing/unlaunchable tools are environment problems; inspect the record's readiness and reasons rather than
assuming every nonzero child exit has the same setup outcome.

Exit 127 is not universally a refusal: an unlaunchable brief-declared command or a project
whose commands cannot launch blocks readiness. A discovered missing command can remain an
environment gap when other commands launch; a runner inferred only from a legacy INI file
can remain a gap even when nothing launches. Inspect provenance, not just the exit number.

Sources: [preflight](../src/cli-ship-preflight.ts), [setup](../src/cli-ship-setup.ts),
[validation and deltas](../src/project-validation.ts),
[gate validation](../src/scheduler/sched_settlement/gate-validation.ts).

### Storage ownership

Setup's independent input copies protect the source even when a subprocess writes its local
input. A read-only declaration or a later hash check cannot provide that protection through a
hardlink. Before creating a worktree or copying declared inputs, setup estimates the additional
input bytes, deduplicated by destination, and calls `disk-guard need <bytes>` once for a nonempty
copy budget. The executable is resolved from `~/bin/disk-guard`, then `PATH`; a missing tool,
failed estimate or refused admission blocks setup before copying. Capacity policy belongs to
disk-guard, with no FlowCrew threshold or bypass flag. Existing target files need no additional
copy budget. Sparse files and reflinks count their full logical size.

This admission covers setup's declared input copies. Git checkout growth and ordinary engine
copies, archives and restores do not invoke disk-guard. Admission is a check, not a reservation;
concurrent materializers must coordinate their budgets. An input-copy failure still refuses
setup without publishing READY; inspect available space and the reported target before retrying.
Failures after admission can leave partial copies.

Use invocation `$TMPDIR` for disposable checkouts, compiler caches and test fixtures.
Invocation scratch survives within an active run, then is retired at terminal publication,
including failed, incomplete and cancelled outcomes. Resume uses retained unfinished stage
work and allocates fresh invocation scratch. Daemon startup removes temporary aliases of
deleted run folders without entering retained runs. It does not compact historical runs or
recursively retire scratch. Use explicit `prune --apply` for interrupted retirement in
recorded runs; `clean` also retires scratch of runs with missing `run.json`, while preserving
their other files and leaving malformed records untouched. `clean` deletes old run history.

Compiler output and caches belong in invocation `$TMPDIR`. Copy declared final products
and evidence to their declared run-relative paths before the command ends. Historical
`stages/<stage>/build/` and `stages/<stage>/scratch/` trees are durable history: the engine
no longer scans citations or compacts these directories. Declared products remain readable
after terminal settlement. Undeclared scratch content retires with the run.

Interrupted scratch retirement does not require a surviving temporary alias: `prune --apply`
uses the recorded run's physical scratch root, and `clean` retires it when deleting old
history. This also handles a reboot that wipes temporary aliases. Retained runs can be
pruned individually without deleting their history; daemon startup never walks the runs root.
Park/deployment holds and uncertain process ownership still prevent pruning. Retention
sends no signals and never reverts project changes.

For existing runs, inspect the same policy before applying it:

```bash
flowcrew prune --dry-run
flowcrew prune --run <run-id> --dry-run --json
flowcrew prune --run <run-id> --apply
```

The default is a read-only dry-run: no lock, index, manifest, alias or store file is written.
It reports per-run bytes and kept paths/reasons; JSON includes the candidate file list,
refusals and total bytes. Counts are logical file lengths, not filesystem free-space
promises (hardlinks, compression and metadata can differ). Bulk operation skips refused
runs and uninitialized store entries; an explicitly selected refused run exits nonzero.
Apply replans under the run-state lock shared with launch, resume and cancellation.
Repeated application is safe. `clean` separately deletes old run history; `prune` keeps it.
Retained artifacts intentionally continue to consume space; pruning only retires invocation scratch.

Sources: [input materialization](../src/cli-ship-setup.ts),
[retention policy and CLI](../src/run-retention.ts),
[scratch owner](../src/invocation-scratch.ts), [terminal publisher](../src/store.ts).

## Inspect, guide and stop

`status` selects the latest run for the current project; `--all` selects across projects.
`task show` reads daemon detail. `state` reads admitted plan/attempt/artifact/evidence facts;
`--summary` bounds the projection and `--prompts` includes retained immutable invocation inputs.
An observation grants neither permission nor a pass. Older `input.md` aliases cannot reconstruct
every historical retry or hidden provider instruction.

`events` reads the canonical feed; `watch` gives a first heartbeat and edge-triggered stalls,
drift and evidence gaps. Watch reports terminal indecision after its quiet grace and rejected
gate plateau/regression using bound numeric history. It is an operator observer, separate from
the deterministic stage watchdog described in [architecture](architecture.md#deadlines-and-idle-progress).
No watcher opinion establishes that a model result is correct.

`guide` writes to a named running run and optional stage. Without a run ID it refuses unless
exactly one readable run is executing. Guidance targets the selected stage or explicit run-wide
`*`; workers consume filtered envelopes at command boundaries. `interrupt` requests a stop of
the exact active stage command and delivers its reason as guidance. Neither resets the attempt
deadline. Changes to admitted criteria or authority need revised brief bytes and admission.

Use daemon `task cancel` or the dashboard Cancel control to stop registered work. Cancellation
records the operator decision and closes active control state before bounded worker cleanup.
Unknown process evidence is retained in the cancellation result and task notes; it neither
vetoes cancellation nor authorizes a signal. A retained running marker alone proves neither
life nor death. Use `task resume` or the adjacent dashboard Resume control to continue a
compatible cancelled, failed or incomplete registered run after settlement.
Cancellation alone grants no automatic continuation. A task retry requests another launch attempt;
after terminal settlement it starts a fresh run. Foreground operation stays attached to the
caller; process supervision and hard-kill limits are in
[architecture](architecture.md#process-supervision-and-recovery).

Sources: [state](../src/run-state-access.ts), [status/guide/interrupt](../src/cli.ts),
[events](../src/cli-events.ts), [watch](../src/watch.ts),
[cancellation](../src/cancellation-policy.ts), [task CLI](../src/cli-task.ts).

## Approvals

Human approval supplies authority outside the run: other repositories, credentials,
outward network effects, deletion of user data, shared devices, or git history outside
the run branch. Admitted writes, private scratch, run-local tool environment setup and
framework-owned isolated validation proceed under their existing execution owners.
Contract errors receive engine decisions; approval cannot override engine ownership or frozen-input protections.

A worker that needs external authorization writes one request to its injected stage slot
`stages/<id>/approval_request.json` and stops before the action. Required fields are `id`
(or alias `requestId`), nonblank `action`, and `risk: external`; `target`, `title`, `body`
describe the external effect and exact authority needed. IDs match `[A-Za-z0-9._-]{1,64}`.
The stage slot determines the requesting stage, even if its JSON names another stage.

Legacy exec/write/unknown requests receive a deterministic answer without parking.
A target physically inside the requesting stage's run subtree, excluding engine records,
acknowledges existing scratch authority. Symlinks, traversal, another stage's work and
engine records cannot expand it. Other non-external requests are denied: use the existing
execution/scope mechanism, or explicitly describe an external effect with `risk: external`.
Refusal of this grant leaves existing admitted capabilities unchanged. The answer grants
no device, credential or network authority. Engine answers use the same
append-only decision transport and identify their source as the scheduler.

The scheduler watches active batches as well as inspecting completed ones. It persists the
request, chooses the oldest unresolved external item, parks the run without `completedAt`, suspends
workers and closes children before releasing ownership. Requests are idempotent by run and
ID; resolutions are append-only, first-responder-wins. The decision is projected at
`approvals/<id>.decision.json`; read it before acting. An external approval authorizes
that effect; its denial forbids it. An engine answer changes no existing capabilities.

CLI approve and deny both resume a parked run through daemon registration by default,
preserving run/DAG/iteration identity. `--no-resume` records a decision without relaunch.
Resume still checks brief admission. Standing rules, `--always`, `rules` and `revoke` are
retired. Root request variants remain historical compatibility inputs. Full shell access
means this request protocol is not a host-wide interception of arbitrary side effects.

Exhausted research gates use their admitted escalation terminal owner. Without that owner,
the run finishes incomplete with the failing criteria and missing-owner evidence. It does
not ask a person to repeat the gate decision. Proven resumable host interruptions retain their
orchestration checkpoints without requesting human approval.

Cancellation closes active control state as `cancelled` and attempts to stop its owned
workers. It acknowledges a terminal decision; task notes report any unresolved process
evidence. Daemon restart, recovery and deployment release leave that cancellation cancelled.
Explicit resume can continue safely settled work after ownership and compatibility checks.
Use the deployment hold below to let current stage work settle normally before deployment.

Explicitly continue a registered task's cancelled, failed or incomplete run by task ID:

```bash
flowcrew task resume <task-id>
```

The daemon launches a scheduler for that run. Failed stages receive a new attempt,
whether the earlier attempt executed or was refused before execution. Skipped
stages become runnable again and their conditions are checked anew. Completed
authoring and planning stages, attempt history, the admitted workflow and plan,
and the remaining iteration budget are preserved. Pending stages continue when
their dependencies are ready. An incomplete run with a completed nonpassing gate
reopens that gate in the next iteration; further rejection uses the admitted repair
route. Resume reports exhausted iteration budget before queuing work. Cancelled or
failed work continues in its interrupted iteration without replenishing repair rounds.
An unfinished repair continues its admitted gate round; the related gates review
the new repair without restarting earlier authoring or planning work.
The task registry supplies the run ID and project directory; the dashboard Resume
control beside Cancel requests the same continuation. Resume still checks brief
admission, scheduler ownership, persisted execution compatibility and unresolved approvals.
Only explicit continuation resumes cancelled work.
Cancellation settles interrupted attempts and their stage ledgers. Resume requires settled execution records; it refuses unfinished attempts left by an older cancellation without rewriting them. Archived `stopped` records remain readable as `cancelled`.
`flowcrew task retry <task-id>` requests another launch attempt:
before terminal settlement it retains any existing run binding, and after settlement
it starts a fresh run with a new plan, stage history and iteration budget. Retry does
not resume cancelled work. Parked approval requests use the Inbox decision controls.

For a run without a registered task, the existing continuation command remains
`flowcrew quick --background --project <project-dir> --existing-run-id <run-id>`.
Omit `--background` to continue that run in the foreground.

Sources: [inbox](../src/inbox.ts), [request paths](../src/approval-artifacts.ts),
[active monitoring](../src/scheduler/sched_policy/approvals.ts), [decision CLI](../src/cli-inbox.ts),
[continuation admission](../src/scheduler/sched_loop/launch.ts), [daemon queue](../src/orchestrator.ts).

## Deploy while tasks are in flight

**First upgrade across the RPC command/reply change (0.11.0):** use
`daemon hold` (old CLI) → `daemon stop` (old CLI) → build → `daemon start`
(new CLI) → `daemon continue` (new CLI). Run each as a separate invocation from
the deployment checkout, using the same `FC_HOME` and socket throughout:

```bash
flowcrew daemon hold       # old CLI: require exit 0 and ready: true
flowcrew daemon stop       # old CLI: wait for old daemon/socket retirement
npm run build              # daemon stopped; publishes the new CLI and daemon
flowcrew daemon start      # new CLI: require verified startup
flowcrew daemon continue   # new CLI: require released: true and no errors
```

Stop at any refusal or unknown outcome and inspect state before retrying. The old CLI's
`daemon deploy` cannot read the new daemon's `{ok:true,result}` replies; renamed RPC
commands have no compatibility aliases. New-client cancel requests to a still-running
old daemon fail as not-found until restart. The durable hold remains active across the
stop/build/start boundary. Once both CLI and daemon use the new protocol, use the regular
`daemon deploy` procedure below.

Use an engine with `daemon deploy` support for this procedure. Upgrading an older engine
that lacks the command still requires retiring its consumers first. Select the same
`FC_HOME` and daemon socket for every command. The hold is durable in that state root,
survives daemon restart, and fences both registered launches and foreground schedulers.

```bash
flowcrew daemon deploy --timeout-ms 60000
flowcrew task show <task-id>
```

Invoke the CLI from the authorised deployment checkout: its runtime location selects the
build target, independently of the shell's current directory. Deployment requests a hold,
waits for settlement, checks restart safety, stops the daemon, publishes a complete build
and starts the new daemon. It proves the RPC identity, Unix socket owner, `daemon.json`
and published generation agree before continuing held runs. `--timeout-ms` bounds the
hold wait; it does not cancel stages or impose a build deadline.

Builds publish real `dist/` and `ui/dist/` directories, including the hidden build
manifest. Ordinary tar archives and npm packages therefore contain portable files.
Daemon startup snapshots the attested backend/UI and configuration into
`runtime/.cache/build-generations/<generation>` beside its socket, then loads the
physical runtime path. Rebuilds only replace the checkout outputs; the daemon and
its later imports, including scheduler children, keep that runtime. Current and
previous daemon generations are retained. Before migrating a daemon started by
an older release directly from the checkout, stop it once before rebuilding.

On failure the command reports its step and the durable hold state. Retry with the same
`FC_HOME`, socket and checkout. If no daemon is listening, deploy starts the last published
generation and settles the existing hold again before rebuilding. No transaction receipt or
lock needs manual recovery. A lost continuation reply can mean the hold was already released;
verify tasks before retrying. `deploy --force` refuses to bypass restart safety.

Readiness observes active tasks and runs carrying this hold's id. Historical fixture tasks
outside that set do not block deployment. Relevant units, schedulers and checkpoint-owned
commands must be stopped; an unavailable manager or ambiguous owner refuses readiness.
The daemon itself remains live until the stop step. `start` waits for its own child to
become verifiably ready or exit, and reaps that child on failure. `serve` binds before
reading the registry or running store maintenance, so a second serve exits immediately.

A hold waits for the already admitted group to settle: ordinary disjoint peers finish
together; a gate repair round includes its serialized repair waves, evidence settlement
and gate re-evaluation. Scope continuations and technical retries already inside that group
use their ordinary bounds. The scheduler then parks before admitting another group or
iteration. Completed stages and their artifacts, attempt ledgers, admitted plan, rollback
audits, gate rejection evidence and budgets are retained. This does not checkpoint a live
process. No attempt is killed to obtain a deployment hold. A stage budget first requests
wrap-up; its hard stop uses TERM/5-second grace/KILL and retains a continuation with work
kept. Idle aborts, unsafe writes and unverified child closure keep their refusal semantics.

There is no finite universal successful-hold bound: stage deadlines differ, groups may have
several bounded attempts, and audit/validation cleanup may itself fail to settle. For a
single running attempt, the wait includes its remaining immutable deadline, up to 5 seconds
of termination grace, then owned command closure and settlement. Both `hold --timeout-ms N`
and deploy's hold phase bound the settlement polling window (default 60 seconds), plus at
most the initial 2-second RPC timeout. A missing response can report unknown delivery.
Exit 1/2 or `ready: false` leaves the fence active: current work continues to its normal
boundary, and no timeout fallback cancels it. Inspect `hold-status`, resolve any refusal,
and retry deploy with the same target. If abandoning the deployment before stopping the
daemon, wait for settlement and use `continue` on the existing build.

After restart, the latch still blocks queued tasks. `continue` validates every eligible
held run before releasing launch authority. Any incompatible run becomes `stuck` and keeps
the global hold and compatible peers parked. Repair the refusal and retry: held runs are
revalidated and their refusal is cleared only on successful admission. Explicit cancellation
excludes that task without reviving it. Queue writes happen under the active latch; an
interruption remains retryable. Repeated continuation does not grant attempts twice.
Approval parks still require their own decisions; cancellation takes precedence. Task
launch retry budgets are not charged for the hold.
If a scheduler is lost while the hold is pending, existing restart recovery must first
prove owner/command fate and reconcile its ledger. A proven resumable interruption joins
the same hold without spending a task retry; its interrupted attempt remains in history
and can restart after release. Unprovable recovery is reported and cannot launch work.
Foreground runs without registered tasks also observe the fence. After `daemon continue`,
continue those explicitly with `flowcrew quick --project <project-dir> --existing-run-id <run-id>`;
the same compatibility and ownership checks apply before execution.

`task show` displays the scheduler generation at actual start and each actual resume,
with timestamp and PID. `run.json` retains the same `engineHistory`. Legacy runs may lack
their initial identity; the engine does not invent one. Daemon `status` separately proves
the listener's loaded build. Different generations are allowed when their workflow,
checkpoint, plan binding, stage ledgers and persisted formats are supported. Unsupported or
inconsistent state fails closed before a new attempt or successful resume admission.
A missing admitted-stage projection in a checkpointed run, or one with a retained ledger,
is inconsistent: continuation reports it instead of recreating pending work. Attemptless
legacy preparations without checkpoints or ledgers remain supported.

Sources: [hold](../src/deployment-hold.ts), [continuation validation](../src/engine-continuation.ts),
[deployment control](../src/orchestrator.ts), [publication guard](../src/build-manifest.ts).

## Campaigns

Campaign selection is explicit `--campaign`, then the main-worktree
basename slug; Git failure/non-repository selection falls back to the project directory.
`--no-campaign` detaches. Explicit display name and canonical storage identity are distinct.
Global campaign telemetry lives in flat `<key>.jsonl` ledgers under the state root's `campaigns`.

`--campaign-context=inherit|skip` controls verbose planner history independently of grouping.
Skip still permits the compact tried-direction ledger. The legacy `--no-inherit-campaign`
alias selects skip. Without an explicit context flag, at least three adverse endings among
the ten most recent completed tasks select skip; explicit choice wins and continuation
retains its stored choice. A history instruction to avoid repeated directions does not
mechanically guarantee model novelty.

Campaign health can request research/pivots;
research policy owns numeric keep/stop decisions. Current telemetry does not create a
principal metric merely because a gate passes.

Sources: [selection](../src/config.ts), [launch context](../src/cli.ts),
[hygiene](../src/campaign-hygiene.ts), [ledger](../src/campaign-ledger.ts),
[campaign policy](../src/scheduler/sched_policy/campaign.ts).

## Preserve and reclaim

Read the report and durable rejected verdicts before accepting a result. `land --run` audits
declared terminal products, tracked changes/deletions, untracked and ignored paths, unpushed
commits and commits whose last surviving ref would be removed. Unknown/source/data/state/
symlink items are named; proven regenerable outputs are counted. Audit mode is read-only.

For an accepted terminal run, `land --run <run-id> --archive --remove` archives the named
unique worktree outputs, terminal products and complete run store before entering the same
removal gate. `--archive` defaults to `H:\flowcrew-archive\fc-runs`; `--archive=<root>`
selects another existing local archive root. The default requires H: to be mounted; a missing
root, insufficient capacity or copy/hash failure blocks removal. Each invocation creates a
separate directory with worktree and run-store copies and per-file SHA256 manifests. Both
source and destination are checked again before removal. Run-store originals are retained.
The opt-in flag keeps ordinary audits read-only; it replaces manual copy/diff steps without
adding another removal mode. Review the inventory and sensitive evidence scope before archiving.

Removal requires `--remove` and the exact `--acknowledge-regenerable` count when regenerable
paths exist. It refuses nonterminal runs, incomplete inspection and unique ungraded ignored content.
It proves a linked attached worktree, then uses non-force removal/prune/branch deletion;
Git refuses tracked/untracked changes and unmerged branch deletion while preserving the branch.
Archiving these files preserves their bytes but leaves those Git protections in place.
Account for unique work elsewhere and rerun; acknowledgment is not permission to discard it.
`land` does not decide whether the report answers the task.

Optional exact ledger closure uses `--complete-fc-task` with `--fc-task-session` only during
removal. The engine verifies the ledger/run/worktree binding, leaves the entry unchanged
until all Git steps succeed, then atomically closes it. Omission leaves it open. A final
ledger write failure remains nonzero with a guarded repair; see [ledger](fc_tasks.md).

Source: [landing audit](../src/cli-land.ts).
