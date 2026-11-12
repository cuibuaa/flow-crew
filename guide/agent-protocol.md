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

Whole-plan admission checks roles, graph, scope syntax, criterion coverage and
read reachability before execution. Ordinary authors need downstream independent
gates. Gates are read-only in both static and dispatched graphs; product changes belong to authors
and repairs. Existing-work audits can consist of read-only gates with separate repairs. A malformed
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

### Evidence handoff

Every gate and repair receives one stage contract, structured ledger facts with their
recorded tree/attempt identities, the current diff against the run’s admitted base,
and readable repository/run artifact paths. The projection retains the latest attempt
for each stage and its matching validation, plus earlier verdict records. Diff excerpts
keep the existing byte bound and name the full immutable patch; structured records are
never clipped into invalid JSON. The full brief appears once in the system
contract; criterion assignments name IDs and `brief_criteria.json` instead of printing
the requests again. Review risk areas are structured decision records. Earlier gate
verdicts and engine conclusions remain structured records, including for old runs
whose rejection archives predate the ledger. Missing fields are omitted, never inferred
or summarized. Author final records are visible only to the same stage’s continuation;
other stages receive engine attempt facts and declared blocker status. Retry and replan
preambles carry observed errors, budgets and admission requirements as JSON records;
the result and dispatch schemas remain single-sourced in the stage contract.
When the admitted brief exists, `{task_description}` names its readable path instead
of printing a second copy; standalone callers without a brief retain inline text. The ledger on
disk retains its append-only audit data. Guidance uses its declared target and attempt binding; submitted-input receipts record
delivery without interpreting message wording. Each invocation has private scratch.

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
wrap-up instruction. Both Codex and Claude start a fresh provider session with the full
current contract, ledger and diff, the predecessor’s structured final record (when
available), its validation fact and delivered guidance IDs. Same-attempt corrections
and guidance interruptions also start fresh and receive the preceding invocation’s
structured final record and delivery IDs. No situation retains a live-session exception. The 5.5-second closure window reserves the
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
consumers. The next author receives its own predecessor’s structured final record,
validation fact and delivered guidance IDs through the evidence ledger, plus the current
diff and repository paths. Transcripts and live logs are never handoff input. Without a declaration, each slice spends one of the existing finite `max_iterations`.
Brief frontmatter may declare `max_continuations: N`, a finite nonnegative integer.
Then each stage gets at most N additional unfinished slices within its current workflow
iteration; completed predecessors stay retained. Zero allows the first slice only. The
declaration is persisted with the admitted brief and cannot be renewed by a restart.
Neither research progress nor lack of a product diff changes this allowance. Exhaustion is
`incomplete` with retained work, without timeout retry growth. A configured research wall
ceiling also prevents another slice at a budget boundary. Cancel/resume preserves spent
iterations. Gates have independent stage budgets. Validation settlement uses the remaining author
budget, capped by its whole-batch bound; it cannot consume the gate budget.

## Ending causes and resource waits

Code classifies each execution from boot/process/exit/deadline facts and validated results.
A changed boot resumes the same run without a work retry; a same-host controller crash
uses a separate finite crash count. Work failures retain the configured retry ceiling.
Unknown ownership stays a refusal. Process termination metadata remains readable for
existing consumers; `endingCause` owns budget policy.

An author can report `status: "environment_gap"`, with its existing `summary` stating
the missing capability, observations, and remaining work. This closed status keeps the
ordinary answer schema compatible with native generation. The engine retains it in attempt evidence and sends
it to the independent read-only gate once, without renewing the work or continuation
budget. The gate alone decides whether the stated gap permits acceptance under its
criteria. A gap is not an instruction to waive a required product or a confirmed finding.

A native provider error with typed code `usage_limit_reached` or `quota_exceeded` and
`reset_at` (Unix seconds or an ISO timestamp) parks the run until that reset. The daemon
then resumes the same run without a work retry. A message mentioning a reset without
these structured facts cannot authorize a quota wait; no diagnostic keyword classifier
supplies the missing authority.

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
outputs sharing a location require dependency ordering. The engine publishes a gate's unconditional
`run:engine/verdict_<id>.json` from the gate's final validated structured answer; stage templates must not
instruct gates to write that file. A gate may write its own draft verdict under `work/`; only its schema-validated structured answer is published into `engine/`. All run-rooted stage outputs must be inside `work/`, beside the guarded `engine/` tree. `run.json` and `events.jsonl` retain their run-root paths. A declared directory is a capability, not a recursive freshness proof.
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
    - {id: brief, root: run, path: engine/task_brief.md, source: {kind: framework, artifact: task_brief}}
```

`groups` can declare `mode: exactly_one` with at least two unconditional output IDs.
Successful settlement checks active required outputs for presence, kind, nonempty policy
and exactly-one groups. Suspended/failed attempts have no completion obligation. The location protocol requires no intermediate
proof package, changed content, age or fresh attribution. Location inspection and identity records do not certify content
quality. Required products and independent gates still govern task settlement.
Declared research instruments own scientific verdicts; engineering reality checks use their ordinary contract.

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
`repair_role`, and optionally `reproduction` (a positive evidence-ledger sequence, or null).
Run a targeted command, where exit 0 means the defect is absent and a positive exit
means it is present. Each reviewer invocation receives an engine-recorded command endpoint:
call its supplied client through the native shell tool with a JSON object containing
`command`, absolute `cwd` and absolute `shell`. The parent executes it with the isolated
command environment and the attempt's remaining time, capped at 60 seconds; the response
returns output and `record.sequence` to cite. This works when native events omit context.
Native command events are also eligible when they carry explicit absolute cwd and shell,
exit and output. Replay uses that shell with `-c` in that cwd. Put required shell options
in an explicit invocation in the command. Read the ledger after completion and cite
that command's sequence. The engine records its exit, output digest and unchanged
project tree hash; it confirms a finding only against a failed command from this reviewer
attempt on the reviewed tree. Missing execution context, absent/missing citations and passing
records remain unconfirmed observations. This also applies when reading old verdicts.
Only confirmed findings enter an admitted repair's correction request. The original verdict
and unconfirmed observations remain visible in run facts and the report. Unconfirmed
observations alone open no repair: passing criteria permit acceptance, failed criteria leave
work incomplete. Repair closure replays each confirmed command on the repaired tree and
records its passing exit, output digest, tree hash and `reproductionOf` in the same ledger,
after the attempt's selected validation commands. Dependency preparation, when needed, is part of those declared commands.
No reproduction is a second configured validation.
Native command progress records retain command, context when available, raw exit and output
digest without tree captures. Only engine-recorded reproductions and their closure replays
receive command tree hashes; cite the engine-recorded command endpoint for a finding.
Repair admission uses confirmed reproductions and completed nonzero engine validation records.
A completed record with any nonzero exit always returns the work to repair, whatever the base
tree, the failure identity or the review verdict was; an unfinished record is a resource state
the engine reruns within its allowance, never a finding or a repair reason. A run completes only
when the final tree's record is complete with exit 0 for every declared command. The gate does
not decide whether a failing or unfinished command may stand. A baseline that already exits
nonzero is admitted, so the task may be to make it pass; setup shows one advisory line saying so.
A project with failures unrelated to the task declares a validation command that exits 0 at base.
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

Configured validation belongs to the engine after author/repair settlement, outside the
author invocation and its deadline. Authors run related tests, finish code and deliverables,
and return; they neither execute full validation nor poll its record. The scheduler requests
one content-addressed record and reuses every completed result across stages, gates and resume.

Engine configuration declares `validation_timeout_ms`, `validation_attempts`,
`validation_concurrency` and `validation_priority` (Unix niceness adjustment); the brief's
`validation.timeoutMs` and `validation.attempts`, else the project's `config/validation.json`, replace the first two. A store-wide
FIFO coordinates separate daemon scheduler processes. Duplicate requests share their tree's
owner. Each command gets a share of the remaining batch allowance. An opaque command that
combines build and tests remains one declared command; its text is never parsed.

Records contain tree identities before and after each resource execution, exact executable,
argv and declared non-secret environment, direct exits (null when absent), bounded output,
structured reporter totals, duration and load telemetry. All zero completed exits accept;
any completed nonzero validation rejects and has an engine-record-derived repair finding.
Output spelling, test IDs, totals, elapsed times, errors from optional reporting and load
cannot override those exits. Independent review still examines every assigned criterion.
No candidate confirmation, base suite or model failure-disposition handshake runs.

An unfinished batch is engine resource work. The engine retries within its numeric allowance;
exhaustion parks the run without another author attempt, review verdict or repair round.
Resume preserves spent resource attempts; completed nonzero records remain rejected.
Cancellation removes queued requests and retires owned commands. Dead scheduler slots remain
occupied until their checkpoint-owned commands have retired. Historical record fields remain
readable; supported complete tree-bound raw receipts can populate the new cache without
executing again. Projection does not rewrite historical bytes.

Declare project isolation inputs in each command's `env` map (or preserve them in
the explicitly selected executable/argv). The engine overlays that map on ordinary
inherited inputs and records it beside argv. If an explicit variable would be
suppressed by control/credential isolation, the command stays unrun and unverified;
the engine never silently executes with that variable missing. Do not declare secrets.

Projects may declare validation argv, non-secret environment inputs and reporters in `config/validation.json`, using
the same `{commands: {build|test|lint: {command, args, env?, report?}}}` declaration as brief
frontmatter. Project declarations take
precedence over overlapping brief declarations. An invalid project declaration refuses
selection before execution; it never silently guesses another command. A report is declared as
`{format: "vitest-json", path?: "project-relative-file.json"}`; omit `path` only when
stdout is JSON alone. File reports must be freshly written, remain within the project,
and fit the 1 MiB evidence bound. Valid, exit-consistent exhaustive reports own failure
identity even when stdout or stderr also carries human diagnostics. Incomplete suite,
snapshot or global-error populations remain partial; malformed or exit-inconsistent
reports remain unknown, without model fallback. Without a declared reporter, failure identity remains unknown. Reporter identity and totals are for readers; they do not classify validation outcomes. Without any command declaration, the author
model reads the repository and chooses commands via `ValidationSelectionSchema` in its existing result; an empty
or invalid selection is explicitly unverified, with no discovery fallback.
This repository declares its test reporter in `config/validation.json`; the reporter
uses Vitest's structured global-error and completion facts to declare completeness.

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

A settled stage can submit `work/stages/<id>/plan_revision_request.json` with version 1, request/run/stage/
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

Declared research reviews use the ordinary independent gate carrier and explicit project criteria. Research authors receive the incumbent and all committed instrument outcomes, observations, diagnostics and opaque state unchanged. Author results are advisory; only a validated frozen instrument response can decide keep or reject.
