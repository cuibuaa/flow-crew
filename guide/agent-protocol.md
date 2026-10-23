# Agent protocol

For a contributor or advanced operator: what may a stage submit, and how is it admitted?

## Dispatch

The planner writes `dispatch.yaml` with nonempty `stages` and returns an ordinary stage report; the engine admits the declared plan file.
Recorded YAML lists and historical scope-negotiation artifacts remain readable.
The live generation schema requires `id` and `role`,
rejects unknown fields, and offers these optional stage keys:

| Key | Contract |
|---|---|
| `id` | Lowercase letter, then lowercase letters/digits/underscores; at most 64 characters |
| `role` | Configured role name |
| `scope` | Estimated project paths for reporting; omission becomes `[]` |
| `depends_on` | Ancestor IDs; omission is a root |
| `prompt_template` | Stage task text; `task` remains an accepted alias |
| `condition` | Parsed execution predicate; [condition parser](../src/condition.ts) is the grammar |
| `is_gate` | Independent verification stage |
| `retry_to` | Repair's return gates; gates cannot declare this themselves |
| `criterion_refs` | Canonical IDs; empty/omitted conservatively covers the whole brief |
| `skills` | Stage skill names |
| `dynamic_dispatch` | Runtime plan expansion |
| `artifact_contract` | Versioned rooted output/read locations |

Whole-plan admission checks roles, graph, scope syntax, criterion coverage, terminal
ownership and read reachability before execution. Ordinary authors need downstream independent
gates. Existing-work audits can consist of read-only gates with separate repairs. A malformed
proposal is diagnosed rather than executed partially. `plan-check` uses the same proposal
inspector; its synthetic brief mode cannot supply earlier run artifacts. Scope estimates
do not grant or forbid writes; stages sharing a mutable project tree execute serially.

The recorded admission boundary still recognizes `dependency_reasons` and `max_retries`;
dependency prose is optional and dynamic `max_retries` is stripped. Retired `timeout_ms`,
`timeout_total_ms` and `resources` are stripped as inert metadata. Runtime field validation
uses the shared stage schema; unknown metadata is also stripped. Archived readers do not grant
new launch authority.

Sources: [live schema/checker](../src/plan-interface.ts),
[normalization](../src/scheduler/sched_admission/configuration.ts),
[dispatch admission](../src/scheduler/sched_admission/dispatch.ts).

### Single-author execution and history

Every authoring stage runs one author. New workflow and dispatch competition fields are refused before unknown metadata is
stripped. Brief text and frontmatter run under the visible single-author notice in
each stage input; this also keeps old brief bytes usable on continuation.

Historical workflows and plans use separate tolerant readers. Their competition markers,
candidate patches and records remain evidence; no candidate is launched or selected.
Accepted child gate verdicts retain their original provenance. An unfinished author
continues in the original project with its retained artifacts and an explicit reference
to old candidate records. Unknown historical consumer ownership still blocks recovery.

## Stage budgets and retained continuation

Each execution has one monotonic clock, shared by provider retries, parameter repairs,
guidance continuations and backoff. For a normal budget `B`, the finishing interval is
`W = min(300000, max(1, floor(B / 10)))` milliseconds. The warning is due at
`max(0, B - W - 5500)`. The immutable hard stop is `max(B, W + 5500)`; very short
budgets therefore start in finishing mode and still reserve child retirement.
No numeric default changed: the three-hour default now includes the finishing turn.

The worker persists an attempt-bound guidance envelope, retires the current invocation
through its existing control path and invokes the same adapter with the actionable
wrap-up instruction. Both Codex and Claude use this path. A captured same-attempt UUID
may resume; otherwise the full duties and guidance are supplied to a fresh child.
No cross-stage session reuse is required. The 5.5-second closure window reserves the
existing five-second process-group escalation plus observation. Once that child retires
within the window, at least `W` remains for the finishing turn under a responsive scheduler.
An unresponsive scheduler cannot deliver a timely warning; monotonic settlement still
recognizes expiry, retains the files and records missing delivery rather than inventing it.

A cooperative wrap settles normally. At the hard stop an uncooperative child receives
SIGTERM, followed by SIGKILL after five seconds if needed. Child closure must be verified;
unknown closure refuses further execution. Both outcomes keep admitted files, the output
and live log, with an immutable done/remaining handoff in continuation metadata. Cooperative
authored JSON stays intact; a forced stop publishes a typed partial-work control handoff
instead of inventing an authored result or gate verdict. Unsafe writes and genuine gate
rejections remain refusals. The idle watchdog independently stops lack of verified progress;
a wrap-up does not reset its progress clock.

A completed budget slice is not completed duty or gate acceptance. It cannot release
consumers or publish a passing gate verdict. The next workflow iteration preserves the
admitted DAG, files and completed predecessors, and reopens the unfinished slice and its
consumers. The next author receives its own previous output, live log and attributed
writes. Each slice spends one of the existing finite `max_iterations`; exhaustion is
`incomplete` with retained work, without timeout retry growth. A configured research wall
ceiling also prevents another slice at a budget boundary. Cancel/resume preserves spent
iterations. Gates and configured validation run in independent stage boundaries with
their own budgets, so an author cannot consume their execution time.

## Artifact locations

Optional `artifact_contract` version 1 has `produces` and `reads` lists. Omission supplies
empty locations and a gate's known verdict output. Each output has `id`, `root: project|run`,
relative confined `path`, optional `kind: file|directory` (default file), `nonempty` (default
false) and `when: {stage, field: status|exitCode, equals}`. Each read has `id`, rooted path,
optional kind/when and `source`:

- `{kind: input}` for an existing input;
- `{kind: stage, stage: <id>, artifact: <output-id>}` for a declared ancestor producer;
- `{kind: framework, artifact: task_brief|run_state}` for a known engine input.

IDs are unique within the stage. Produced locations are unique. Planner scope is an estimate; declared outputs remain completion obligations;
run outputs cannot overwrite control records or captured engine evidence. Concurrent run
outputs sharing a location require dependency ordering. A gate publishes its unconditional
`run:verdict_<id>.json`. A declared directory is a capability, not a recursive freshness proof.
Stage reads may name members of a producer directory in the same root. Dependency and
condition admission order execution; settlement and runtime checks use actual producer
and activation facts to verify required outputs and configured reality reads.

Illustrative location declaration:

```yaml
artifact_contract:
  version: 1
  produces:
    - {id: report, root: project, path: docs/report.md}
  reads:
    - {id: brief, root: run, path: task_brief.md, source: {kind: framework, artifact: task_brief}}
```

`groups` can declare `mode: exactly_one` with at least two unconditional output IDs.
Successful settlement checks active required outputs for presence, kind, nonempty policy
and exactly-one groups. Suspended/failed attempts have no completion obligation. The location protocol requires no intermediate
proof package, changed content, age or fresh attribution. Location inspection and identity records do not certify content
quality. Required products and independent gates still govern task settlement; explicit
Reality checks and research measured-round rules remain separate.

Sources: [declarations](../src/artifact-declarations.ts),
[location inspection](../src/stage-artifact-contract.ts), [carrier ownership](../src/engine-owned-carriers.ts).

## Stage answers and gate verdicts

Ordinary stages return one JSON document with `status: delivered|blocked`, nonblank `summary`,
`checks` and `caveats`. Each check has nonblank `command`, integer `exit_code`, nonblank
`evidence`. The injected schema is authoritative; do not handwrite a verdict or a file-list
handoff instead. The engine records writes with their attribution.

A gate returns `pass` and `reason` plus the assigned criterion entries and other fields
required by its injected schema. `criteria` maps each assigned canonical ID to `{status: pass|fail|judgement, evidence: <nonblank>}`.
A passing variant permits pass/judgement entries and requires empty findings; rejection
permits all three statuses and requires its repairability record. Evidence must be nonblank
and passing claims consistent. Both verdict variants require `criteria` and `audit_findings: {version: 1, findings: [...]}`;
a pass has empty findings, and a rejection also requires `repairability`. Extended verdicts
permit additional declared phase/control metadata; a compact direct gate has a closed schema. Native generation is used when a
schema is compatible; otherwise the prompt carries it. Invalid JSON/shape uses the existing
bounded correction in the same execution and deadline; persistent invalidity cannot publish
an authoritative verdict.

An applicable `gate_contract.json` binds metric/name synonyms, threshold, direction and
optional `appliesToGates`. Accepting gates must supply finite numeric evidence when required;
use `value` or `score` plus `metric`, with optional verdict `threshold`. The binding
contract supplies the direction and authoritative threshold. Renaming the metric or asserting
pass below the contract threshold refuses. A missing required accepting value fails before dispatching ordinary product repair;
see [gate recovery](../src/scheduler/sched_settlement/gate-recovery.ts). Phase metadata names are `phase`, `phaseComplete`, `nextPhase`, `outcome`,
`artifactSummary` and `reason`; these do not create a principal metric. Historical separate
metric artifacts remain readable; current gates have no optional campaign principal-metric
publication channel. Gate rejection archives under the injected
`gate_reevaluation/iteration_<n>/round_<n>/` path are durable evidence; the root verdict is live.

A rejection may carry `audit_findings: {version: 1, findings: [...]}`. Findings include exact
project paths, reason, canonical criterion IDs, `invalidates_plan` and configured
`repair_role`. They explain the rejection; they do not create another repair stage.
An admitted repair's `retry_to` returns work to the same independent gate. A passing gate
skips its unnecessary repair while ordinary dependents remain eligible. Exhausted ordinary
repairs stop honestly rather than automatically repeating the whole plan.

`repairability: {version: 1, disposition: repairable|irreparable, evidence: <nonblank>}` is
valid only on rejection. An unchanged canonical verdict bound to a completed gate receipt
can establish an irreparable blocker and terminate escalated before repair. Prose alone,
incomplete/shared unbound evidence, or an invalid declaration cannot grant that authority.
A reviewed author's `blocked` answer settles for the gate to confirm or reject; an unreviewed
blocked answer fails its stage. A pass still requires every assigned brief criterion, including
any explicitly permitted negative/blocked report outcome.

Sources: [result schemas](../src/handoff.ts), [gate evidence](../src/scheduler/sched_settlement/gate-evidence.ts),
[gate contract](../src/scheduler/sched_settlement/gate-contract.ts),
[verdict settlement](../src/scheduler/sched_settlement/gate-verdict.ts),
[repair policy](../src/scheduler/sched_settlement/gate-recovery.ts).

## Scope and plan revisions

A stage's `scope` is the planner's path estimate for reporting and production ownership.
It does not authorize or forbid project content changes. Authors sharing a mutable project
tree execute serially through the scheduling frontier, including stages with disjoint estimates.
Required scripts, tests, reports and validation temporary files need no scope negotiation.
Inputs locate material; only evidence the task explicitly declares frozen is immutable.
The run binds its canonical identities and exact preimages before authors start. Settlement
rejects changed frozen content and restores proven bytes. Exact task outputs take precedence.
Unknown preimages never authorize deletion. Use private `$TMPDIR` scratch for isolated probes.
Historical scope-revision decisions remain readable but do not grant or suspend execution.

A settled stage can submit `plan_revision_request.json` with version 1, request/run/stage/
attempt identity, `attemptStartedAt`, `baseRevision`, `baseDigest`, `reason` and the complete
proposed `stages` list. Revisions require all stages idle. Preserve admitted result obligations
and executed history; unstarted declared tactics may be replaced. Path estimates may change with the tactics. Whole-plan admission
runs again. A decision projection without matching journaled history cannot authorize a revision.
Removing an obligation requires a new initial plan rather than an amendment.

Repair batches use this same idle-boundary admission. Newly appended repair stages
for the active rejected gates finish in dependency order before those gates run
again, within the existing repair round and budget. Every round resets its repair
dependencies before selecting ready work. Each execution wave captures
fresh content observations after earlier authors settle; the gate
receives the combined repair diff from the start of the round. Failed work does not
release its successors or clear the rejection.

Sources: [content settlement](../src/scheduler/sched_scope/write-enforcement.ts), [plan revisions](../src/plan-revisions.ts).
