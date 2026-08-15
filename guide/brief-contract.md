# Brief and file contract

This is the canonical public contract between a FlowCrew brief, its agents, and
the scheduler. Brief-writing tools such as `/ship` should link here instead of
maintaining their own copy.

## Three rules that decide most outcomes

A run's result is determined more by its brief than by anything the engine does afterwards.
These three are the ones that most often go wrong:

- **State a criterion as the observable property, not the instrument.** "The probe must import
  `jsdom`" pins an implementation; "prove a real browser environment was exercised" states what
  you actually want, and a gate can satisfy it by other means without failing you on a
  technicality.
- **Put the boundaries in the brief, not in a follow-up message.** Anything a stage may write,
  and anything it must not, has to be declared up front — a constraint sent later cannot
  retroactively govern work already done, and an undeclared write scope means the stage is
  neither allowed to write nor told it may ask.
- **Declare terminal artifacts only on what the last stage writes.** Naming a path that some
  mid-pipeline stage produces lets the run reach a terminal state before the gates that were
  supposed to guard it have run. Keep earlier deliverables out of the terminal artifact's
  directory as well: a planner can otherwise co-locate the files in one early stage even when
  their basenames differ.

## Contract flow

```text
brief frontmatter + Markdown body
  -> scheduler records task_brief.md and parses engine settings
  -> planner writes dispatch.yaml and optional reality_checks.md
  -> workers execute the dispatched DAG
  -> gates write verdict_<stageId>.json
  -> research stages write round_result JSON; the engine decides continue/ship/ceiling
  -> consequential stages write approval_request.json; the engine parks if needed
  -> guidance steers later stages and iterations
  -> a terminal artifact or engine-owned decision commits the run outcome
```

The frontmatter configures the engine. The Markdown body remains the complete,
self-contained task: goal, context, constraints, approach, acceptance criteria,
and relevant files. A stage does not inherit the conversation that created the
brief.

## Frontmatter envelope

Engine settings must be YAML frontmatter at the very start of the file, bounded
by `---` lines:

```yaml
---
research:
  baseline: 0.72
  policy: greedy_stack
  higher_is_better: true
  feasibility:
    hard_floor: 10
    warn_below: 20
    rules:
      - label: eligible across the full window
        model: independent_repeated_conjunction
        population: 500
        per_period_rate: 0.8
        periods: 12
  result_file: artifacts/evaluation/round_result.json
  report_dir: artifacts/evaluation
  result_schema:
    type: object
    required: [label, result]
    properties:
      label: {type: string}
      result: {type: number}
  confirm:
    command: node scripts/confirm-result.mjs
    requires: Recompute the candidate on an independent fixture.
    timeout_seconds: 300
  stop:
    beat: 0.85
    max_rounds: 8
    halt_after_no_improvement: 2

terminal_states:
  shipped:
    paths: [artifacts/evaluation/ship_report.md]
  ceiling_hit:
    paths: [artifacts/evaluation/ceiling_report.md]
    floor:
      min_attempted_stages: 4
---
# Improve evaluation accuracy

The complete task begins here.
```

Putting `research.confirm:` in the prose body or inside a quoted `flowcrew
quick` task does not configure the engine. The parser only reads these keys from
the leading YAML block. Rehearse and submit the whole file:

```bash
flowcrew rehearse path/to/task.brief.md
flowcrew quick --task "$(cat path/to/task.brief.md)"
```

When `quick` sees a valid `research` block and no explicit `--workflow`, it
selects the research workflow automatically.

## `validation.commands`

`ship-setup` normally discovers build, test, and lint commands from the target
worktree's `package.json`, `Makefile`, or `pyproject.toml`. When a project cannot
state the correct command there—for example, when only the operator knows which
environment has the test dependencies—the brief may supply an argv-shaped
fallback in its leading frontmatter:

```yaml
validation:
  commands:
    test:
      command: /path/to/the/project-environment/bin/python
      args: [-m, pytest]
```

`build`, `test`, and `lint` are the only role names. Each role must contain
exactly a non-empty string `command` and a required `args` array of strings;
use `args: []` when the executable takes no arguments. The commands map must
not be empty. Unknown roles or fields, malformed YAML, and control characters
make setup refuse before it creates a worktree. The evidence locator stored for
each accepted role is `<brief path>#validation.commands.<role>`.
An otherwise empty leading frontmatter block is valid and behaves as though no
brief validation command were declared. Control characters include both the
ASCII C0/DEL set and the Unicode C1 range (U+0080 through U+009F).

Resolution is role-by-role and fail-closed:

- A command declared by the target's project configuration governs that role.
- A brief command fills a role that project configuration does not declare.
- Exact command-and-ordered-argument agreement is accepted once and recorded
  as project-governed validation corroborated by the brief.
- Any other overlap is a conflict. Setup names both evidence locations and both
  argv values, executes no baseline command, and refuses instead of choosing
  silently.
- A target-owned role whose executable cannot be resolved—for example, a
  package script with conflicting package-manager lockfiles—is not a missing
  role. Setup refuses; a brief command cannot replace that ambiguous project
  declaration.

For baseline execution, setup passes `command` and `args` unchanged to the
process runner, fixes the working directory to the target, inherits the setup
environment, and never enables a shell. Shell punctuation inside an argument
is data. This shape makes the executed argv reviewable and prevents setup from
reinterpreting an operator-supplied shell line.

A declaration supplies a command; it does not waive measurement or make an
unrunnable environment ready. The command goes through the same baseline result
parser and regression-gate construction as a discovered command. A launch
error or exit 127 refuses setup and names the failed declaration, while roles
with no command remain `not_configured` once at least one role is measurable.
There is no validation-bypass flag.

For a resolved test argv beginning with a Python executable followed by `-m
pytest`, setup derives the population probe by appending `--collect-only -q` to
that same argv and compares source and target identities before capturing the
baseline. Other custom test commands use the generic baseline-output fallback:
complete named top-level TAP records are compared by normalized name plus
name-local occurrence. A target that covers all source identities and adds tests
is recorded as matched `SOURCE-PLUS-ADDITIONS`; missing or renamed source tests
still refuse. Output that cannot establish identities is recorded as
reason-bearing `unverified`. A command declaration never weakens the validation
baseline or its gates.

## `terminal_states`

`terminal_states` maps a terminal run status to one or more project-relative
files. A string, list of strings, or object with `path`/`paths` is accepted. A
non-terminal key is ignored.

```yaml
terminal_states:
  escalated: artifacts/evaluation/escalation.md
  phase_complete:
    paths: [artifacts/evaluation/phase_verdict.md]
    stage_glob: artifacts/evaluation/stage_*_verdict.md
    floor:
      min_attempted_stages: 3
      min_wall_minutes: 30
    post_terminate_hook:
      command: scripts/advance-phase.sh
      args: [artifacts/evaluation/phase_verdict.md]
      timeout_seconds: 120
      env:
        PROGRAM_MODE: evaluate
```

| Field | Meaning |
|---|---|
| `paths` / `path` | Project-relative artifact paths that assert this status. The first existing path wins. |
| `floor.min_attempted_stages` | Minimum number of substantive files matching `stage_glob`. Without an explicit glob, the scheduler infers `stage_*_verdict.md` beside the terminal artifact. |
| `floor.min_wall_minutes` | Minimum wall time when no stage-count floor exists. When the stage-count floor is met, wall time is informational rather than blocking. |
| `stage_glob` | Simple project-relative `*` pattern used by the stage-count floor. Entry-level placement is canonical; placement inside `floor` is also accepted. |
| `post_terminate_hook` | Best-effort command run only after the terminal state, campaign entry, and completion event are committed. |

The hook receives `FC_PHASE`, `FC_VERDICT_FILE`, `FC_RUN_DIR`,
`FC_PROJECT_DIR`, and `FC_RUN_ID`. A program also adds `FC_PROGRAM_NAME`,
`FC_PROGRAM_PHASE`, and configured roadmap/ledger variables. Hook failure or
timeout is logged but does not undo the committed terminal state.

Successful statuses still pass Reality-Gate before commit. A research
`shipped` artifact also has to pass `research.confirm`; a rejected artifact
does not end the run.

## `research` (or `objective`)

`objective` is accepted as an exact alias for `research`. A numeric `baseline`
is the field that activates the native metric loop; an omitted or unknown
`policy` then defaults to `greedy_stack`. The one independently parsed field is
`feasibility`: static preflight accepts it without a baseline, and doing so does
not create a metric-loop configuration. The `quick` command's automatic
workflow selection recognizes the `research:` spelling; pass `--workflow
research` explicitly when using the `objective:` alias for a metric loop.

| Key | Contract |
|---|---|
| `baseline` | Required number for a metric loop: the running-best value at entry. Omit it for a feasibility-only static declaration. |
| `policy` | `greedy_stack`, `best_of_n`, or `replace_if_better`. |
| `higher_is_better` | Direction of improvement; defaults to true. Boolean strings `"true"` and `"false"` are coerced. |
| `result_file` | Project-relative latest-round JSON. Default: `docs/research_round_result.json`. |
| `report_dir` | Project-relative directory for framework-owned reports and `run_manifest.json`. Default: `docs`. |
| `result_schema` | JSON Schema subset used both in planner context and at round ingestion. |
| `context_roots` | Project-relative roots inventoried for a dynamic planner. Default: `data`. |
| `directions` | Opaque portfolio labels an outer campaign should cover before accepting a frontier. |
| `feasibility` | Independently parsed pre-run structural feasibility contract for pre-registered selection rules; see below. It does not activate a metric loop. |
| `integrity.noop` | Reject baseline-equivalent results unless explicitly false. |
| `integrity.max_std_ratio` | Maximum accepted `result_std / abs(result)`; default 0.30 when `result_std` exists. |
| `integrity.outlier_factor` | Directional implausible-improvement cap relative to a nonzero baseline; default 5. |
| `integrity.field_floors` | Brief-owned numeric minimums for arbitrary result fields. |
| `integrity.reject_if_positive` | Brief-owned fields that must not be positive. |
| `stop.beat` | Target that proposes `ship`. |
| `stop.max_rounds` | Maximum accepted research rounds. |
| `stop.max_wall_hours` | Cumulative wall-time stop. |
| `stop.halt_after_no_improvement` | Stop after this many accepted non-improving rounds. |
| `stop.min_improvement` | Absolute margin required to count as improvement. |
| `stop.improvement_se_multiple` | Additional standard-error margin; default 1. |
| `confirm.command` | Shell command run from the project directory before accepting `ship`; exit zero confirms it. |
| `confirm.requires` | Human-readable assertion only; it does not affect execution. |
| `confirm.timeout_seconds` | Command timeout; default 300 seconds. |

The agent measures; the engine owns the decision. A confirmation failure marks
that candidate unconfirmed, removes it from policy consideration, and then lets
the remaining stop budget decide whether to continue or finish with an honest
ceiling.

### `research.feasibility`

A pre-registered selection rule must not defer arithmetic that can be done from
outcome-independent counts, rates, universe sizes, or window lengths. Put that
arithmetic in `research.feasibility`; a prose promise to calculate it during the
run is not a substitute.

The missing-feasibility preflight applies only when a local instruction carries
positive evidence that this task owns the commitment. Recognized forms include a
direct imperative to freeze a selection procedure, a mandatory or future action
assigned to this task, run, round, stage, a named task-performing role, `we`, or
`you`, a mandatory passive requirement on the rule itself, and a
pre-registration artifact assigned to be written before outcomes are accessed.
Generic detector or guide prose, a post-mortem about an earlier round, and an
attributed quotation merely describe the act and do not create that commitment.

The base-form actions `pre-register` and `preregister` also count when the same
normalized instruction is already a positive task-owned commitment and the
action takes a selection procedure as its direct object. The detector consumes
the complete initial object phrase up to punctuation, a conjunction, or a
preposition, regardless of its modifier count, and requires the phrase's final
token (its head) to be a procedure noun. A procedure noun that only modifies
`documentation`, or one in a later clause, does not count. The object negators
`no`, `not`, `none`, `zero`, `nothing`, and `neither` do not create positive
evidence. This relationship only adds positive evidence and supplies the
finding's excerpt; it never suppresses evidence, so asserting it cannot create
an opt-out.

Quotation attribution is structural and unit-local: a Markdown quotation beside
prose identifying its prior or documentary source is descriptive, while an
unattributed quoted directive remains an instruction. Attribution never cancels
a positive directive elsewhere in the brief.

The four prose recognizers that span words—headline distribution, exact-method
criterion exceptions, assigned stage-floor writers, and per-stage writable-path
mappings—treat an ordinary Markdown soft wrap inside one paragraph or list item
as presentation, not semantics. They keep blank-separated paragraphs, headings,
distinct list items, tables, quotations, and fenced blocks separate, so moving a
line break cannot make a correct requirement appear absent or join two
independent fragments into a new requirement.

A disclaimer is not an exemption and never cancels positive evidence elsewhere.
For example, saying that the task does not pre-register anything contributes no
commitment evidence; if the brief also directs a stage to freeze a selection rule,
the missing-feasibility finding still applies. Silence is earned by the absence of
a task-owned positive commitment, not by an asserted opt-out sentence.

A diagnostic or engineering brief with no metric to beat may declare only this
field under `research` (or `objective`). Preflight evaluates the declaration,
but the scheduler still treats the brief as an engineering run: it proposes no
research candidates, expects no round-result file, and applies no stop policy.

`hard_floor` is a positive qualifying-member minimum shared by the labelled
rules. `warn_below`, when present, must be at least the hard floor. A computable
count below `hard_floor` is a failing preflight finding. A count at or above the
floor but below `warn_below` is a warning, so a feasible but tight rule remains a
deliberate author decision. A count at or above both thresholds is OK.

The supported models are deliberately structural and discriminated:

| Model | Required fields | Computation |
|---|---|---|
| `independent_repeated_conjunction` | `population` (positive integer), `per_period_rate` (0 through 1), `periods` (positive integer) | `population × per_period_rate^periods`, evaluated in log space. Use this only when the repeated-rate and independence assumptions are justified before outcomes are opened. |
| `formation_count_distribution` | Non-empty `counts` list of non-negative integers | Uses the minimum formation count as the rule's qualifying-member count. The counts must be structural and outcome-independent. |
| `not_computable` | Non-empty `reason` | Emits an explicit warning and no numeric estimate. The reason should name the unavailable structural distribution or quantity. |

Every computable evaluation also reports the structural sample size, mean,
median, spread, selected value, rank interval, and midrank percentile. A repeated
scalar rate is a distribution of `periods` tied observations, so its spread is
reported as zero rather than omitted. Unknown fields, duplicate labels,
non-finite values, out-of-range rates, fractional counts, and fields from a
different model make the feasibility declaration invalid instead of being
silently ignored.

When feasibility depends on a distribution that does not yet exist, use
`not_computable` honestly. Preflight must not invent a rate merely to produce a
number; once the missing structural distribution has been measured without
opening outcomes, a later brief can replace the declaration with a computable
model.

## `program`

`program` describes one run within a multi-phase program. Both `name` and
`phase` must be strings for the block to take effect.

```yaml
program:
  name: evaluation-program
  phase: phase-2
  roadmap: artifacts/program/ROADMAP.md
  ledger: artifacts/program/findings_ledger.json
  safeguards:
    max_phases: 6
    max_wall_hours: 24
    stop_file: artifacts/program/STOP
    halt_after_consecutive_no_improvement: 2
```

At startup, safeguards check the stop file, phase count, cumulative ledger wall
time, and consecutive non-breakthrough rows. A violation fails the run before
work begins and writes `program_aborted.md` beside the ledger. A declared
`phase_complete` terminal appends a phase row to the configured ledger. There
is no implicit next-phase launcher; use an explicit `post_terminate_hook` if
automation is required.

## Runtime file contracts

`<runDir>` below is the run's durable control-plane directory. Project-relative
artifacts remain in the selected project.

| File | Producer | Consumer | Location and lifetime |
|---|---|---|---|
| `task_brief.md` | CLI or dashboard | Scheduler and every worker | `<runDir>/task_brief.md`; immutable input for the run and for same-ID resume. |
| `dispatch.yaml` | Dynamic planner stage | Scheduler | `<runDir>/dispatch.yaml`; read after planning, replaced on a later re-plan. |
| `verdict_<stageId>.json` | Gate stage | Scheduler | `<runDir>`; live evidence for the current attempt. A retry or later planner iteration may replace it. |
| `stages/<stageId>/metric.json` | Scheduler, then optionally the gate stage | Scheduler | Seeded before every gate attempt as `hasMetric:false`; the gate replaces it only when that attempt has a trustworthy numeric metric. |
| Rejected gate evidence | Scheduler | Repairs, reports, operator | `<runDir>/gate_reevaluation/iteration_<n>/round_<n>/`; durable copies of the rejected verdict, evaluated metric, gate output, and engine-effective verdict. |
| Re-plan stage evidence | Scheduler | Summary, dashboard, campaign accounting, operator | `run.json.stageEvidence` keys each retired dynamic stage by iteration and stage ID and points to immutable status, output, attempt-output, and optional verdict copies under `<runDir>/stage_evidence/iteration_<n>/`. |
| Round result | Measurement stage | Research advance gate | Path from `research.result_file`; one fresh JSON object per round. After ingestion it is moved to `<runDir>/research_round_<N>_consumed.json` and journaled. |
| `approval_request.json` | Any stage needing authority | Approval park gate | Prefer `<runDir>/stages/<stageId>/approval_request.json`; consumed into `approvals/` and the append-only inbox log. |
| `reality_checks.md` | Planner | Reality-Gate | `<runDir>/reality_checks.md`; evaluated with the brief's own checks before a successful terminal commit. |
| `handoff_<stageId>.md` | Each stage on completion | The next stage that depends on it | `<runDir>/handoff_<stageId>.md`; what a stage passes forward, rather than the next stage re-reading its predecessor's full output. |
| `scope_revision_request.json` | A stage needing a path outside its declared scope | Scheduler policy, which writes `scope_revision_decision_*.json` beside it | `<runDir>/stages/<stageId>/`; answered by a deterministic predicate chain — matching run and live attempt, digest-verified paths, no collision with a running peer, and the requested file not already modified — never by the supervisor. |
| Guidance | Supervisor, scheduler, or operator path | Later workers/planner | Run-level `supervisor_guidance.md` plus optional `stages/<stageId>/guidance.md`; snapshotted for each consuming stage and archived by iteration. |
| Terminal artifact | Agent, or the research engine when it owns the decision | Terminal-state gate, summary, operator | Project path declared in `terminal_states`; snapshotted as `<runDir>/terminal_<basename>` when detected. |
| Stage output | Every stage attempt | Retries, summary, operator | `<runDir>/stages/<stageId>/output.md` always holds the latest attempt. A retry that needs to read what an *earlier* attempt actually produced uses `output_attempt_<n>.md`, written alongside it for every numbered attempt — `output.md` alone was overwritten by each new attempt, so a passing attempt's output could be destroyed by a later one that failed in seconds. |

The `stages` map and `stages/<stageId>/` files are live aliases for the active
DAG. At an outer re-plan boundary, the scheduler first materializes the
iteration-qualified stage-evidence files and then publishes those references in
the same atomic `run.json` replacement that removes the old dynamic stages.
Reusing a stage ID starts a fresh live attempt ledger; it cannot redirect the
older record or inherit its completed status. Campaign costs and summaries read
the archived status through `stageEvidence`, with `retiredStageUsage` retained
only as a compatibility fallback for older runs.

A blocking planner-check preflight retry is narrower: it removes the refused
proposal's `dispatch.yaml` and `reality_checks.md` and re-pends only the planner
before downstream injection. It neither retires the active DAG nor mutates
already archived stage evidence.

### `approval_request.json`

A stage that needs human authority before a consequential action writes exactly
one JSON object to its isolated
`<runDir>/stages/<stageId>/approval_request.json` slot, then stops without
performing the action:

```json
{
  "id": "publish-release",
  "action": "publish",
  "target": "release-channel",
  "risk": "external",
  "title": "Publish the accepted release",
  "body": "This makes the release visible outside the project."
}
```

| Field | Required | Contract |
|---|---|---|
| `id` | Yes | Stable idempotency key within the run: 1–64 ASCII letters, digits, dots, underscores, or hyphens. `requestId` remains a compatibility alias, but new artifacts use `id`. |
| `action` | Yes | Non-empty string naming the requested operation. |
| `target` | No | Exact object of the action. It is required if this request may ever qualify for a standing rule. |
| `risk` | No | `external`, `exec`, or `write`; an omitted or unknown value is stored as `unknown`. Only `external` requests with an exact `target` can mint or match a standing rule. |
| `title` | No | Inbox summary. If omitted, the engine derives it from `action` and, when present, `target`. |
| `body` | No | Longer explanatory text shown to the human decision-maker. |

Invalid JSON, a missing `id` or `action`, and an unsafe `id` are ignored rather
than authorized. On ingestion, the engine durably records the request, moves it
to `<runDir>/approvals/<id>.request.json`, and parks the run when no exact
standing rule applies. A decision is materialized as
`<runDir>/approvals/<id>.decision.json` for the resumed stage; among concurrent
human resolutions, the first valid resolution wins. See
[Approvals and the inbox](approvals.md) for park/resume behavior and operator
commands.

### `dispatch.yaml`

The top level is either a list or `{stages: [...]}`. Each usable stage names a
registered role and has a unique ID:

```yaml
- id: implement_change
  role: coder
  prompt_template: |
    Implement the accepted design and add focused tests.
  depends_on: [inspect_code]
  skills: []
  dynamic_dispatch: false
  is_gate: false
  retry_to: []
```

`id` and `role` are required. `prompt_template` defaults to empty, and `task` is
accepted as a compatibility alias. Optional fields are `depends_on`,
`condition`, `skills`, `dynamic_dispatch`,
`is_gate`, `retry_to`, and `scope`. Unknown roles and invalid or duplicate stages are
skipped; an entirely unusable dispatch triggers a bounded re-plan or an
actionable escalation.

Dynamic plans do not control technical retry count. A historical `max_retries`
field in planner output is ignored and omitted from the recorded workflow;
`config/defaults.yaml::default_stage_technical_retries` remains the operator-owned
bound for timeout retries.

`depends_on` is a production edge, not merely an ordering hint. A dependency
releases an ordinary dependent only after its stage status is `complete`.
`skipped`, `failed`, `pending`, and `running` do not release it. A gate dependency
has the additional requirement that its stage-specific
`verdict_<stageId>.json` is valid and says `pass: true`. Consequently, a skipped
measurement cannot release a report stage: the DAG remains unresolved and ends
`incomplete` if no later iteration repairs it.

`condition` is a typed comparison of one producer fact, for example
`audit_freeze.pass == true` or `build.status == complete`. Status fields are read
first from `stages/<stageId>/status.json`; fields absent there are read only from
that producer's `verdict_<stageId>.json`. A shared or sibling verdict is never a
substitute. A missing, malformed, or wrong-typed fact makes the condition false
and the conditional stage is recorded `skipped`. Dynamically dispatched
conditions are also persisted in `workflow.yaml`, so the recorded DAG matches
the one the scheduler evaluated.

The generic stage schema has no list of arbitrary project artifacts promised in
prose. For an ordinary stage, `complete` therefore proves successful process
completion, not that every prose-named file exists. When downstream safety
depends on a machine-checkable output, express it through an existing typed
contract (a gate verdict, research result, or terminal artifact) instead of
relying only on prose.

### `scope`: the paths a stage may write

```yaml
- id: implement_change
  role: coder
  scope: ["src/search/**", "spec/search/**"]
```

`scope` is a list of project-relative paths or globs. A write outside the stage's
declared scope is reverted to its pre-stage contents once the attempt ends — this is
what backs the "do not edit the project while a run is working in it" rule: your edit and
the stage's are indistinguishable in the snapshot diff that scope enforcement reads.

For an authored multi-stage brief, include an explicit writable-path mapping for every stage,
including planning and gates. Brief preflight warns when the mapping is absent; it cannot
choose the correct paths for the author. The planner still translates that contract into each
generated stage's `scope`.

Three states, not two:

- **declared** — `scope` is present. Only those paths (and, once negotiated, any
  accepted revision) survive.
- **missing but negotiated** — `scope` is absent, but the stage requested and was
  granted a path at runtime (below). Enforcement governs exactly the granted set.
- **missing and never negotiated** — `scope` is absent and no request was made.
  Nothing is reverted; this is the only case in which "undeclared" means "unrestricted",
  and it is deliberately not the default outcome of forgetting to set `scope` once a
  stage has negotiated even once.

A stage that needs a path outside its declared scope writes one JSON object to
`stages/<stageId>/scope_revision_request.json`, then waits for
`scope_revision_decision_<requestId>.json` in the same directory before writing the new
path. The request, the decision, and the outcome are all recorded in the run directory —
this is the mechanism behind "a stage that needs something outside its boundary can ask"
mentioned in the project README.

The attempt budget comes only from `config/defaults.yaml::default_timeout_ms`.
It is immutable after an attempt starts and covers adapter retries, backoff,
fallback loading, and fallback execution. A timed-out technical retry receives
a strictly larger derived attempt budget; there is no aggregate technical-chain
cap. Legacy timeout fields in a plan and runtime extension requests are rejected
with a migration message, so a plan cannot make its first timeout fatal or move
a running attempt's deadline without bound.

Every `retry_to` target is normalized to a gate and added to the repair stage's
dependencies. Only a completed, validated `pass:false` verdict makes that
repair eligible; a pending or never-run gate blocks terminal success but does
not dispatch its repair. Conversely, a completed `pass:true` gate makes only
its `retry_to` repair unnecessary. That repair receives a terminal `skipped`
disposition; ordinary dependents of the same gate remain eligible.

### Gate verdicts

A gate stage is instructed to write:

```json
{"pass": false, "reason": "The acceptance command still fails."}
```

`pass` and `reason` are the core fields. Scored gates may also provide `score`,
`metric`, and `threshold`; campaign phase gates may carry the phase metadata
listed in their prompt. The path is specific to the gate stage, so concurrent
gates do not overwrite one another.

A numeric metric is optional unless a `gate_contract.json` contract applies to
that gate. Before each attempt, the scheduler replaces any older metric artifact
with an engine-owned `hasMetric:false` marker. This makes “no metric for this
attempt” explicit and prevents a failing metric from an earlier planner
iteration from contradicting a new qualitative verdict. When an applicable
contract names a metric and threshold, the current verdict or metric artifact
must contain the numeric value; omission fails the run at that first gate
evaluation, naming the missing metric and threshold, before any product repair
or outer re-plan is dispatched.

When a gate does write a metric, the verdict must agree with it. In particular,
a passing verdict paired with a failing metric from the same attempt remains an
engine rejection. This freshness rule does not relax the measure-round
self-deception guard.

The root verdict path is live, not a permanent report citation. Gate prompts
receive the exact durable path where a rejection will be archived under
`gate_reevaluation/iteration_<n>/round_<n>/`; reports should cite that injected
path. The archive also preserves the metric actually evaluated and the engine's
effective verdict when it differs from the gate's written verdict.

### Round results

The minimum payload is:

```json
{"label": "indexed-lookup", "result": 0.81}
```

`result` must be numeric; `label` defaults to a generated round name. A declared
`result_schema` can require additional fields, and integrity rules can inspect
their numeric values. The scheduler ignores stale files from before the run,
deduplicates an already-journaled `(label, result)`, writes the durable
`research_journal.json`, and mirrors accepted rounds to
`<report_dir>/run_manifest.json`.

### Planner Reality-Gate checks

Both the human brief and planner-owned `reality_checks.md` use the same section
contract:

````markdown
## Reality checks

```yaml
checks:
  - name: result-shape
    type: json-schema-match
    params:
      file: artifacts/evaluation/round_result.json
      schema:
        type: object
        required: [label, result]
```
````

Only a `checks:` list inside a `## Reality checks` section is parsed. See
[Reality-Gate](reality-gate.md) for available check types.

Planner-authored hard checks may not make their verdict the unprocessed exit
status of a project build, test, or lint command. The ship-setup ready record is
bound to the canonical target and exact brief bytes; when it records a red
`no_regression_from_baseline` criterion, compare current failure identities with
that record or omit the redundant validation check.

### Guidance

Run-level and stage-level guidance is prepended to the worker prompt as high
priority. The worker snapshots the run-level text to
`stages/<stageId>/guidance_consumed.md`, preserving what that attempt actually
saw. At iteration boundaries, run-level guidance moves to
`guidance_history/iter_<N>.md`; the next planner receives the most recent
archive so rejected approaches and “do not” constraints survive re-planning.

Use `flowcrew guide --run <run-id> "message"` to write operator input to a
specific running run. Omitting `--run` is safe only when exactly one readable run
is executing; zero or multiple candidates cause a non-zero, zero-write refusal.
The selected supervisor ingests the message on its next tick and turns it into
run guidance.

## Validate before launch

Inspect and rehearse the exact bytes before a live launch, then create the launch worktree:

```bash
flowcrew ship-preflight --brief <brief.md> [--campaign <name>]
flowcrew rehearse <brief.md>
flowcrew ship-setup --brief <brief.md> --target <dir> --base <ref> --branch <name> [--project <source>]
flowcrew watch --once
```

Preflight reports prior-run and campaign facts, verifies declared input claims, and records the
configuration-discovered validation baseline as a delta contract. Rehearsal validates the
frontmatter and exercises the terminal, confirmation, floor, and round-file paths with a
scripted adapter. It does not validate research quality; see [Zero-token rehearsal](rehearse.md).

Values under the leading frontmatter `inputs:` key are explicit path declarations. A safe bare
directory name is accepted there without a trailing slash because the key already supplies the
path context. An explicit value that is unsafe or cannot be normalized is retained and reported
as unresolved; it is never silently dropped. Path discovery in ordinary prose remains
conservative, so a bare noun outside an explicit declaration is not promoted into an input.

Setup is the fail-closed boundary: it creates the declared worktree and reconciles each declared
input by content. A wholly missing input is linked as before. When Git created only part of a
declared directory, setup walks the source directory, materializes missing subdirectories, and
copies their files into the target. Copies remain untracked and isolate the source from target
edits; they also keep test-module paths rooted in the target instead of resolving through a
symlink to the source checkout. Existing target files are never overwritten: a type or content
collision is a blocker. Setup then verifies the input assertions again through the target.

Before recording the target baseline, setup prefers an exact test-file collector derived from the
configured command (Vitest and pytest are supported), or an explicit `package.json`
`flowcrew.testPopulation.files` list. It compares the normalized source and target identity sets—not
just their counts—and refuses setup when those identities differ. This collector check runs
whether or not the brief remembered to declare the ignored test
directory, so a smaller launch suite cannot silently become the baseline.

Missing collector knowledge is recorded separately from a broken target. When no exact collector
is available, setup runs the configured source test command once and observes the test response
already used to construct the target baseline. If both executions emit complete top-level TAP,
each identity joins the normalized name to its occurrence number among records with that same name.
Thus an unrelated insertion does not rename later tests, while `1:duplicate` and `2:duplicate`
preserve the multiplicity of legal duplicate names. If the target contains every source identity,
an equal population is `matched`; a strict superset is also ready and is rendered as
`SOURCE-PLUS-ADDITIONS` with the exact additions. This is a source-coverage decision: extra target
tests do not create the guarded risk of silently running fewer tests. A missing source identity
still refuses, and a rename reports the old identity as missing and the new one as extra. Exact
collector identity and strict-parity behavior are unchanged.

The population comparison and baseline failure extraction share one structural TAP reader. It
accepts only one version, one column-zero plan, a complete set of uniquely numbered, non-empty
column-zero records, and a matching top-level `# fail` summary when that summary is present.
Indented TAP remains nested evidence and is not promoted to a top-level identity. Population
comparison occurrence-qualifies every complete record; failure extraction records the names of
the complete reader's `not ok` records. Those are deliberately different conclusions over the
same validated syntax.

Failure extraction runs against the complete joined command response available at the baseline
handoff, before only the persisted `output` field is byte-bounded. The ready record therefore stays
bounded without hiding an early failure from identification. The command runner has an earlier,
independent streaming bound; if that bound is reached, its omission marker makes the structural
reader refuse the partial output instead of trusting whichever records survived.

Name-local identity cannot prove execution order or detect a name-preserving body change. For
duplicates it can prove multiplicity, but it cannot identify which same-named body was added,
removed, or changed. Truncated, ambiguous, bailed-out, non-TAP output, or records without names
instead produce a ready record with test-population state `unverified`, the configured runner, and
the reason source coverage could not be established. This is the same modelling choice as
`research.feasibility: not_computable`: an underivable assurance is first-class and reason-bearing,
not silently converted into either success or failure.

A failed validation result whose failure identity remains `unknown` carries a reason. Empty output,
capture truncation, structurally invalid TAP, and an unrecognized non-TAP format are distinct causes;
the same cause is persisted on the result and appended to the human
`no_regression_from_baseline` gate line. The gate remains conservative: a later failure is
unresolved and is never compared with an invented zero baseline.

Failure identification still cannot see malformed or incomplete TAP, output lost at the earlier
streaming bound, nested leaf failures beyond the complete top-level record name, non-TAP runners
outside the retained `FAIL`/`FAILED`, cross-mark, and compiler-diagnostic adapters, ANSI/control
variants those adapters do not normalize, JSON- or JUnit-only reports, custom prose, or failures
that emit no output. These remain reason-bearing `unknown` results rather than guessed identities.

The costs and assurances differ by state:

- Collector-matched uses two cheap collections plus the one governing target suite run. It proves
  the collector's normalized identities agree, but cannot prove tests outside the configured
  command or explicit declaration exist.
- TAP-matched uses two full suite executions: one source run and the governing target baseline run.
  It proves every complete reported source identity occurs in the target. The visible
  `SOURCE-PLUS-ADDITIONS` relation distinguishes a strict target superset from equality, but neither
  relation has runner-specific discovery assurance for tests the command never reports.
- `unverified` still proves the target validation command ran and records its unchanged baseline
  and gates. It does not prove source/target population parity; the runner and missing evidence are
  visible in both JSON and human output.
- `mismatched` proves configured test availability or the observed populations differ and refuses
  without a ready record.

Population evidence never relaxes validation. Target launch failures, including exit 127, still
refuse, and ordinary red baselines keep the same `no_regression_from_baseline` criterion in every
population state. A ready record remains keyed by the exact brief digest plus the canonical target.
Use `flowcrew watch` after launch for a continuous heartbeat and edge-triggered stalls; `--once`
performs one read-only pass.
