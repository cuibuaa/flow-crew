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

Optional `artifact_contract` version 1 describes output and input locations for
write capabilities, ownership and reachability. Omission supplies empty locations
and the gate's known verdict. `produces` and `reads` are explicit lists:

```yaml
artifact_contract:
  version: 1
  produces:
    - {id: report, root: project, path: docs/report.md}
  reads:
    - {id: task, root: run, path: task_brief.md, source: {kind: framework, artifact: task_brief}}
```

Project outputs must belong to the declared scope. Run outputs cannot overwrite
engine control records or another stage's evidence. A stage input names a matching
producer and an ancestor dependency. Existing inputs must exist at admission.
Gates declare their unconditional `run:verdict_<id>.json` publication.

These locations do not create a second content-verification protocol. Intermediate
outputs are not refused for unchanged content, age, missing attribution, emptiness
or alternatives. The engine does not execute declared replay commands. Authors run
targeted checks and the independent gate judges the work and its evidence, using
the engine's configured validation comparison. No separate audit proof package is
required. Historic groups/replay fields and observations remain readable metadata.
`stages/<id>/artifact_contract.json` records available file identities and binds the
current gate publication; it makes no freshness claim about intermediate products.
Directory capabilities are not recursively hashed at attempt boundaries.

Explicit reality checks still use rooted `reads` and recheck their inputs before
executing the handler. Their configured hard properties, final-output archival,
terminal settlement and research measured-round rules remain separate guarantees.
Historical records never authorize execution of recorded commands. A resident old
generation may finish under its admitted generation; generation-bound recovery
still refuses mismatched checkpoints.

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

Replace `stages` with the complete proposed list, including existing normalized stages. New stages use the same compact parser; optional explicit contracts describe output/input locations. Revisions occur only when all stages are idle. Existing stages, capability metadata and execution conditions remain present and unchanged; `PLAN_REVISION_EXECUTION_CHANGED` refuses a predicate change that could skip an existing producer. Executed work stages are immutable, and new scopes must fit the initial capability union. The scheduler reruns the same whole-plan admission for roles, dependencies, scope, criteria, terminal ownership and gates, declared inputs, research bindings and reality-check reachability. It retains a digest-bound history carrier and a durable accepted or refused decision committed in the same run-state transaction. Decision files are immutable projections; a retry reconstructs a lost projection without committing the revision again. An unjournaled decision file is refused with `PLAN_REVISION_DECISION_UNJOURNALED`; it cannot grant acceptance by naming an unrelated history entry. Preserve that evidence and submit a new request ID against the current admitted view. Stages cannot declare engine decision projections as their products. Stale requests and reused IDs with different bytes are refused. Removing an existing obligation or migrating an undeclared historical plan requires a new initial plan, rather than an amendment that silently erases authority.

A gate can publish `audit_findings: {version: 1, findings: [...]}` in its verdict.
Each finding names `id`, exact project `paths`, `reason`, `criterion_ids`,
`invalidates_plan` and a configured `repair_role`. Findings explain the rejection;
they do not generate another repair stage. The admitted `retry_to` repair reads the
archived rejection and returns successful changes to the same independent gate.
Review covers rejected findings and the changed diff. Failed or exhausted repairs
stop honestly without repeating the whole plan. Gate evidence-format refusals do
not dispatch an unchanged model review. Passing next phases and research search
can still advance deliberately; ordinary failure does not trigger outer re-planning.

A rejected gate may declare `repairability: {version: 1, disposition: "repairable" | "irreparable", evidence: "<reproducible evidence>"}`. `irreparable` means that no repair or re-plan can undo the observed failure. A completed gate's unchanged exact declared verdict and protected execution receipt authorize that disposition: the scheduler retains the rejected criteria and evidence, records `run_completed`, and settles `escalated` before dispatching repair or a new plan. An incomplete gate or an unbound/shared carrier cannot authorize it. The disposition never turns a rejection into a pass. Legacy verdicts without this field keep their bounded repair route; reason words do not determine terminality. All neighbouring projects retain that legacy behaviour. Unknown versions/dispositions, extra fields, empty evidence, any repairability field with `pass: true`, or repairability combined with the terminal study completion success contract are refused with a message naming the conflicting declaration. Such a refusal stops without gate-only evidence re-evaluation. Historical records are neither migrated nor rewritten.

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
