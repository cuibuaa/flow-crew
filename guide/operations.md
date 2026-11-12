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
| `complete` | Terminal engineering completion or a completed instrument loop; project research conclusions remain in the instrument record |
| `shipped` | Recorded historical project ship decision |
| `ceiling_hit` | Recorded historical process-level ceiling; not a metric win |
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

Setup reads project/brief validation declarations without executing a baseline. The ready
record binds selection to the exact brief and target. Authors and repairs finish their code,
deliverables and related tests, then return. They do not run or poll configured validation.

The scheduler validates the settled tree outside the author deadline. One durable completed
record per content hash supplies all stages, reviews, gates and resumes. Records live under
`FC_HOME/validation/<tree-hash>.json`; run evidence ledgers retain the record and its location.
All zero command exits accept validation; any completed nonzero exit rejects and opens repair.
Reporter totals, logs, timing and load are evidence for readers, never verdict inputs.
There are no candidate confirmations, automatic subset reruns or gate-requested base suites.

Unfinished executions retry within `attempts` and `timeoutMs`, declared by the brief's
`validation` block, else the project's `config/validation.json`, else the engine's
`validation_attempts` and `validation_timeout_ms`. The record keeps the limits in force and the allowance spent
(`spentMs`, each execution charged its full `timeoutMs`). Exhaustion parks the run without
spending another author attempt, review verdict or repair round. A completed record is reused
whatever limits ask for it. An unfinished record runs again only when the requesting
allowance (`timeoutMs × attempts`) is larger than its `spentMs`; declare a larger allowance
in the brief or project before relaunching an exhausted tree. Completed nonzero records are retained on resume.
The shared store FIFO bounds daemon scheduler processes with `validation_concurrency`;
`validation_priority` sets the Unix niceness adjustment. Dead controller requests release
queue ownership. Configuration is engine-owned, and no project-specific load policy applies.

Sources: [preflight](../src/cli-ship-preflight.ts), [setup](../src/cli-ship-setup.ts),
[validation and deltas](../src/project-validation.ts),
[gate validation](../src/scheduler/sched_settlement/gate-validation.ts).

### Storage ownership

Setup's independent input copies protect the source even when a subprocess writes its local
input. A read-only declaration or a later hash check cannot provide that protection through a
hardlink. Before creating a worktree or copying declared inputs, setup estimates additional
logical input bytes, deduplicated by destination, and records `estimatedCopyBytes`. Existing
target files need no additional copy bytes. Sparse files and reflinks count their full
logical size. Invalid estimates, cycles and source escapes refuse before copying.

The engine invokes no operator-specific capacity executable and defines no capacity threshold
or bypass flag. Operators coordinate capacity for concurrent materializers. Copy failures
refuse setup without publishing READY. Native file-copy and owned-worktree failure cleanup
remain in place; earlier completed copies can remain. Inspect the reported target and
available space before retrying.

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
`*`; routing uses that declaration, never prohibition wording in the message.
Scheduler notices with an attempt index belong only to that attempt. For a running invocation the next command completion triggers delivery, even while
other commands are open. The existing child-retirement path stops those commands before
a fresh invocation submits the guidance. Delivery checks remain pending until the actual
submitted input contains the envelope; the delivered receipt lists retired command IDs.
`interrupt` stops every active command of the identified invocation and submits its reason
through the same guidance path. Attempt and invocation identities reject stale requests.
Neither action resets the attempt deadline. The attempt clock enforces wrap-up and the
hard stop directly; shell-text timeout forecasts do not create control notices. Changes to admitted criteria or authority need revised brief bytes and admission.

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

## Unattended execution

After launch, stages use their existing authority under the brief and continue as far as
possible when a resource is unavailable. Their structured result and terminal report state
any gap. There is no execution request/decision transport or entry clarification pause.
The chooser chooses and records assumptions for wrap-up. Missing author-owned facts end
the run with a result naming what the author must supply before launching again.

Historical approval logs and paused run records remain readable by the CLI, dashboard and
wrap-up readers. They grant no new authority and have no decision/resume endpoint.

A declared research review can reject a submission without creating an observation. An author or review execution failure
fails the run. The frozen project instrument owns keep/reject and report content; the engine enforces hard budgets, cancellation and terminal publication. Proven resumable host interruptions retain their
orchestration checkpoints without requesting human approval.

For `research-instrument/v1`, inspect `engine/research_manifest.json` for the engine
stop reason and final incumbent, and `engine/research_publication.json` for delivery.
Publication is attempted once at terminal and cannot change the run result. Recovery
and `land` never recreate project reports, even after the project worktree is removed.
A reserved invocation with no committed result is uncertain and is never silently
remeasured; the invocation ID is the project's external idempotency key. Historical
research records remain read-only through the explicit legacy decoder; old briefs
must be migrated to the named protocol before a new launch.

Cancellation closes active control state as `cancelled` and attempts to stop its owned
workers. It acknowledges a terminal decision; task notes report any unresolved process
evidence. Daemon restart, recovery and deployment release leave that cancellation cancelled.
For a versioned research run, proven scheduler and owned-worker retirement also allows
native control to restore the incumbent and commit the run-local manifest, even when
SIGTERM prevented the scheduler's finish closure. No new instrument work or report
publication runs after cancellation; unknown process fate defers restoration.
If a newer run has acquired the project, including one that has already completed,
the older cancellation writes only its run-local manifest. Its `restoration_skipped`
field records changed or unknown project ownership; its retained best snapshot stays
available. Admission and restoration share the existing lock primitive, and launch
release retains the last project owner. This fences delayed candidate writes without
reintroducing research-report ordering or recovery publication.
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
admission, scheduler ownership, persisted execution compatibility.
Only explicit continuation resumes cancelled work.
Cancellation settles interrupted attempts and their stage ledgers, and appends their terminal
`attempt_failed` event for `events` and session-push wrap-up. Resume requires settled execution records; it refuses unfinished attempts left by an older cancellation without rewriting them. Archived `stopped` records remain readable as `cancelled`.
`flowcrew task retry <task-id>` requests another launch attempt:
before terminal settlement it retains any existing run binding, and after settlement
it starts a fresh run with a new plan, stage history and iteration budget. Retry does
not resume cancelled work.

For a run without a registered task, the existing continuation command remains
`flowcrew quick --background --project <project-dir> --existing-run-id <run-id>`.
Omit `--background` to continue that run in the foreground.

Sources: [historical inbox reader](../src/inbox.ts),
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
Historical approval parks remain readable; cancellation takes precedence. Task
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
the frozen project instrument owns project verdicts and stop requests. Current telemetry does not create a
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
