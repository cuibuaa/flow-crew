The engine offers one read view through `flowcrew state --project <project> --run <run-id>`. Add `--summary` for a bounded view, or `--prompts` to include immutable invocation bytes. The dashboard exposes the same projector at `/api/runs/<run-id>/state?prompts=true`. Stage and supervisor inputs include a bounded snapshot and the query command. A snapshot records an observation; it grants no write permission and cannot establish a passing verdict.

The view includes admitted plan revisions, stage and attempt statuses, declared and observed artifacts, known and unknown token usage, elapsed time and iteration budget, resource leases and waits, open findings, guidance envelopes and prompt coverage. Older runs remain readable. Their `input.md` aliases are explicitly inexact because the engine did not retain every rendered retry, correction, fallback or provider invocation. New records distinguish the adapter boundary from the built-in transport boundary. Provider defaults and hidden provider instructions remain unresolved rather than being invented.

Newly submitted dispatched stages must declare this contract (an explicitly empty `produces` or `reads` list is valid):

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
```

Outputs must be fresh and nonempty unless `nonempty: false` is explicit. `kind` can be `file` or `directory`. Project outputs must belong to the stage's declared scope. Run outputs cannot overwrite engine control records or another stage's evidence. A read from another stage identifies its exact artifact and an ancestor dependency. Existing inputs must exist; framework reads name `task_brief` or `run_state`. The declaration is the authority for a versioned stage. Undeclared prose mentions appear as advisories. Already-admitted untyped historical work and low-level compatibility readers retain their legacy contract, including inferred obligations. A newly submitted old-format stage receives `ARTIFACT_DECLARATION_REQUIRED` naming its missing field. Gates must declare their unconditional `run:verdict_<id>.json` output.

An output can carry `when: {stage: ancestor_id, field: exitCode, equals: 0}`. An unknown fact refuses settlement. Alternative outputs use `groups: [{id: outcome, mode: exactly_one, members: [success, escalation]}]`. Both IDs must be declared; exactly one fresh output must exist. A stage can read a conditional producer output only with the exact same `when` predicate; unknown facts never waive a read. Group alternatives and conditional stage execution need unconditional outcome evidence. New hard reality checks require the same structured `reads` field alongside their existing `type` and `params`. Preflight receives unconditional typed outputs from the exact candidate, so it does not demote their existence checks merely because prose omitted them. Admission checks rooted inputs and producer bindings. The executor rechecks declared reads immediately before running the handler, including settled producer facts. Typed handler parameters must also have declared reads. The executor cannot prove that an arbitrary script declared every dynamic read. Advisory checks keep their existing nonblocking behavior.

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

Replace `stages` with the complete proposed list, including existing stages. New stages require versioned contracts. Revisions occur only when all stages are idle. Existing stages, artifact duties and execution conditions remain present and unchanged; `PLAN_REVISION_EXECUTION_CHANGED` refuses a predicate change that could skip an existing producer. Executed work stages are immutable, and new scopes must fit the initial capability union. The scheduler reruns the same whole-plan admission for roles, dependencies, scope, criteria, terminal ownership and gates, declared inputs, research bindings and reality-check reachability. It retains a digest-bound history carrier and a durable accepted or refused decision committed in the same run-state transaction. Decision files are immutable projections; a retry reconstructs a lost projection without committing the revision again. An unjournaled decision file is refused with `PLAN_REVISION_DECISION_UNJOURNALED`; it cannot grant acceptance by naming an unrelated history entry. Preserve that evidence and submit a new request ID against the current admitted view. Stages cannot declare engine decision projections as their products. Stale requests and reused IDs with different bytes are refused. Removing an existing obligation or migrating an untyped stage's prose requires a new initial plan, rather than an amendment that silently erases authority.

A gate can publish `audit_findings: {version: 1, findings: [...]}` in its declared verdict. Each finding names `id`, exact project `paths`, `reason`, `criterion_ids`, `invalidates_plan` and a configured `repair_role`. A finding that leaves the plan valid produces a repair stage limited to those paths, admitted as a full revision, followed by the authoring gate's re-evaluation. Passing re-evaluation resolves the finding. The initial rejected verdict is retained by content hash. The engine can add a repair prerequisite and reopen the authoring gate for re-evaluation; the prior gate definition and attempts remain in history. A finding that invalidates the plan follows the existing replan path. Undeclared verdicts, foreign criteria, unconfigured roles and scopes beyond the initial capabilities cannot create repair authority.

Stages can reserve resources with `resources: {gpu_cards: [card_id], disk: [{root: project, path: '.', bytes: 1048576, minimum_free_bytes: 1048576}]}`. Acquisitions are atomic in the engine's shared SQLite registry. Disk aliases share a filesystem reservation budget. Contention parks the running attempt before model invocation and appears in the shared state view. Waiting consumes the same immutable execution budget and can end in cancellation or timeout. Identical refusal observations are deduplicated in the ledger. GPU requests require a trusted engine inventory provider; the default runtime refuses them when that provider is absent. A settled controller alone does not prove that delegated consumers stopped. Leases remain active until trusted consumer-closure evidence or previous-boot death proves release safe. This conservative default can retain reservations and needs operator-visible provider integration before routine GPU scheduling.

New run checkpoints bind boot identity and the deployed generation. Startup reconciliation, after excluding a live scheduler, can park a proven prior-boot interruption as resumable, retain completed work and iteration budget, close interrupted attempts as interrupted, and repend only those stages. Resume uses the admitted plan. Unknown process fate, a missing checkpoint or a different generation does not establish safe automatic continuation. Old runs keep their historical recovery behavior; this feature cannot reconstruct missing legacy checkpoints.

The core enforces declaration shape, ownership, topology, admission and truthful settlement. Project policy selection is explicit in local `config/defaults.yaml`:

```yaml
planner_policies: [evidence_statistics]
```

This project's selected statistical evidence instructions concern distributions, feasibility preregistration and comparison with operator expectations. They are appended to the planner system input and captured with the final invocation. A new project does not inherit this selection from the packaged defaults. Unknown or duplicate policy names, null and malformed selections fail with `PLANNER_POLICY_INVALID`. A policy cannot grant write capabilities or override admission. Planning judgement and the dispatch interface remain in the generic prompt.

Before deployment, run the offline decision and state replay tools against a copied baseline distribution and the candidate. `scripts/engine-principles-replay.ts --help` describes the frozen-corpus inputs; its receipts include every decision and its rule. Compatibility changes or unexplained admission differences give a nonzero exit. The intentional migration rule accepts only the exact missing-declaration errors while retaining other core errors, warnings and owners. Native projected stdout remains censored evidence. These tools are available to the operator; they are not yet a mandatory CI deployment gate.
