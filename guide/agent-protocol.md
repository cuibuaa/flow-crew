# Agent protocol

For a contributor or advanced operator: what may a stage submit, and how is it admitted?

## Dispatch

The planner writes `dispatch.yaml` with nonempty `stages` and returns an ordinary stage report; the engine admits the declared plan file.
Recorded YAML lists remain readable. An optional root
`scope_negotiation: {defer: ["<rejected-scope-digest>"]}` explicitly defers a pending scope
planning input; resolving it instead requires predeclaring its requested paths. The scheduler
records the bound disposition without granting new authority. The live generation schema
has required `id` and `role`,
rejects unknown fields, and offers these optional stage keys:

| Key | Contract |
|---|---|
| `id` | Lowercase letter, then lowercase letters/digits/underscores; at most 64 characters |
| `role` | Configured role name |
| `scope` | Project write paths; omission becomes closed `[]` |
| `depends_on` | Ancestor IDs; omission is a root |
| `prompt_template` | Stage task text; `task` remains an accepted alias |
| `condition` | Parsed execution predicate; [condition parser](../src/condition.ts) is the grammar |
| `is_gate` | Independent verification stage |
| `retry_to` | Repair's return gates; gates cannot declare this themselves |
| `criterion_refs` | Canonical IDs; empty/omitted conservatively covers the whole brief |
| `skills` | Stage skill names |
| `dynamic_dispatch` | Runtime plan expansion |
| `race` | Ordinary author competition; see below |
| `artifact_contract` | Versioned rooted output/read locations |

Whole-plan admission checks roles, graph, scope conflicts, criterion coverage, terminal
ownership and read reachability before execution. Ordinary authors need downstream independent
gates. Existing-work audits can consist of read-only gates with separate repairs. A malformed
proposal is diagnosed rather than executed partially. `plan-check` uses the same proposal
inspector; its synthetic brief mode cannot supply earlier run artifacts.

The recorded admission boundary still recognizes `dependency_reasons` and `max_retries`;
dependency prose is optional and dynamic `max_retries` is stripped. Retired `timeout_ms`,
`timeout_total_ms` and `resources` are stripped as inert metadata. Runtime field validation
uses the shared stage schema; unknown metadata is also stripped. Archived readers do not grant
new launch authority.

Sources: [live schema/checker](../src/plan-interface.ts),
[normalization](../src/scheduler/sched_admission/configuration.ts),
[dispatch admission](../src/scheduler/sched_admission/dispatch.ts).

### Planner-selected races

Only an ordinary author can set `race: true`. Gates, planners and repairs cannot race.
Eligible gates use a different role, depend on that author, have empty project scope
and cover its criterion references without owning criteria outside that author. Gates and repairs may also depend on settled author
ancestors whose facts and inputs are projected into both candidates. Candidate repairs
return only to those gates and stay within the author's declared write capability.

Race freezes the current project inputs, then authors one private candidate through its
independent gates and ordinary bounded repairs. If A completes with effective passing gate
facts, it is delivered without setting up or authoring B. Otherwise B receives the same frozen
inputs and must meet the same completion and gate requirements. An approval park or an ungated
completion claim cannot be delivered. A receives restatement guidance as a stage instruction;
the admitted task and criteria stay unchanged.

The selected scoped patch is checked/applied in the parent. The winner's passing gates settle
their admitted dependency IDs with child provenance and no parent gate attempts. Later work
and its own gates still run normally.
The stage retains version 3 `race_<attempt>.json` and patches for attempted candidates only,
including A's failure before B starts; candidate run records retain verification evidence.
Private project copies are reclaimed. There is no separate race CLI or public gate-hold switch.

Sources: [race admission](../src/scheduler/sched_admission/configuration.ts),
[selector](../src/race.ts), [stage integration](../src/scheduler/sched_loop/stage-race.ts).

## Artifact locations

Optional `artifact_contract` version 1 has `produces` and `reads` lists. Omission supplies
empty locations and a gate's known verdict output. Each output has `id`, `root: project|run`,
relative confined `path`, optional `kind: file|directory` (default file), `nonempty` (default
false) and `when: {stage, field: status|exitCode, equals}`. Each read has `id`, rooted path,
optional kind/when and `source`:

- `{kind: input}` for an existing input;
- `{kind: stage, stage: <id>, artifact: <output-id>}` for a declared ancestor producer;
- `{kind: framework, artifact: task_brief|run_state}` for a known engine input.

IDs are unique within the stage. Produced locations are unique. Project writes require admitted scope; declared outputs may request scope before production;
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
and exactly-one groups. Suspended/failed attempts have no completion obligation. Historical
`replays` remain readable but are not executed. The location protocol requires no intermediate
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

When a remedy prescribes a quantity, verdict controls require known-cost evidence and checked
wall/budget arithmetic, or explicit unknown cost. Operator rulings attached to canonical
criteria follow later reviews; they cannot lower a threshold or widen authority.

Sources: [result schemas](../src/handoff.ts), [gate evidence](../src/scheduler/sched_settlement/gate-evidence.ts),
[gate contract](../src/scheduler/sched_settlement/gate-contract.ts),
[verdict settlement](../src/scheduler/sched_settlement/gate-verdict.ts),
[verdict controls](../src/verdict-controls.ts), [repair policy](../src/scheduler/sched_settlement/gate-recovery.ts).

## Scope and plan revisions

Before writing outside admitted scope, a stage submits its injected
`scope_revision_request.json`: version 1, `kind: scope_revision`, unique `requestId`, exact
`runId`, `stageId`, `attemptIndex` and `requestedPaths`, with optional `reason` telemetry.
The scheduler derives SHA-256 `pathDigest` from the canonical path set. Wait without hot
polling for the bound durable decision using notifications or low-rate inspection. Match the
run/stage/attempt/request identity and canonical paths. Acceptance closes the current execution after child closure;
only a later re-admitted execution can use `authorizedPaths`. Partial/denied paths remain
closed. Peer conflicts are rechecked when inherited grants are admitted again.

A settled stage can submit `plan_revision_request.json` with version 1, request/run/stage/
attempt identity, `attemptStartedAt`, `baseRevision`, `baseDigest`, `reason` and the complete
proposed `stages` list. Revisions require all stages idle. Preserve admitted result obligations
and executed history; unstarted declared tactics may be replaced. New scopes fit the initial capability union. Whole-plan admission
runs again. A decision projection without matching journaled history cannot authorize a revision.
Removing an obligation requires a new initial plan rather than an amendment.

Sources: [scope protocol](../src/runtime-negotiation.ts),
[live guard](../src/live-constraint-guard.ts), [plan revisions](../src/plan-revisions.ts).
