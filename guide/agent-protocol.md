# Agent protocol

For contributors implementing model input, typed answers and graph changes. The
receiving schemas and core admission own executable facts; prose is guidance.
[Brief contract](brief-contract.md) is the author-facing declaration.

## Dispatch

A plan contains `stages`. Each stage has `id`,
`role`, `purpose` (`work`, `gate` or `plan`) and `after`. Work and plan stages also carry an
`instruction`; a gate takes none and reviews the whole brief under its role text.
`commands` is required for gates and optional for other purposes; `baseCheckpoint`
is optional. Gates may declare `repair: {stage, returnsTo}`. A brief runs a fixed
work/gate/repair graph unless it declares `decompose: true`, in which case a plan stage proposes the graph.

Roles and commands must belong to the supplied finite context. Dependencies must
exist and be acyclic; repair routes return to the rejecting gate. Core admission
also enforces delivery topology and independent verification. A stage name does not
select filesystem permissions. The engine owns admitted declarations and records; all
stages execute with host-account rights in the same per-run project copy. The engine
settles one stage at a time; graph dependencies do not promise parallel execution.

Every invocation receives the complete parsed brief/body and appropriate evidence,
not the originating conversation. Work/plan/repair/continuation may receive pending
human guidance in commit order; independent gates never receive it. While an author
is running, accepted applicable guides are offered to a Claude author through its native
stream-json input at the next five-second observation cadence; the Codex adapter refuses
mid-turn steering, so a Codex author receives them at its next invocation. Refused or ended offers
stay pending for the next author input. A pending guide requires an author
continuation before review can establish delivery, even if no author work remained.
Guidance status records delivery only with the receiving invocation's receipt, including
steered guides, so a guide shows `pending` until the invocation that received it ends and
`delivered` after that. Without a receipt the guide is sent again. Delivery does not prove compliance.

Live provider activity identifies its author or gate role and is provisional observation, separate from authenticated final
answers and gate verdicts. Status publishes each execution's source, relevant event
time, tool, summary and current or ended state. A quiet tool or engine command gets
one advisory per ten-minute quiet episode; a new relevant event clears it. Unrelated
provider messages do not establish an open tool's progress. Unknown stays unknown;
advisory records live outside the decision journal and never change execution, retry or acceptance.

## Answers and gate verdicts

The generated schema is authoritative. Answers carry `kind` and `answer`:

- Work: `status` (`delivered`, `blocked`, `environment_gap`), `summary`, `caveats`,
  `remainingWork` and nullable `blocks`.
- Gate: `outcome` (`accepted`, `accepted_blocked`, `rejected_repairable`,
  `rejected_irreparable`), `reason`, full criterion map, `findings`, `remainingWork`,
  context-permitted `result`.
- Plan: exact `baseRevision` and the proposed `plan`.

Each criterion has pass/fail evidence. Intermediate gates may use `not_assessed` with
`reason: pending_work`; final gates may not. Findings have IDs, literal paths, reasons,
criterion IDs and class `criterion_unmet`, `regression` or `advisory`, with optional
command evidence. Advisory prose does not create another repair/routing channel.
`accepted_blocked` requires brief `allowBlocked`. A final accepting gate must select a
declared result if finite result labels exist; their text/IDs are opaque to code.

Required command and output obligations still constrain completion. No model-authored
verdict can turn a nonzero required command or unpreserved delivery into success. The one
exception is engine-measured: a required command that already fails the same way on the run's
base tree is recorded with basis `pre-existing` and does not block
([brief contract](brief-contract.md#required-commands-that-already-fail-on-the-base)).
Author gaps remain evidence for review, not permission to waive a criterion.

## Scope and plan revisions

Input/output declarations define content obligations and evidence, while the OS account
supplies filesystem permissions. A planner's prose scope changes neither. Frozen-input
checks and checkpoints persist across attempts; they do not prevent host writes.
Independent gates receive no author guidance, and their observed project changes are
rejected. See the [execution boundary](operations.md#platform-boundaries).
Plan revisions replace a pending suffix against an exact base revision;
settled history and obligations remain. Operator `guide --plan` requires no open
attempt or unresolved command reservation and uses the same admission owner.

## Holding pattern and retained continuation

C2 parks after three consecutive gate rejections (counting the one that last set the best
pass count) or four failures without a completion. Work and
evidence are retained. Resume starts a continuation segment; it does not accept a
product or discard prior results. Provider context exhaustion is a native outcome.
There are no general iteration bounds or stage deadlines; an exact command can have
`durationMs`. Host restart needs explicit manual resume using the original runtime pin.

## Command evidence

A command carries exact operator argv/env, declared input IDs and required status.
Receipts record content/context identity, streams, full content generations/deltas and direct execution
outcome: complete with exit, unfinished with reason, or not started. Unfinished is not
zero. Command reservations retain unknown effects instead of silently replaying them.
Publication checks required command receipts on the delivered tree; see the [brief contract](brief-contract.md).
