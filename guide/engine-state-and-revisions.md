The engine offers one read view through `flowcrew state --project <project> --run <run-id>`. Add `--summary` for a bounded view, or `--prompts` to include immutable invocation bytes. The dashboard exposes the same projector at `/api/runs/<run-id>/state?prompts=true`. Stage and supervisor inputs include a bounded snapshot and the query command. A snapshot records an observation; it grants no write permission and cannot establish a passing verdict.

The view includes admitted plan revisions, stage and attempt statuses, declared and observed artifacts, known and unknown token usage, elapsed time and iteration budget, resource leases and waits, open findings, guidance envelopes and prompt coverage. Older runs remain readable. Their `input.md` aliases are explicitly inexact because the engine did not retain every rendered retry, correction, fallback or provider invocation. New records distinguish the adapter boundary from the built-in transport boundary. Provider defaults and hidden provider instructions remain unresolved rather than being invented.

Retired stage history is optional read evidence, separate from the active stage graph. Malformed history rows are omitted with `RUN_STAGE_HISTORY_INVALID` diagnostics: the run-detail API exposes `stageHistoryDiagnostics`, and status and summary output name the gap. Valid retired rows and readable core run data remain visible; no record is repaired or retired stage reactivated.

New dispatched plans use a YAML stage list. `id` and configured `role` are required;
`scope` names project writes and omission is closed. Omitted `depends_on` is a root.
Empty/omitted `criterion_refs` conservatively cover the whole brief; nonempty subsets
use canonical IDs. Ordinary work requires a downstream independent gate. Existing-work
audits can use read-only gates and separate `retry_to` repairs; gates in that plan have
empty project scope. Scope amendments re-run whole-plan admission before granting writes.
Dependency prose is optional historical metadata.

`flowcrew plan-check --project <project> --brief <brief-file> <dispatch-file>`
checks a draft with the live parser and whole-plan admission without launching work.
It uses a synthetic empty run root, so run inputs from earlier work require the actual
admission boundary. Historical readers remain tolerant; new unknown fields are refused.
The same JSON Schema is appended to built-in and local planner-role prompts.
Only dispatch.yaml is compulsory planning output. Analysis and reality-check documents
are useful when consumed, rather than required empty packages.

Optional `artifact_contract` version 1 declares exact outputs, reads and replay commands.
An omitted live stage contract becomes empty duties plus the known gate verdict when applicable.
Explicit duties retain the enforcement below; revisions cannot erase them. Each of `produces`, `reads` and `replays` is present;
an explicit empty list is valid:

```yaml
artifact_contract:
  version: 1
  produces:
    - {id: report, root: project, path: docs/report.md}
  reads:
    - id: task
      root: run
      path: task_brief.md
      source: {kind: framework, artifact: task_brief}
  replays: []
```

Outputs must be fresh and nonempty unless `nonempty: false` is explicit. `kind` can be `file` or `directory`. Project outputs must belong to the stage's declared scope. Run outputs cannot overwrite engine control records or another stage's evidence. A read from another stage identifies its exact artifact and an ancestor dependency. Existing inputs must exist; framework reads name `task_brief` or `run_state`. Prose mentions and script literals create no obligations. Gates declare their unconditional `run:verdict_<id>.json` output.

An old-format stage is refused with `ARTIFACT_DECLARATION_REQUIRED` naming
`<stage>.artifact_contract`. A contract without the replay list is refused with
`REPLAY_DECLARATION_REQUIRED` naming `<stage>.artifact_contract.replays`.
The remedy is to declare the exact duties or explicit empty lists, never to
transcribe old prose into another prompt.

An output can carry `when: {stage: ancestor_id, field: exitCode, equals: 0}`. An unknown fact refuses settlement. Alternative outputs use `groups: [{id: outcome, mode: exactly_one, members: [success, escalation]}]`. Both IDs must be declared; exactly one fresh output must exist. A stage can read a conditional producer output only with the exact same `when` predicate; unknown facts never waive a read. Group alternatives and conditional stage execution need unconditional outcome evidence. Reality checks, including advisory checks, require structured `reads` alongside `type` and `params`. Preflight receives unconditional typed outputs from the exact candidate, so it does not demote their existence checks merely because prose omitted them. Admission checks rooted inputs and producer bindings. The executor rechecks declared reads immediately before running the handler, including settled producer facts. Typed handler parameters must also have declared reads. The executor cannot prove that an arbitrary script declared every dynamic read. Advisory check failures remain nonblocking and visible.

Replay declarations name file artifact IDs, never shell text or report passages.
For example, successful Node test evidence can declare a produced test:

```yaml
artifact_contract:
  version: 1
  produces:
    - {id: regression, root: project, path: checks/regression.test.mjs}
  reads: []
  replays:
    - id: regression
      runner: node_test
      targets: [regression]
      argv: []
      expected: {exit_code: 0, failures: []}
```

An audit can verify a reproduction that correctly fails on current code:

```yaml
artifact_contract:
  version: 1
  produces:
    - {id: reproduction, root: run, path: stages/audit/reproduction.test.mjs}
  reads: []
  replays:
    - id: reproduce_defect
      runner: node_test
      targets: [reproduction]
      argv: []
      expected:
        exit_code: 1
        failures:
          - {artifact: reproduction, test: reproduces current defect}
```

The engine executes every declared replay and verifies each target's actual
collection and execution, direct exit and exact failing test identities. An
unrelated failure, import error, empty or all-skipped target, signal, spawn
failure or timeout refuses verification. A verified failing reproduction does
not make a failing audit verdict pass; it establishes the evidence the audit
claimed. A line such as `npm test -- spec/change.test.ts: exit 0` in a report
has no executable authority.

Supported runners are `node_test`, a locally configured `vitest run`, and a
locally configured `pytest` recipe. `argv` accepts only the runner's test-name
filter (`--test-name-pattern` for Node; `--testNamePattern` or `-t` for Vitest),
or pytest verbosity and `-p no:cacheprovider`. Targets are unconditional exact
file IDs in this stage's `produces` or `reads`; directories, conditional outputs
and exactly-one alternatives cannot be targets. Admission refuses unsupported
arguments, unbound targets, duplicate IDs and more than 32 replay declarations.

The replay budget defaults to `config/defaults.yaml::default_validation_timeout_ms`.
Optional replay `timeout_ms` may lower that bound; it cannot raise it or exceed
the immutable attempt's remaining time. The audit records effective budget,
elapsed time, direct exit, signal and timeout. A timeout is reported before
secondary missing-runner-output diagnostics.

`stages/<id>/artifact_contract.json` retains one observation per declared replay,
with `processes` for each direct invocation and `targets[].tests` for every
reported name and outcome, including observations from refused collection.
Node errors retain nested `cause` and assertion fields; Vitest retains emitted
failure messages/details; pytest retains JUnit failure bodies. Node's forwarded
test stdout/stderr and diagnostic events live in `targets[].runnerOutput`,
separately from the direct process pipes. Stream records include byte counts,
hashes and explicit truncation flags; text prefixes are limited to 16,384
characters. Nested diagnostics limit strings to 8,192 characters, depth to eight,
and object/array entries to 128, with omissions labelled. Forwarded Node output
keeps at most 128 events and 262,144 serialized characters, with omitted-event
counts. Named results are retained before process-log truncation.

`observation` records timing/load and declared-target identities before and after
execution, plus the module and manifest observed on disk at replay start. These
snapshots do not attest transitive inputs, external state or already loaded code.
The policy is `single_execution_no_confirmation`: no automatic confirmation or
retry changes acceptance. An unexpected failing check remains refused; a later
pass does not identify the earlier failure as a flake. Legacy audits retain their
original fields; absent diagnostics are not reconstructed or written back.

Earlier run artifacts remain readable: their recorded obligations, replay
executions, advisories and verdicts stay data. Reading them does not derive new
commands or duties. A resident process on the old admitted generation may finish
under that generation. A new generation refuses an undeclared in-flight plan at
`DECLARED_INPUT_MIGRATION_REQUIRED` before work or publication; it does not
silently resume it with inferred obligations. Preserve the original generation
for that work, or start a new declared run. Generation-bound recovery can also
refuse a mismatched checkpoint.

A settled stage can write a complete proposal to its own stage directory's `plan_revision_request.json`:

```json
{
  "version": 1,
  "requestId": "extend_after_outcome",
  "runId": "<run-id>",
  "stageId": "<requesting-stage>",
  "attemptIndex": 1,
  "attemptStartedAt": "<exact latest execution timestamp>",
  "baseRevision": 0,
  "baseDigest": "<current admitted plan digest>",
  "reason": "The settled outcome establishes the next work.",
  "stages": []
}
```

Replace `stages` with the complete proposed list, including existing normalized stages. New stages use the same compact parser; an optional explicit contract includes `replays`. Revisions occur only when all stages are idle. Existing stages, artifact duties and execution conditions remain present and unchanged; `PLAN_REVISION_EXECUTION_CHANGED` refuses a predicate change that could skip an existing producer. Executed work stages are immutable, and new scopes must fit the initial capability union. The scheduler reruns the same whole-plan admission for roles, dependencies, scope, criteria, terminal ownership and gates, declared inputs, research bindings and reality-check reachability. It retains a digest-bound history carrier and a durable accepted or refused decision committed in the same run-state transaction. Decision files are immutable projections; a retry reconstructs a lost projection without committing the revision again. An unjournaled decision file is refused with `PLAN_REVISION_DECISION_UNJOURNALED`; it cannot grant acceptance by naming an unrelated history entry. Preserve that evidence and submit a new request ID against the current admitted view. Stages cannot declare engine decision projections as their products. Stale requests and reused IDs with different bytes are refused. Removing an existing obligation or migrating an undeclared historical plan requires a new initial plan, rather than an amendment that silently erases authority.

A gate can publish `audit_findings: {version: 1, findings: [...]}` in its declared verdict. Each finding names `id`, exact project `paths`, `reason`, `criterion_ids`, `invalidates_plan` and a configured `repair_role`. A finding that leaves the plan valid produces a repair stage limited to those paths, admitted as a full revision, followed by the authoring gate's re-evaluation. Passing re-evaluation resolves the finding. The initial rejected verdict is retained by content hash. The engine can add a repair prerequisite and reopen the authoring gate for re-evaluation; the prior gate definition and attempts remain in history. A finding that invalidates the plan follows the existing replan path. Undeclared verdicts, foreign criteria, unconfigured roles and scopes beyond the initial capabilities cannot create repair authority.

Generated repairs retain the rejected producers' and gate's declared reads and replay checks. Named outputs keep their declared shape; other outputs remain reads bound to their existing owners. The existing stages and their duties stay unchanged in the revision. The repair reads the durable rejected verdict, with its content digest and gate execution recorded in the prompt. The engine refuses a changed or stale verdict whose protected artifact receipt does not match the current completed execution. Conditional stages, conditional outputs and exactly-one groups require a complete outcome repair and are refused by the narrowed file repair builder with `SCOPED_REPAIR_CONDITIONAL_DUTY`; declare that repair in a new complete plan. Checks exceeding the combined replay limit are also refused rather than dropped. Fixed `retry_to` repairs remain available alongside generated repairs.

A rejected gate may declare `repairability: {version: 1, disposition: "repairable" | "irreparable", evidence: "<reproducible evidence>"}`. `irreparable` means that no repair or re-plan can undo the observed failure. A completed gate's unchanged exact declared verdict and protected execution receipt authorize that disposition: the scheduler retains the rejected criteria and evidence, records `run_completed`, and settles `escalated` before dispatching repair or a new plan. An incomplete gate or an unbound/shared carrier cannot authorize it. The disposition never turns a rejection into a pass. Legacy verdicts without this field keep their bounded repair route; reason words do not determine terminality. All neighbouring projects retain that legacy behaviour. Unknown versions/dispositions, extra fields, empty evidence, any repairability field with `pass: true`, or repairability combined with the terminal study completion success contract are refused with a message naming the conflicting declaration; the evidence producer is re-evaluated within the existing budget. Historical records are neither migrated nor rewritten.

New stage declarations containing `resources` are refused with `RESOURCES_RETIRED`;
remove that key. Archived resource observations remain displayable in recorded runs.

New run checkpoints bind boot identity and the deployed generation. Startup reconciliation, after excluding a live scheduler, can park a proven prior-boot interruption as resumable, retain completed work and iteration budget, close interrupted attempts as interrupted, and repend only those stages. Resume uses the admitted plan. Unknown process fate, a missing checkpoint or a different generation does not establish safe automatic continuation. Old runs keep their historical recovery behavior; this feature cannot reconstruct missing legacy checkpoints.

The core enforces declaration shape, ownership, topology, admission and truthful settlement. Project policy selection is explicit in local `config/defaults.yaml`:

```yaml
planner_policies: [evidence_statistics]
```

This project's selected statistical evidence instructions concern distributions, feasibility preregistration and comparison with operator expectations. They are appended to the planner system input and captured with the final invocation. A new project does not inherit this selection from the packaged defaults. Unknown or duplicate policy names, null and malformed selections fail with `PLANNER_POLICY_INVALID`. A policy cannot grant write capabilities or override admission. Planning judgement and the dispatch interface remain in the generic prompt.

Before deployment, run the offline decision and state replay tools against a copied baseline distribution and the candidate. `scripts/engine-principles-replay.ts --help` describes the frozen-corpus inputs; its receipts include every decision and its rule. Compatibility changes or unexplained admission differences give a nonzero exit. The intentional migration rule accepts only the exact missing-declaration errors while retaining other core errors, warnings and owners. Native projected stdout remains censored evidence. These tools are available to the operator; they are not yet a mandatory CI deployment gate.

Own-stage Codex continuation uses the stage's explicit UUID and isolated home across
corrections, retries and accepted scope suspension. Every execution renews its
write boundary and re-admits inherited scope against active peers; continuity
never grants capability. A parallel member settles and resumes at its own closed
child boundary while disjoint peers continue. A conflict waits for the next wave.
Validation stages never inherit a builder's session. A disproved gate verdict
still clears the gate's continuation. Resume errors remain recorded; a diagnosed
fresh fallback receives the complete duties and every previously delivered notice.
Successful terminal homes keep the existing cleanup policy.

Invocation input gives the controller's immutable absolute deadline and current
remaining time. Query UTC with `node -e "console.log(new Date().toISOString())"`;
time advice cannot extend the execution. Ordinary guidance waits for active tools
to close; explicit command stops and timeout projections retain their authority.
Empty tool-boundary guidance checks no longer append events or rewrite receipts;
execution and invocation checks, deliveries and command lifecycle records remain.
The prompt gives a state-query locator and admitted revision binding. The complete
read-only state and immutable invocation inputs remain available through the CLI.
