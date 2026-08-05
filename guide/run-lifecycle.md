# Run lifecycle

Every run stores one status in its `run.json`. The vocabulary is defined by
`RUN_STATUS` in `src/store.ts`; terminal and successful subsets are derived from
that same definition.

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
| `incomplete` | Yes | No | The scheduler when the iteration budget ends mid-progress, including research with too few accepted measurements for a real ceiling | Inspect rejected rounds and unfinished gates; revise the brief or increase the relevant budget before rerunning. |

`complete`, `shipped`, and `ceiling_hit` are the only successful statuses. The
CLI exits successfully for all three. A foreground command also exits zero when
`parked` so a service manager does not mistake a deliberate suspension for a
crash, but `parked` is neither terminal nor successful.

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

See [Brief contract](brief-contract.md) for the frontmatter and file contracts.
