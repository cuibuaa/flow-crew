# Agent protocol

For contributors implementing model input, typed answers and graph changes. The
receiving schemas and core admission own executable facts; prose is guidance.
[Brief contract](brief-contract.md) is the author-facing declaration.

## Dispatch

A plan contains `stages` and optional command `observations`. Each stage has `id`,
`role`, `purpose` (`work`, `gate` or `plan`), `after`, `instruction` and `skills`.
`commands` is required for gates and optional for other purposes; `baseCheckpoint`
is optional. Gates may declare `repair: {stage, returnsTo}`.

Roles and commands must belong to the supplied finite context. Dependencies must
exist and be acyclic; repair routes return to the rejecting gate. Core admission
also enforces delivery topology and independent verification. A stage name does not
select policy. The engine, not the model, owns physical write grants and records.

Every invocation receives the complete parsed brief/body and appropriate evidence,
not the originating conversation. Work/plan/repair/continuation may receive pending
human guidance in commit order; independent gates never receive it.

## Answers and gate verdicts

The generated schema is authoritative. Answers carry `kind` and `answer`:

- Work: `status` (`delivered`, `blocked`, `environment_gap`), `summary`, `caveats`,
  `remainingWork`, nullable `blocks`, and optional command `observations`.
- Gate: `outcome` (`accepted`, `accepted_blocked`, `rejected_repairable`,
  `rejected_irreparable`), `reason`, full criterion map, `findings`, `remainingWork`,
  optional `commandEvidence` and context-permitted `result`.
- Plan: exact `baseRevision` and the proposed `plan`.

Each criterion has pass/fail evidence. Intermediate gates may use `not_assessed` with
`reason: pending_work`; final gates may not. Findings have IDs, literal paths, reasons,
criterion IDs and class `criterion_unmet`, `regression` or `advisory`, with optional
command evidence. Advisory prose does not create another repair/routing channel.
`accepted_blocked` requires brief `allowBlocked`. A final accepting gate must select a
declared result if finite result labels exist; their text/IDs are opaque to code.

Required command and output obligations still constrain completion. No model-authored
verdict can turn a nonzero required command or unpreserved delivery into success.
Author gaps remain evidence for review, not permission to waive a criterion.

## Scope and plan revisions

Writable paths come from admitted project/output/cache/provider authority, not a
planner's prose scope. Frozen input declarations retain their protection across
attempts. Plan revisions replace a pending suffix against an exact base revision;
settled history and obligations remain. Operator `guide --plan` requires no open
attempt or unresolved command reservation and uses the same admission owner.

## Holding pattern and retained continuation

C2 parks after three gate rejections without a new best or four failures. Work and
evidence are retained. Resume starts a continuation segment; it does not accept a
product or discard prior results. Provider context exhaustion is a native outcome.
There are no general iteration bounds or stage deadlines; an exact command can have
`durationMs`. Host restart needs explicit manual resume using the original runtime pin.

## Command evidence

A command carries exact operator argv/env, declared input IDs and required status.
Receipts record content/context identity, streams, observed paths and direct execution
outcome: complete with exit, unfinished with reason, or not started. Unfinished is not
zero. Command reservations retain unknown effects instead of silently replaying them.
Semantic observations relating commands to criteria/sources/products are model proposals
reviewed against complete command evidence; they cannot redefine argv or exit meaning.

Sources: [plan grammar](../rewrite-src/contract/plan.ts), [answers](../rewrite-src/contract/answers.ts),
[admission](../rewrite-src/core/admission.ts), [input](../rewrite-src/exec/input.ts),
[command](../rewrite-src/exec/command.ts), [settlement](../rewrite-src/core/settlement.ts).
