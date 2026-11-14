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
uses the project lock. Do not edit an active run's project: content observations cannot attribute
an unrelated human edit to a stage.

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

Setup reads project/brief validation declarations and executes every declared validation command once in the prepared target. The ready
record binds selection to the exact brief and target. Authors and repairs finish their code,
deliverables and related tests, then return. They do not run or poll configured validation.

Setup records and shows every declared command's identity and result. If any command has no completed exit 0 (including missing exits or unfinished execution), first launch requires the launching operator's explicit `--acknowledge-brief-warnings[=<digest>]` after measurement. A changed target or measured result invalidates the acknowledgement. An empty declared list needs none. Old unmeasured setups require rerunning setup for a first launch; initialized retries retain their historical baseline. Final validation must still exit 0 for every declared command. `ship-preflight` discovers validation commands but does not execute a baseline.

The scheduler validates the settled tree outside the author deadline. One durable completed
record per content hash supplies all stages, reviews, gates and resumes. Records live under
`FC_HOME/validation/<tree-hash>.json`; run evidence ledgers retain the record and its location.
All zero command exits accept validation; any completed nonzero exit rejects and opens repair.
Reporter totals, logs, timing and load are evidence for readers, never verdict inputs.
There are no candidate confirmations, automatic subset reruns or gate-requested base suites.

Unfinished executions retry within `attempts` and any declared `timeoutMs`. Per field, the brief's
`validation` block overrides the project's `config/validation.json`. Only attempts falls back to
engine `validation_attempts`; an omitted duration waits for completion or cancellation.
The record keeps limits and spent allowance (`spentMs`, each bounded execution charged its full
`timeoutMs`). Exhaustion passes the original command records, output and reporter text to the next
independent model for review and repair decisions. A completed record is reused whatever limits ask
for it. A bounded unfinished record executes again only if `timeoutMs × attempts` exceeds `spentMs`;
without a duration, interruption/exit events consume attempts. Resume preserves those records and
allowance. Engine-recorded `recovery.kind: resumable` authorizes an operator resume of parked work.
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

## Stage filesystem write grants

New runs record a write-grant contract at admission. On Linux x86-64 or arm64 with
Landlock ABI 3 or newer, every scheduled native agent launch receives its grant
before executing. The system Python bridge uses `/usr/bin/python3`, its standard
library and libc; no root, mount namespace, extra package, network restriction or
system-call filter is added. Git is required for existing repository worktrees.
Keep the engine distribution and state store outside the project worktree, as
required by the existing storage checks.

The grant follows children, detached grandchildren and re-parented descendants.
The launcher replaces itself with the agent, preserving the agent's supervised
PID and process group. Reads remain unrestricted. A successful launch receipt is
`writeGrantApplied: {abi, linkedFileCount: 0}`; preparation/application refusals
are typed `writeGrantFailure` outcomes, with exit 125, rather than inferred from
agent diagnostics.

Writing stages receive the whole project worktree, including dot directories and dependencies,
plus their own stage workspace and contract-declared external outputs/caches. Optional stage `scope`
arrays are work-division notes; neither their presence nor syntax changes the grant. Gates and isolated
decisions receive no project write grant, including additive project output or cache grants.
Admitted shared caches outside the project remain available; overlapping cache roots still refuse.
On hosts without a kernel grant, hash-only settlement detects read-only project changes and fails the
attempt without restoration. Frozen changes fail too; only a pinned-base Git blob matching the admitted
digest can restore a tracked leaf. Untracked or dirty-at-admission content is reported unrestored.
Exact shared run outputs still need existing inodes or declared directories; they do not grant siblings.
Run artifacts must stay in the stage's permitted `work/` area.
Engine-published verdict carriers are written by the engine from the typed result.
The planner's declared proposal file is prepared as an exact inode before launch.
An absolute directory output already admitted in the brief is also writable by
author stages, including authors and repairs that return successor decisions.
Returning a successor selects the next stage; it does not change the author's
admitted output authority.
These shared output trees receive the same no-REFER boundary as shared caches;
read-only gates receive no write grant
for them. Their declarations do not grant parents or siblings.

Each stage also receives its own agent home, invocation scratch and `/dev/null`.
For Git, the engine supplies private metadata, an index, refs and reflogs under
the stage work directory, with a branch named
`fc/<run-directory-hash>/<stage>/head`. Only the object directory is shared.
Shared branch refs, configuration, hooks and `packed-refs` are outside the grant.
Stage commits remain on the private branch; inspect them using the stage's
`GIT_DIR` and `GIT_OBJECT_DIRECTORY`. Repository settings are included from the
source configuration, and the stage environment disables automatic maintenance
of the shared object store. The shared object directory remains writable:
this is branch-ref isolation, not protection of existing Git objects from a
writer granted that directory. Shared Git objects and declared shared caches
receive no Landlock `REFER` permission. A link or rename between different
directories involving either shared tree fails with `EXDEV`, including moves
within that tree. This prevents a live stage from exporting a private file as
an alias that a peer can overwrite. Creating/writing shared files and replacing
files atomically within one directory still work. Private project, home and
scratch directories retain ordinary internal moves. Use engine-prepared linked
worktrees; a project root containing the common Git directory refuses preparation.
An unborn repository is admitted with a null base commit. The engine prepares an
unborn private stage branch using the same private metadata layout, so a
first commit need not create or change the primary checkout's HEAD. Shared Git
storage must still lie outside the granted project root. The null base is a
recorded Git state, not an unavailable-kernel fallback.

Because `HOME` is private, supply Git author identity through project settings,
environment or explicit Git command options when it would otherwise come only
from the operator's home configuration. The commit test supplies identity with
`git -c user.name=... -c user.email=... commit`.

Shared caches are writable only when the project declares their absolute paths
in `config/write-grant.json` before admission:

```json
{
  "shared_caches": []
}
```

Replace the empty array with the cache directories the project authorizes. This
declaration grants paths, not a package-manager cache selection. Ambient supported
cache variables pointing inside declared roots are retained; otherwise `HOME`,
XDG state and supported npm, pip, uv, Yarn, Corepack, Cargo, Rustup, Go, Gradle and
ccache locations are redirected into the stage home or invocation scratch.
Tools using other fixed locations must be configured explicitly or their writes
will fail. The admitted physical cache paths are frozen: editing the configuration
or redirecting a symlink does not change an existing run's authority. Start a new
run to admit changed declarations. Shared caches are shared mutable state.
Keep shared roots disjoint from other writable grants, including their ancestors
and descendants. Such overlaps refuse with `unsafe_path`, since an additive
directory grant would restore `REFER` and defeat the boundary. This also applies
to exact-file declarations, whose entries could be replaced before launch.
Tools writing shared caches must use copies or tolerate `EXDEV` with a copy
fallback for moves between directories. The repaired-grant measurements include
an actual npm install with both a private cache and a declared shared cache;
other cache implementations need their own compatibility check. No declaration
or environment variable restores cross-directory linking for shared roots.

Directory preparation walks pinned parent descriptors without following symbolic
links. Replacing an ancestor can refuse launch; it cannot redirect directory
creation or expand the declared grant. Engine-owned project/run/scratch roots
are canonicalized before their declared child paths are prepared.

Before every granted launch, the bridge counts regular-file paths with link
count greater than one across **all** granted roots, including ignored dependency
files, home, caches and Git objects. Any nonzero count refuses execution with
`{kind: "linked_files", count: N}`. It does not inspect file text or ignore rules.
Materialize independent copies/reflinks or configure the dependency manager's
copy mode before launch. Alternatively keep linked dependencies outside every
writable root and read them without a grant, with dependencies outside the worktree and a
declared separate directory for generated outputs. A dependency install then
needs an independently materialized writable dependency directory. Declare an
external shared cache only if it needs writes and satisfies the same link-count
rule. Declaring a store, dependency directory or cache never waives that rule;
adding the store can increase the count. A whole-worktree grant includes its
dependencies. Neither deleting dependencies from inside an agent nor promising
not to modify them can repair a refusal that happens before the agent starts.

Inspect `writeGrant.capability` in run state/status or the dashboard detail data:
`landlock` records the ABI; `unavailable` records one of `platform`,
`kernel_unavailable`, `kernel_disabled`, or `abi_too_old` (and ABI when known).
Recognized unsupported hosts retain the previous launch behavior without a grant
or cache redirection. There is no switch to disable a capable host's grant. An
unexpected capability-query error refuses admission; missing bridge prerequisites
must be repaired. An application failure after capable admission refuses the
launch instead of running partly constrained. Capability is queried once for a
new run and is not re-probed during retries or resume.

Older records remain readable by status, watch, listing and dashboard readers.
Missing admission is shown as `legacy_ungranted`; continuation persists that
marker and runs without a grant, even on a capable host. Deploying this release
therefore does not retrofit enforcement onto an already admitted run.

Accepted gaps: an agent can connect to an existing path Unix socket, use abstract
sockets, and change mode or timestamps of outside files on the measured kernel.
The grant does not isolate networks or filter system calls. Access to a powerful
service socket remains access to that service; filesystem confinement alone does
not remove it. Existing after-the-fact integrity and content checks remain active,
including frozen-input protection within an otherwise writable directory.

Before deployment, prepare independent dependency files, review project topology
and cache declarations, verify bridge prerequisites, and obtain the normal
engine-owned build/test/lint validation. Use the existing deployment hold and
generation procedure below; inspect a **new** run's capability and its launch
receipt afterward. The measurements and current validation limits are in the
[write-grant report](../docs/write-grant/report.md).

For rollback, settle owned consumers through the normal deployment procedure and
restore the prior validated engine generation. The older engine can read records
carrying the additional optional fields, but does not enforce the grant; retaining
a `landlock` admission in a record cannot make an older launcher enforce it.
Review and resume historical runs as unconfined work when using that generation.
Do not remove or edit run records to change capability. No deployment or rollback
step requires changing kernel settings or installing a namespace helper.

Sources: [grant computation and bridge](../src/write-grant.ts),
[launch boundary](../src/adapters/base.ts), [stage binding](../src/worker.ts),
[admission persistence](../src/store.ts).

## Inspect, guide and stop

`status` selects the latest run for the current project; `--all` selects across projects.
`task show` reads daemon detail. `state` reads admitted plan/attempt/artifact/evidence facts;
`--summary` bounds the projection and `--prompts` includes retained immutable invocation inputs.
An observation grants neither permission nor a pass. Older `input.md` aliases cannot reconstruct
every historical retry or hidden provider instruction.

`events` reads the canonical feed; `watch` gives a first heartbeat and edge-triggered stalls,
and evidence gaps. Watch reports terminal indecision after its quiet grace and rejected
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
Neither action resets the attempt deadline. A declared attempt allowance enforces its stop directly; shell-text timeout forecasts do not create control notices. Changes to admitted criteria or authority need revised brief bytes and admission.

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
The planner records necessary assumptions in the assigned work for wrap-up. Missing author-owned facts end
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
hold observation, including waiting for its RPC replies; without it the client waits until settlement. Reaching a declared limit returns JSON `status: "in-progress"`, code `RPC_IN_PROGRESS`, exit 5. The hold remains active and deployment does not stop the daemon, build, or release the fence. Inspect `hold-status` and retry with the same state/socket/checkout. The limit does not cancel stages or impose a build deadline.

Startup preserves every existing socket path. A refused connection can indicate a socket
left by a crash, but cannot authorize a later unlink while another starter may bind it.
For crash recovery, exclude concurrent starts, inspect the selected socket and its owner,
confirm no listener remains, then explicitly remove only that abandoned socket before
starting again. A slow reply, an inaccessible socket, or an unverified owner is no evidence
that removal is safe. Normal graceful shutdown removes its owned socket.

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
process. No attempt is killed to obtain a deployment hold. A declared stage allowance uses TERM/5-second grace/KILL at expiry and waits for real
child/group closure before retaining an unfinished continuation with work kept. There is
no automatic duration stop without a declaration. Idle aborts and unsafe writes retain
their existing policy; missing closure acknowledgement remains under observation.

There is no finite universal successful-hold bound: stage deadlines differ, groups may have
several bounded attempts, and audit/validation cleanup may itself fail to settle. For a
single running attempt, the wait includes its remaining immutable deadline, up to 5 seconds
of termination grace, then owned command closure and settlement. Both `hold --timeout-ms N`
and deploy's hold phase use the same caller-declared observation limit. There is no
default RPC reply deadline. An open connection keeps waiting; a connection that closes
after the request was written and before a valid answer yields unknown outcome (exit 2).
Exit 5 leaves the fence active: current work continues to its normal boundary. Inspect `hold-status`, resolve any refusal,
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

Campaign membership supplies identity and stored telemetry to operator views. Planners receive
no automatic campaign history, tried-direction digest or pivot instruction. Declare any historical
evidence needed for this task in the brief's existing `inputs` array. The admitted task and its
inputs carry the planning constraints; project instruments retain their declared verdict and stop duties.

Sources: [selection](../src/config.ts), [launch](../src/cli.ts),
[campaign storage](../src/campaigns.ts), [campaign publication](../src/scheduler/sched_policy/campaign.ts).

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
