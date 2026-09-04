# Run lifecycle

Every run stores one status in its `run.json`. The vocabulary is defined by
`RUN_STATUS` in `src/store.ts`; terminal and successful subsets are derived from
that same definition. `RUN_STATUS_SEMANTICS` gives every member one required
lifecycle bucket, process-success decision, and mutation-blocking decision.
Guards such as `isTerminalRunStatus` and `isSuccessfulRunStatus` delegate to
that table rather than reconstructing subsets. CLI/dashboard wording, campaign
scoring, archive preflight, rehearsal verdicts, summaries, and supervisor
progress have their own exhaustive typed maps because those are distinct
consequences, not alternate spellings of the same question. Adding a vocabulary
member therefore fails TypeScript compilation until every required consequence
has a non-empty value.

The compiler guarantee begins only after archive text is resolved. `run.json`
may have been written by a newer or older FlowCrew version, so
`resolveRunStatus` returns either a known status with its semantics or an
unknown result carrying the original parsed value and an explicit reason. A
well-formed archive with an unrecognized status remains readable and displays
that raw value as unrecognized; it is never converted to `pending`, `running`,
or a terminal status. Scheduler resume, run-state writes, campaign scoring, and
`flowcrew land --remove` refuse consequential action until the tool understands
the value or an operator explicitly migrates the archive. Malformed JSON remains
a separate archive-read error.

## Status reference

| Status | Terminal | Successful | Written by | What the operator should do |
|---|---:|---:|---|---|
| `pending` | No | No | Dashboard task creation and rerun preparation | Execute the task from the dashboard, or leave it queued while editing its plan. |
| `running` | No | No | Run initialization, scheduler resume, and dashboard execute/rerun paths | Monitor with `flowcrew status`, the dashboard, or `flowcrew task show <id>` for background tasks. Guidance and cancellation are still available. |
| `parked` | No | No | The scheduler after it ingests an unresolved approval request | Review `/inbox` or run `flowcrew inbox show <requestId>`, then approve or deny. The decision resumes the same run by default. |
| `complete` | Yes | Yes | The scheduler when an engineering run finishes its DAG and gates | Review `summary.md` and the evidence. No recovery action is required. |
| `failed` | Yes | No | The scheduler on unrecoverable stage failure; the dashboard on orphan reconciliation (scheduler process gone), staleness (no progress within the timeout), or a detached launch that never started | Read the failure reason and failed stage output, fix the cause, then rerun or submit a corrected brief. |
| `awaiting_approval` | No | No | No current write path; retained for legacy plan-approval records | Use the dashboard's legacy plan approval/re-execute controls. New consequential-action approvals use `parked` instead. |
| `shipped` | Yes | Yes | The research policy after a target beat survives `research.confirm`, or the scheduler after a declared `shipped` artifact passes its gates | Inspect the ship report, confirmation record, and Reality-Gate evidence before consuming the result. |
| `ceiling_hit` | Yes | Yes | The research policy after an honest stop, a budget path with enough measured rounds, or a declared `ceiling_hit` artifact | Treat the negative result as a valid deliverable. Read the ceiling report and dead ends before choosing a genuinely new direction. |
| `escalated` | Yes | No | The scheduler when planning is unsatisfiable/exhausted, or when it detects a declared `escalated` artifact | Read the escalation artifact or failure reason, resolve the named blocker, and launch a revised brief. |
| `reality_gate_failed` | Yes | No | The Reality-Gate when a requested successful terminal state fails a hard deterministic check | Fix the evidence, implementation, or incorrect check declaration; do not treat the original success claim as valid. |
| `phase_complete` | Yes | No | The scheduler after detecting a declared `phase_complete` artifact | Inspect the phase artifact and program ledger. Verify any post-termination hook before advancing the next phase. |
| `stopped` | Yes | No | The scheduler after detecting a brief-declared `stopped` artifact, or `flowcrew task cancel` and the dashboard cancel action after both the unit and scheduler process are confirmed stopped | Read the terminal artifact or `failureReason` (a cancellation reads `Cancelled by user`), then start a new run only if work should continue. |
| `incomplete` | Yes | No | The scheduler when the iteration budget ends mid-progress, including research with too few accepted measurements for a real ceiling, or when a settled DAG cannot match its declared terminal contract | Inspect `failureReason`, rejected rounds, terminal-artifact diagnostics, and unfinished gates; correct the artifact or revise the brief before rerunning. |

`complete`, `shipped`, and `ceiling_hit` are the only successful statuses. The
CLI exits successfully for all three. A foreground command also exits zero when
`parked` so a service manager does not mistake a deliberate suspension for a
crash, but `parked` is neither terminal nor successful.

Operator terminology is intentionally unambiguous: a daemon task may have multiple
**launches**, a stage may have multiple **executions**, and a repair loop may cause a gate
**re-evaluation**. `flowcrew status`, task list/show, the dashboard, and `flowcrew events`
all expose the same bounded operational projection and the latest reason-bearing event.

## Stage readiness and settlement

Stage status answers two different questions. For dispatch readiness, only a
successfully `complete` dependency is satisfied; `skipped` and `failed` stages
never release their dependents. A completed gate must additionally have a valid
stage-specific verdict with `pass: true`. This fail-closed rule keeps a missing
measurement from turning into a downstream report.

For whole-DAG settlement, `skipped` is still a final disposition. This is what
allows a passing gate to leave its `retry_to` repair branch intentionally
skipped without keeping an otherwise valid run alive. The distinction is
deliberate: terminal does not mean productive. If an ordinary dependent remains
behind skipped or failed work, the run stays unresolved and ultimately records
`incomplete` rather than executing the dependent or claiming plain completion.

## The distinctions that carry meaning

### `ceiling_hit` is a successful honest negative

A research policy can exhaust a well-measured search without beating its target.
That is a result, not an engine failure. FlowCrew writes a ceiling report,
preserves the measured rounds and dead ends, and returns a successful process
exit so an outer campaign does not retry it as a crash.

### `incomplete` is budget exhaustion, not a crash

`incomplete` means the run reached its iteration or research budget before it
had enough accepted evidence to ship or declare an exhaustive ceiling. It is
terminal and unsuccessful, but it is deliberately distinct from `failed`: the
engine did not crash, and the evidence may still be useful for a better-scoped
or better-funded follow-up.

### `stopped` covers two different causes — read `failureReason` to tell them apart

A brief can declare `stopped` as a terminal artifact path, meaning the work itself decided
to end. A user cancelling the run — `flowcrew task cancel`, or the dashboard's cancel
action — reaches the same status with `failureReason: "Cancelled by user"`. The stage
that was running is marked `failed`; stages that never started are marked `skipped`. Both
are terminal and both are unsuccessful, but only one means the run chose to stop.

### `parked` is a non-terminal pause

When a stage asks permission for a consequential action, the scheduler records
the request, sets `parked`, persists the current DAG and iteration, and exits the
run process. There is no live worker while the operator decides. Resolving the
request resumes the same run ID, DAG, and iteration; it does not create a fresh
run. See [Approvals](approvals.md).

## Terminal artifacts and deterministic checks

Briefs may map terminal statuses to project-relative artifact paths in
`terminal_states`. The scheduler accepts only statuses in its terminal set,
checks any declared floor, snapshots the artifact into the run directory, and
then applies Reality-Gate before committing successful statuses. A hard
Reality-Gate failure replaces the requested success with
`reality_gate_failed`.

Terminal evaluation is a decision point at iteration entry and after every
settled execution batch, including a batch that contains a failed stage. A
fresh artifact still requires proof that a non-plan stage actually ran: a
non-plan stage settled as `complete` or `failed` supplies that proof, while the
plan stage alone and a skipped stage do not. Evaluation distinguishes a
matched terminal, a candidate deferred by a floor or confirmation check, and
no match.

Gate repair, downstream continuation, and an eligible outer re-plan retain
their normal opportunity to run. Once those transitions are exhausted and all
relevant stages are final, the scheduler evaluates the declaration again. A
match commits its declared status; otherwise the run commits `incomplete`,
puts the exact deferred/no-match reasons in `failureReason`, and emits a
`run_completed` event. A settled run therefore cannot remain silently
`running`, and a declared terminal contract cannot silently degrade to plain
`complete`.

In particular, a gate re-evaluation inside a `retry_to` repair loop can be the
last writer: its passing verdict and terminal artifact do not pass through the
ordinary post-batch observer. The converged `gate_pass` path therefore invokes
the same declared-terminal evaluator before any plain completion. It commits
the artifact's declared status only after the existing freshness, floor,
settled-stage, confirmation, and Reality-Gate checks succeed; otherwise it
commits `incomplete` with those checks' refusal reasons.

Lifecycle `status` and the terminal artifact remain independent evidence; the
diagnostic never rewrites `status`. `flowcrew status`, `flowcrew list`, daemon
task list/show, and `flowcrew watch` report a status mismatch in both
directions:

- a recorded `terminalArtifact` maps unambiguously to a different declared
  terminal status; or
- a non-terminal lifecycle has no recorded terminal artifact, every stage is
  settled, and exactly one safe, fresh declared artifact is present at its
  project path or scheduler snapshot.

Active stages, stale files, unsafe paths, and multiple fresh candidates remain
silent because none proves a unique terminal outcome.

Compile-time totality does not prove that a human chose the correct semantics
for a newly added row, that external writers emit valid JSON, or that every
ad-hoc JSON parser outside the typed boundary remembers to resolve before it
acts. Review, behavior specs, and the fail-closed write/action guards remain the
convention-level protection for those facts.

## When the supervisor is hard-killed

A background run is owned by a supervising shim that records the run's exit status to disk
atomically. `SIGKILL` gives it no chance to write that record, and the agent it was
supervising may survive, reparented, still holding shell access to the project.

The engine does not guess what happened. The run ends in a terminal state marked
`outcome unknown` rather than `failed`, `flowcrew task cancel` refuses to report success for
it, and the operator may need to find and kill the stray process. This is the one gap the
exit-status protocol cannot close, and it is deliberately loud rather than silently rounded
to a result the engine cannot support.

See [Brief contract](brief-contract.md) for the frontmatter and file contracts.
