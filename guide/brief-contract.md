# Brief contract

For a task author: how do I express the outcome, evidence and limits the run must satisfy?

Write a self-contained outcome, explicit input paths, real constraints and numbered acceptance
criteria. Name the report and the evidence it must show. Separate a required property from
an illustrative implementation. The preflight wording lint warns about mandatory
implementation verbs attached to code-shaped targets; warnings do not prove a criterion is
wrong or waive a compatibility requirement.

## Engineering and workflow selection

This is an illustrative engineering envelope, not a complete launch-ready task:

```yaml
---
workflow: direct
inputs:
  - src/
outputs:
  - path: docs/result.md
    on_existing: update
validation:
  commands:
    build: {command: npm, args: [run, build]}
    test: {command: npm, args: [test]}
    lint: {command: npm, args: [run, lint]}
---
```

Follow it with the goal, constraints and extractable acceptance criteria. `workflow: direct`
selects a fixed author/gate/repair plan; `workflow: planner` or omission uses the planner.
Numeric research selects the research workflow unless an explicit CLI workflow overrides it.
Direct research and program loops are refused. Input/output count does not choose the workflow.

`objective:` is an exact alias for `research:`, with `research` winning when both exist.
A numeric `baseline` activates the metric loop. An engineering `objective` containing only
`confirm` does not activate confirmation. Use normal engineering gates and configured
validation for a pass/fail task.

Sources: [frontmatter](../src/scheduler/sched_admission/brief-contract.ts),
[criteria extraction](../src/brief-criteria.ts), [preflight](../src/brief-preflight.ts).

## Inputs, outputs and validation

Declare inputs in leading YAML frontmatter. Project-relative directory names are accepted
without a trailing slash there; unsafe declarations are reported unresolved. Code also has
conservative prose path discovery, but explicit declarations avoid depending on it.
Mechanically bound row-count, date-span, recursive file-count and SHA-256 assertions can be
confirmed, refuted or not checkable. Setup refuses unproven required input assertions.

Outputs accept path strings or structured entries with `path`, optional `type: file|directory`
and `on_existing: update|append|replace`. They are create-only by default. Declaring an existing
output as an input records intentional reuse. Nonempty create-only files, create-only symlinks
and unsupported entry types block the output inventory. Explicit existing-content authority
admits project symlinks. Archival preserves symlink objects without traversing their targets.
Absolute external outputs require an explicit directory declaration: protected/root-level
overlaps and aliases are refused.
Their contents are not recursively inventoried by preflight. Rehearsal substitutes temporary
locations. A declaration is authority for its named location, not permission for siblings.
Project outputs may lie inside declared input directories: input preservation excludes the
declared output file or directory tree, while other input paths stay protected. Stage write
scope and existing-content rules still apply.

`validation.commands` is a nonempty mapping of `build`, `test` and/or `lint` to
`{command: string, args: string[]}`. These declarations supply shell-free argv; unknown roles,
extra fields and control characters refuse parsing. Without declarations, setup discovers
commands from project configuration. [Setup](operations.md#setup-validation) owns the exact
baseline and comparison semantics. Do not replace the full configured suite with a subset.

Sources: [input/output inventory](../src/ship-inputs.ts), [setup parser](../src/cli-ship-setup.ts),
[validation discovery](../src/project-validation.ts).

## Research rounds

The [tracked research brief](../examples/hello-research.brief.md) is a complete rehearsal
example. The metric block accepts these fields:

| Field | Meaning |
|---|---|
| `baseline` | Numeric reference activating the native loop |
| `policy` | `greedy_stack` (default), `best_of_n`, `replace_if_better`; invalid names are diagnosed |
| `higher_is_better` | Direction; defaults higher; boolean strings are also recognized |
| `result_file`, `report_dir` | Mutable round slot and report directory; [resolver](../src/research-paths.ts) supplies omitted paths |
| `result_schema` | JSON schema for each measured round |
| `context_roots` | Context inventory roots |
| `integrity.max_std_ratio`, `outlier_factor` | Declared variability/outlier bounds |
| `integrity.field_floors` | Numeric minimums for named result fields |
| `integrity.reject_if_positive` | Named fields that must not be positive |
| `confirm.command`, `requires`, `timeout_seconds`, `reads` | Optional real shell check, human assertion, bound and rooted reads |
| `stop.beat` | Ship target, inclusive in the declared direction |
| `stop.max_rounds`, `max_wall_hours`, `halt_after_no_improvement` | Stop budgets |
| `stop.min_improvement`, `improvement_se_multiple` | Required gain beyond running best and reported uncertainty |
| `feasibility` | Optional structural preflight model; see below |

A measured round supplies numeric `result`, a nonblank `label`, and optionally `result_std` and declared
schema fields. No safe acting candidate uses the fresh `<result_file>.no_candidate.json`
sidecar with `label`, `outcome: no_candidate` and a nonblank `reason`. Exactly one slot may
be fresh. No-candidate rounds consume stop budget without inventing a baseline observation.
Duplicate journaled labels are refused. Accepted rounds enter `research_journal.json` and
the report directory's exact `run_manifest.json` before confirmation.

Before dispatch, the engine snapshots the content identities of both result slots and existing
inferred `evidence.json` files in `run.json.researchInputGeneration`. Admission and inference
share the same confined regular-file domain, with the existing 4 MiB evidence limit; aliases
and special files are not read as evidence. Content identities use the existing nonblocking,
no-follow regular-file reader. Explicit result slots retain confined internal aliases, using
their canonical file identity; inferred evidence still requires a regular directory entry.
A new publication changes content relative to that snapshot or is evidenced by a completed
current-iteration producer attempt's settled write ledger. Equal measurement bytes remain valid
when that ledger proves current production; touching an old file alone does not prove it.
Backward clock steps therefore cannot discard a newly published round. The snapshot
survives resume, while journal labels and immutable consumed copies prevent counting a round
twice. A legacy run without a snapshot preserves pending publications recorded in the closed
current-iteration producer attempt's write ledger, using the same publication rule. Independent review still decides whether
that result is accepted, without repeating completed production. The existing confined project
alias resolver and regular-file device/inode identity bind a result slot to that producer's
recorded write, including project-local hardlinks. An independent file with identical bytes
does not prove publication. Other pre-existing files are snapshotted as old; a completed stage
name alone does not prove publication. Once established,
the snapshot survives every resume.

Variability and outlier bounds apply only when declared. Reported uncertainty still determines
whether a gain counts; surprising gains and high variance need independent review or a declared
confirmation check.

The latest result and sidecar change between rounds. Immutable round evidence and the
framework manifest record accepted observations. Configured validation and independent
review decide whether authored tests remain valid after later work. Hard-check reachability
is checked against the round timeline.

An unknown policy produces a strict-parser error and a preflight finding.
`plan-check` refuses that error; an explicit quick launch can retain the
parser's `greedy_stack` fallback. Set a valid name rather than assuming the diagnostic is an
unconditional launch barrier.

The policy computes keep/drop and continue/ship/ceiling. Improvement must clear the configured
absolute margin and, when reported, uncertainty margin. Confirmation runs only when declared
and a ship decision is reached. Failure prevents that candidate from being kept and permits
further search; missing confirmation produces an advisory warning. Static budget checks compare round, iteration and wall limits; a large round limit
cannot override the engine iteration bound.

Sources: [policy](../src/research-policy.ts), [research settlement](../src/scheduler/sched_policy/research.ts),
[research path contract](../src/scheduler/sched_policy/prompt-contracts.ts),
[candidate validation](../src/research-candidate.ts).

### Structural feasibility and statistics

`feasibility` requires positive finite `hard_floor`, optional `warn_below` at least that floor,
and nonempty `rules` with unique labels. A rule names one model:

- `independent_repeated_conjunction`: positive integer `population` and `periods`,
  `per_period_rate` between zero and one; estimates population × rate^periods.
- `formation_count_distribution`: nonempty nonnegative integer `counts`; evaluates the
  minimum formation count and reports its distribution.
- `not_computable`: nonblank `reason` naming the unavailable structural quantity.

This static contract can be parsed without activating a numeric loop. It does not establish
that the chosen model fits the real problem. Unknown fields/models return parser errors;
preflight reports them, while `plan-check` refuses them.

Sources: [feasibility](../src/research-feasibility.ts), [planning policies](../src/planner-policies.ts).

## Evidence authoring policy

When leading brief frontmatter selects `planner_policies: [evidence_statistics]`, the planner receives
these authoring requirements: a requested headline or quoted statistic needs its mean, median
and position in its own distribution; a rule frozen before outcomes needs a structurally
computed qualifying-member count, numeric feasibility floor and revision below that floor
before outcomes are seen. An operator numeric expectation requires exact result fields
`within_expected_range` and `method_was_not_adjusted_to_match_expectation`. These are injected
planning instructions, not an automatic statistic calculator or guarantee of model obedience.

For other evidence, state the user-visible consequence, boundaries, counter-examples and
unacceptable outcomes. Preserve an authoritative exact mechanism when it is required; label
illustrative mechanisms as examples. For a known defect, require the unfixed reproducer and
recurrence evidence, including a failure rate with its denominator when recurrence matters.
Do not replace an outcome with a line-count check; if a count itself is a supplied requirement,
it remains binding. Explain concentrated contributions with per-item, largest-share and
leave-one-out evidence when those properties are part of the task.

Sources: [selected planning policy](../src/planner-policies.ts),
[criterion wording lint](../src/brief-preflight.ts), [gate contract](../src/scheduler/sched_settlement/gate-contract.ts).

## Authoring and verification principles

These are author/operator judgments to encode when relevant, not extra engine schemas or
promises that a model will obey. Keep the detailed contract above authoritative.

### Scope and evidence

- Keep work of one kind in one task; let its planner decompose and parallelize it.
  Reason: an operator-created chain removes choices the planner can make with the whole goal.
- Split only genuinely different kinds of work and run independent pieces in parallel.
  Reason: serial queues of related work add coordination and delay without improving ownership.
- State what the run must find, leaving its approach, decomposition and interpretation open.
  Reason: supplying those conclusions turns investigation into following the operator's answer.
- Keep the brief near one page of outcome, evidence paths, real constraints, timed report criteria
  and terminal products; omit speculative approaches and histories of what evidence means.
  Reason: extra interpretation is where unverified context becomes an accepted premise.
- Supplied quantities and prohibitions bind exactly as written; state when an enumeration is
  incomplete and require discovery of omitted dependencies before acting on it.
  Reason: honoring a visible count can leave the unstated quantity it depends on unchanged.
- An out-of-scope list must contain only real exclusions; identify open dimensions explicitly
  rather than relying on an unmentioned option remaining available.
  Reason: a seemingly complete constraint list can close useful work unintentionally.
- Give original evidence paths and require reading them; a supplied figure is a cross-check,
  accompanied by the anti-anchoring fields, rather than a settled premise.
  Reason: a summary preserves its author's confidence while losing the evidence they omitted.
- State the property to establish in the target, rather than a manually derived answer from
  the operator's environment; label an operator measurement as a cross-check.
  Reason: the target can differ and must expose disagreement instead of silently reconciling it.

### Criteria and inputs

- Constrain rigor through required reproduction, controls, independent review and evidence,
  rather than predetermining the finding; pin each check to its moment and evidence form.
  Reason: demanding a finding invites reshaping the work, while an untimed check may precede its last write.
- Label examples, including parenthetical examples, as illustrative rather than acceptance
  criteria; if an exact path, API or format is mandatory, say it is the criterion and alternatives fail.
  Reason: gates must distinguish an illustrative instrument from an authoritative compatibility requirement.
- Pair a prohibition on an exact case with a quantitative demonstration of the intended effect,
  such as a control difference, count or interval excluding the null.
  Reason: a nearly identical result can satisfy an exact-case prohibition without achieving the purpose.
- Keep task-local criteria independent of a shared running total.
  Reason: another task's accumulated work cannot establish that this task performed its obligation.
- Map every authored stage's writable paths, including validation outputs, to its outputs and
  declared reads; identify the writers of substantive evidence. Treat `min_wall_minutes` at or
  below 10 as an anti-instant-quit guard only.
  Reason: a clock or an early terminal file cannot prove that downstream verification happened.
- Require preflight, rehearsal and setup to agree on declared output inventory and intended
  existing-content authority before launch.
  Reason: an occupied path does not become safe merely because it is the requested output name.
- Prose paths can become input candidates even without frontmatter declarations; distinguish
  outputs and explicitly excluded paths, or keep hypothetical paths in fenced examples.
  Reason: an out-of-scope heading alone does not make a path mention an explicit exclusion.
- Declare only intended task inputs and inspect target content/type collisions rather than
  adding unrelated declarations to silence discovery; setup's target-copy rules remain authoritative.
  Reason: excess inputs can import unrelated work or ask for incompatible materialization.
- Use guidance for missing facts or correction of an operator error, not delayed scope or
  replacing a required property with a preferred result; preserve better brief-conforming results.
  Reason: erasing criteria or widening authority requires a revised, rehearsed brief and new admission.
- Repeated engineering guidance suggests an incomplete brief; research steering on intermediate
  evidence can be intentional. Check the addressed stage's consumption receipt and changed artifact.
  Reason: sending guidance proves neither that the worker received it in time nor that it took effect.

### Measurement and limits

- Confirm supplied baselines, floors and thresholds on the candidates' scale against the
  unchanged incumbent, input or constant control appropriate to the task.
  Reason: the best result so far can still be worse than changing nothing.
- Before creating a harness, collector, evaluator or execution path, name what the project
  already provides and why it does not serve this comparison or isolation requirement.
  Reason: otherwise the run can silently measure its own replacement for an existing capability.
- Identify every bound on a limited quantity, establish which binds first and state what to
  do at exhaustion; reserve enough budget to audit and report the final attempted round.
  Reason: a second cap can nullify a raised limit or stop the run before its required report.
- For a stateful defect compare unfixed reproduction with the fixed result; for a probabilistic
  defect compare before/after failure rates with denominators; isolate mutations where only the guard protects behavior.
  Reason: success after a change does not prove that change corrected the claimed defect.
- Name and use the repository's reproducible runtime selector; treat failed launch, build,
  test or lint execution as environment evidence before drawing a domain conclusion.
  Reason: inability to execute an experiment says nothing about the subject it was meant to measure.
- Before teardown, identify an input's later consumers, preserve its only copy durably and
  bind useful row-count, date-span, file-count or digest assertions to that preserved location.
  Reason: a successful round is unusable if the next consumer loses its evidence.
- Shared accumulating records are append-only without restructuring, with non-decreasing
  line counts; permit a visibly traced in-place correction of this task's own false claim.
  Reason: protecting history should neither hide a correction nor erase another task's evidence.
- For each census item give its user-visible consequence; classify consequence-free entries
  as drift and explain whether fixing them pays back its cost, rather than imposing a zero target.
  Reason: a count of differences is not a count of defects worth repairing.
- For every aggregate show result and baseline distributions, per-item contributions, largest
  share, leave-one-out results and the fewest top contributors whose removal flips the conclusion.
  Reason: a favorable total can depend on a small exceptional subset rather than a general effect.

### Independent acceptance

- Read durable declared-check and gate evidence alongside actual deliverables. Reproduce a
  rejected declaration independently; rerun a recorded script verbatim with full stdout/stderr and its direct exit code.
  Reason: a terminal label or summary cannot replace the evidence that decided the run.
- Record direct command exits and totals; never report `$?` after a pipeline as the measured
  command's exit, and prefer structured parsing to lossy shell filters for decision-changing numbers.
  Reason: a successful filter or plausible default can hide failure in the command being assessed.
- A green rerun only makes a false negative plausible; characterize recurrence, explain the
  first failure's mechanism and assess residual uncertainty against the task's risk.
  Reason: one success cannot dismiss an intermittent failure whose cause remains unknown.
- For a near-instant, zero-token failed attempt inspect its live log and adapter transition
  before treating it as substantive evidence; ask what a numeric probe returns when broken and verify plausible values another way.
  Reason: an execution failure or silent fallback can look like a believable finding.

### Interpretation and review

- Attribute a subagent's, report's or earlier document's conclusion, or re-establish its
  evidence independently before adopting it as your own.
  Reason: relaying a confident conclusion does not carry the chain that earned it.
- Treat “flaky” as an observation awaiting a cause; a second failure of the same family calls
  for a shared external-variable investigation using a comparison that changes one condition.
  Reason: separate labels can conceal one mechanism and prematurely end investigation.
- Match inspection environment to the property: use the real served path for latency,
  authentication, caching and integration; deterministic headless rendering proves rendering properties only.
  Reason: source and metric totals cannot establish behavior that depends on the served environment.
- For a surprising result inspect the deciding code, query, formula, protocol, setting,
  rubric or predicate before theorizing, and prove the experiment varied the variable it claims.
  Reason: a mistaken instrument or unchanged treatment can produce a coherent but irrelevant explanation.
- Expose assumptions and challenge the question when a plausible value can answer the wrong
  framing; move a failure into commands or gates once a reliable check makes it announce itself.
  Reason: mechanical success cannot choose the right question, but repeatable operator mistakes need not stay manual.

### Safe wrap-up

- After independent verification and archival, stop any watcher you started before reclaiming
  disposable work; retain invalid results unchanged with an `INVALID.md` or `SUPERSEDED.md` marker explaining the defect.
  Reason: ending observation and marking preserved evidence prevents stale activity or mistaken later reuse.
- Investigate a refused audit or non-force removal and leave wrap-up open; before using a
  guarded post-reclaim ledger repair, verify its reported entry/session/run identity.
  Reason: a repair command cannot safely close a different obligation or substitute for unfinished preservation.
- Change tracked specifications only for an authorized behavior regression or contradiction,
  explain the affected assertion, and avoid adding a public test merely for each task criterion.
  Reason: the maintained suite expresses intended behavior; one-off proof belongs in private temporary or declared run evidence.
- If FlowCrew is unavailable, stop live work and provide the [public installation recipe](getting-started.md#install-in-a-development-checkout).
  Reason: an unavailable executable cannot establish launch or verification evidence.

## Terminal artifacts and programs

`terminal_states` maps a known terminal run status to a path string, path list or object with
`paths` (or `path`). Declare only whole-run terminal products. Nonterminal keys are ignored
with diagnostics. Each terminal path has one final ordinary producer; ordered authors and
repairs may share its write scope. Admission checks the producer's mandatory gate and criterion
ancestors. Intermediate reports belong in outputs,
not terminal declarations.

An entry may include `floor.min_attempted_stages`, `floor.min_wall_minutes` and `stage_glob`
(entry-level wins over floor-level). For generic terminal-file evaluation, attempted-stage proof counts fresh nonempty files
matching the declared evidence pattern. Result checks determine whether those receipts prove the outcome; file length does not.
Native research ceiling evaluation instead counts journaled rounds, including valid
no-candidate attempts; neither counts arbitrary scheduler executions. With an attempted-stage floor satisfied,
wall time is advisory; without it, wall time can be the sole floor. Use substantive artifacts
and criteria rather than elapsed time as evidence of work.

`post_terminate_hook` accepts `command`, optional string-array `args`, positive
`timeout_seconds` and string-valued `env`. It runs after terminal commit under the command
boundary, with a default 300-second timeout and `FC_PHASE`, `FC_VERDICT_FILE`, `FC_RUN_DIR`,
`FC_PROJECT_DIR`, `FC_RUN_ID` defaulting to the committed terminal context; explicit hook
`env` can override them. A failed/timed-out hook is
recorded without turning the already committed terminal into a live run. Treat it as real
execution authority and review it before launch.

An optional `program` with string `name` and `phase` can specify `roadmap`, `ledger` and
`safeguards`: `max_phases`, `max_wall_hours`, `stop_file`,
`halt_after_consecutive_no_improvement`. Safeguards consume ledger phases and wall totals;
malformed ledger content does not prove prior work. Program and campaign are different:
one supplies phase safeguards, the other groups run history.

Sources: [frontmatter/floors/programs](../src/scheduler/sched_admission/brief-contract.ts),
[terminal admission](../src/scheduler/sched_admission/dispatch.ts),
[terminal settlement](../src/scheduler/sched_policy/terminal.ts).

## Deterministic checks

Only one `## Reality checks` section with a `checks` list is parsed. Each check supplies
`name`, `type`, `reads` (explicitly empty if it has no file inputs), `params`, and optional
`advisory: true`. Rooted reads follow [agent protocol](agent-protocol.md#artifact-locations).
Typed handler file parameters must agree with declared reads; shell text is not parsed to
discover every dynamic read.

| Type | Parameters |
|---|---|
| `exec-script-exit-zero` | Shell text `script`; optional `args`, `timeout_seconds` (default 60) |
| `file-exists-nonempty` | `paths` list or `{from_manifest, field}` |
| `json-schema-match` | `file`, `schema` object or schema-file reference |

A script runs via Bash from the project directory. Exit 127 with command-not-found diagnostics and narrowly
recognized unbound versioned-JSON shape failures become advisory with the failed execution
retained. This limits what a passing Reality Gate proves. Rejected terminal candidates
are quarantined; prose reports do not create executable checks.

Sources: [parser/execution](../src/reality-gate/index.ts), [registry](../src/reality-gate/registry.ts),
[shell handler](../src/reality-gate/checks/exec-script-exit-zero.ts).

### Generic declared-check example

This illustration checks a document and a numeric JSON field; it is not a native research-round
check. Provide the declared `docs/output.md` and `result.json` inputs before running it. The
finite-number script adds a check beyond the JSON field's type; no measurement is claimed.

```yaml
checks:
  - name: docs-generated
    type: file-exists-nonempty
    reads:
      - {id: document, root: project, path: docs/output.md, source: {kind: input}}
    params:
      paths:
        - docs/output.md

  - name: result-shape
    type: json-schema-match
    reads:
      - {id: result, root: project, path: result.json, source: {kind: input}}
    params:
      file: result.json
      schema:
        type: object
        required: [metric, value, evidence]
        properties:
          metric: {type: string}
          value: {type: number}
          evidence: {type: string}

  - name: result-value
    type: exec-script-exit-zero
    reads:
      - {id: result, root: project, path: result.json, source: {kind: input}}
    params:
      script: |
        node <<'NODE'
        const fs = require('node:fs');
        const result = JSON.parse(fs.readFileSync('result.json', 'utf8'));
        if (!Number.isFinite(result.value)) {
          console.error('result.value must be a finite number');
          process.exit(1);
        }
        NODE
```
