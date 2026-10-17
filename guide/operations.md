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
| `awaiting_approval` | Legacy approval state, retained separately from parked |
| `complete` | Successful terminal engineering completion |
| `shipped` | Successful terminal research ship decision |
| `ceiling_hit` | Successful process-level research ceiling; not a metric win |
| `failed`, `reality_gate_failed` | Terminal execution/check failure |
| `escalated` | Terminal unresolved or irreparable outcome |
| `phase_complete` | Terminal phase boundary; not classified as process success |
| `stopped` | Terminal stop |
| `incomplete` | Terminal insufficient completion |

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
commands. It runs no project build, test or lint; `--no-baseline` is compatibility syntax.
Exit zero means collection completed, not that launch is ready.

`ship-setup` requires the exact brief, source project, base, new branch and target. It checks
source/base inputs, creates or proves the reusable managed worktree, materializes missing
input descendants and rechecks content/assertions. Target-owned copies of regular files/directories
isolate target writes; internal
links are relocated within the target tree. Existing target entries resolving outside it or
content/type collisions refuse. Do not replace a refusal with manual source symlinks.

Setup discovers validation from configuration or the brief's explicit argv declarations.
It executes the target baseline under the configured command bound and writes a ready record
bound to the exact brief digest and canonical target. A failed setup can leave a diagnostic
worktree; it does not publish a ready record for a blocker.

Exact Vitest, pytest and explicitly declared-file collectors compare normalized source/target
identities, not just counts. Unsupported, failed or incompatible collection is `unverified`
with a reason; source suites are not run to infer generic TAP population parity. An exact
mismatch refuses. Unverified population does not prove source coverage and does not relax
the target validation baseline.

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
hardlink. An input-copy failure refuses setup without publishing READY; inspect available space
and the reported target before retrying. Failed setup worktrees can contain partial copies.

Use invocation `$TMPDIR` for disposable checkouts, compiler caches and test fixtures.
Scratch survives retries, gates and continuations. A settled stage's `stages/<stage>/build/`
and `stages/<stage>/scratch/` are workspaces: after children, monitors, audits and retry
settlement finish, the engine compacts their disposable members. The workspace directory
itself remains so an existing directory declaration can still be queried. Declare final
products below that root explicitly, and name evidence in the stage result or a retained
report. Use `evidence/` and `handoff/` for durable material, including portable tarballs.

Retention keeps every path outside those workspaces and invocation scratch. Within a workspace
it keeps declared products below the workspace root, all declared run inputs (including
completed consumers that might retry), evidence/handoff/patch/output/log directories,
patches, bundles, archives and log files. Exact report/evidence path citations survive at
any size and keep their original pathname. Small scripts, configurations and results at
the workspace root, or whose filename appears in retained reports/evidence, also stay
when at most **1 MiB per file**. That cutoff preserves reproducibility inputs and small
measurements without a filename-only mention pinning a multi-gigabyte corpus. Larger
required files must have an exact path citation or an explicit product/input declaration.
Citations can use run-relative, stage-relative or workspace-relative paths, quoted paths
with spaces, or the recorded absolute workspace/invocation-scratch path. Logs and native
prompts remain durable but do not turn every command's working directory into a citation.
Private credential files are never opened by retention. Removal keeps symlinks and never traverses them. Declared locations and report aliases are
resolved for preservation and citation discovery; workspace targets are protected too.

Unfinished, unknown and budget-continuing stages retain their entire workspaces. Failed,
stopped and incomplete runs retain invocation scratch for resume. Parked/deployment-held
runs retain all their work. Status/attempt ledgers, checkpoint and process ownership,
workflow/dispatch/admitted plans, scope/approval/guidance decisions, verdicts, validation
and audit records, append-only history, outputs and every attempt log stay available to
continuation, cancellation, audits and dashboard readers. Project files and patches are
never reverted by retention. A terminal status alone cannot authorize removal while a
controller or owned command may still be alive; malformed or missing ownership evidence
also preserves work. The policy sends no signals. A failed cleanup keeps remaining work
and does not change the authored verdict.

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
Retained artifacts intentionally continue to consume space; this is workspace compaction,
not a quota or an age-based history expiration policy.

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
compatible stopped (including cancelled), failed or incomplete registered run after settlement.
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
Scope and contract errors receive engine decisions; approval cannot override those guards.

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

Cancellation closes active control state as `stopped` and attempts to stop its owned
workers. It acknowledges a terminal decision; task notes report any unresolved process
evidence. Daemon restart, recovery and deployment release leave that cancellation stopped.
Explicit resume can continue safely settled work after ownership and compatibility checks.
Use the deployment hold below to let current stage work settle normally before deployment.

Explicitly continue a registered task's stopped, failed or incomplete run by task ID:

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
route. Resume reports exhausted iteration budget before queuing work. Stopped or
failed work continues in its interrupted iteration without replenishing repair rounds.
An unfinished repair continues its admitted gate round; the related gates review
the new repair without restarting earlier authoring or planning work.
The task registry supplies the run ID and project directory; the dashboard Resume
control beside Cancel requests the same continuation. Resume still checks brief
admission, scheduler ownership, persisted execution compatibility and unresolved approvals.
Only explicit continuation resumes stopped work, including acknowledged cancellation.
Cancellation settles interrupted attempts and their stage ledgers. Explicit resume also settles the matching unfinished attempt left by an older cancellation when the existing ownership evidence proves its scheduler, controller and commands are no longer alive. Other unsettled attempts, unknown or live owners, and unrelated ledger disagreements still refuse continuation.
`flowcrew task retry <task-id>` requests another launch attempt:
before terminal settlement it retains any existing run binding, and after settlement
it starts a fresh run with a new plan, stage history and iteration budget. Retry does
not resume stopped work. Parked approval requests use the Inbox decision controls.

For a run without a registered task, the existing continuation command remains
`flowcrew quick --background --project <project-dir> --existing-run-id <run-id>`.
Omit `--background` to continue that run in the foreground.

Sources: [inbox](../src/inbox.ts), [request paths](../src/approval-artifacts.ts),
[active monitoring](../src/scheduler/sched_policy/approvals.ts), [decision CLI](../src/cli-inbox.ts),
[continuation admission](../src/scheduler/sched_loop/launch.ts), [daemon queue](../src/orchestrator.ts).

## Deploy while tasks are in flight

Use an engine with deployment-hold support for this procedure. Upgrading an older engine
that lacks the command still requires retiring its consumers first. Select the same
`FC_HOME` and daemon socket for every command. The hold is durable in that state root,
survives daemon restart, and fences both registered launches and foreground schedulers.

```bash
flowcrew daemon hold --timeout-ms 60000
flowcrew daemon hold-status
flowcrew daemon stop
# Wait for the owned daemon process to exit; stop's RPC acknowledgement alone is insufficient.
# Stop any other old-build dashboard/CLI consumers you own, then publish the combined build:
npm run build
flowcrew daemon start
flowcrew daemon status
flowcrew daemon continue
flowcrew task show <task-id>
```

Run the build from the intended deployment checkout only after retiring its consumers.
The builder refuses publication if any live daemon, scheduler or other importer of that
distribution remains. Do not use `--force` or overwrite modules to bypass this check.
A hold's `ready: true` proves its registered units, schedulers and checkpoint-owned command
groups have stopped; the daemon itself remains live until the separate stop. Unregistered
old consumers are also covered by the build publication guard. A failed build is not a deploy.
Historical terminal runs with no unit, scheduler or owned command group are already settled.
Status uses one manager inventory, then probes only units still present; it does not query
each retired unit separately. An unavailable manager or ambiguous owner still refuses readiness.

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
of termination grace, then owned command closure and settlement. `hold --timeout-ms N`
bounds the operator's polling window (default 60 seconds), plus at most the initial 2-second
RPC timeout. A missing response can report unknown delivery. Exit 1/2 or `ready: false`
means **do not deploy**: the fence remains active, current work continues to its normal
boundary, and no timeout fallback cancels it. Recheck `hold-status` later. If abandoning
the deployment, wait for settlement and use `continue` on the existing build.

After restart, the latch still blocks queued tasks. `continue` validates every held run
before granting launch authority, releases compatible runs into the existing queue, and
returns per-run refusals with a failing exit if any cannot continue. Those tasks become
`stuck`; their run retains `continuationFailure`, original attempts and parked state for
inspection. One refused run does not block the compatible runs from continuing. Repeated
continue does not grant attempts twice. Approval parks still require their own decisions;
cancellation takes precedence. Task launch retry budgets are not charged for the hold.
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
Global campaign telemetry and directory records live under the state root's `campaigns`.
Program phase ledgers are instead declared project products.

`--campaign-context=inherit|skip` controls verbose planner history independently of grouping.
Skip still permits the compact tried-direction ledger. The legacy `--no-inherit-campaign`
alias selects skip. Without an explicit context flag, at least three adverse endings among
the ten most recent completed tasks select skip; explicit choice wins and continuation
retains its stored choice. A history instruction to avoid repeated directions does not
mechanically guarantee model novelty.

Campaign status/pending/review inspect directory state and proposed brief patches; the CLI
has no campaign launch subcommand. Review accepts/rejects/skips/quits patches, with versioned
brief head/diff/log/rollback inspection. Campaign health can request research/pivots;
research policy owns numeric keep/stop decisions. Current telemetry does not create a
principal metric merely because a gate passes.

Sources: [selection](../src/config.ts), [launch context](../src/cli.ts),
[hygiene](../src/campaign-hygiene.ts), [ledger](../src/campaign-ledger.ts),
[campaign policy](../src/scheduler/sched_policy/campaign.ts), [patch review](../src/campaign-review.ts).

## Preserve and reclaim

Read the report and durable rejected verdicts before accepting a result. `land --run` audits
declared terminal products, tracked changes/deletions, untracked and ignored paths, unpushed
commits and commits whose last surviving ref would be removed. Unknown/source/data/state/
symlink items are named; proven regenerable outputs are counted. Audit mode is read-only.

Removal requires `--remove` and the exact `--acknowledge-regenerable` count when regenerable
paths exist. It refuses nonterminal runs, incomplete inspection and unique ungraded ignored content.
It proves a linked attached worktree, then uses non-force removal/prune/branch deletion;
Git refuses tracked/untracked changes and unmerged branch deletion while preserving the branch.
Account for unique work elsewhere and rerun; acknowledgment is not permission to discard it.
`land` does not decide whether the report answers the task.

Optional exact ledger closure uses `--complete-fc-task` with `--fc-task-session` only during
removal. The engine verifies the ledger/run/worktree binding, leaves the entry unchanged
until all Git steps succeed, then atomically closes it. Omission leaves it open. A final
ledger write failure remains nonzero with a guarded repair; see [ledger](fc_tasks.md).

Source: [landing audit](../src/cli-land.ts).
