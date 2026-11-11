# Brief contract

For a task author: how do I express the outcome, evidence and limits the run must satisfy?

Write a self-contained outcome, explicit input paths, real constraints and numbered acceptance
criteria. Name a report and its evidence only when the task requires them. Separate a required property from
an illustrative implementation.

## From a raw task

`flowcrew quick "<plain task>"` writes missing criteria using the configured, read-only
`brief_writer` role before the existing admission path. `flowcrew brief "<plain task>"`
prints composed bytes and digest for review without launching; each preview makes a fresh
call. Both commands check source facts and static declarations before authorship. An existing
extractable contract skips the model. See [CLI](cli.md#write-a-brief-before-running)
for saving, setup, retry evidence and exit codes.

The model returns five fields in one fixed schema: outcome `criteria` (nonempty),
`constraints`, existing-path `inputs`, nonblocking `assumptions`, and `blocking_questions`.
Code preserves the complete original task as an exact prefix and appends those sections;
JSON string quoting keeps a model's multiline value inside its own list item. The model
cannot remove or rewrite the request. The existing structural parser determines whether
a closing fence is needed before the generated sections; unmatched task fences cannot
hide criteria or consume correction retries. Criteria describe result properties; the role must
not add reports or evidence duties unless requested. No wording filter judges model prose.
Any blocking question stops launch with exit 3, without guessing or retrying it away.

Generated input references must be repository-relative and present in Git's tracked HEAD
tree, where the prepared target will read them. Absolute, escaping, missing and ignored-only
paths use the correction path. The references are recorded as prose. Because the
original bytes stay first, generated sections do not add leading frontmatter or grant
input-freezing/output-reuse authority. Author such declarations explicitly when needed.
The model supplies no workflow field. When `quick` generates a brief and the supplied
project has no exact setup record, it requires a clean Git source and prepares a sibling
worktree from `HEAD` through `ship-setup`, retaining all its admission checks. Target
and branch names use the composed digest, never model prose. An authored brief keeps
its existing exact-record requirement. The entry chooser and independent gates apply; research loops still require their authored research block.
Static rehearsal and preflight validate generated content, with reasons returned for up
to two correction retries. Authored briefs passed to inspection/setup/rehearsal keep their
existing missing-contract diagnostics. Failed provider calls stop with exit 4, are not
replies and consume no correction retry. An exhausted invalid invocation can be rerun
with fresh attempts; all previous evidence remains. Only valid, unregistered replies
are replayed after a host stop. Preview evidence follows the composed digest across targets.

## Engineering and workflow selection

This is an illustrative engineering envelope, not a complete launch-ready task:

```yaml
---
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

Follow it with the goal, constraints and extractable acceptance criteria. Engineering enters a
model chooser, which chooses author/review/repair work or decomposition. A `research.measurement`
declaration fixes the research shape directly: one producer and independent candidate-property
review in an engine-owned loop. No model chooses or plans the research workflow. Legacy
`workflow:` metadata has no routing effect; no CLI shape override is available.

`objective:` remains an alias for `research:` and follows the same measurement-only schema. Declare the contract once; using both headers is refused.
A research block without `measurement` is refused with a migration diagnostic. Use ordinary
engineering gates and configured validation for a known pass/fail task.

Sources: [frontmatter](../src/scheduler/sched_admission/brief-contract.ts),
[criteria extraction](../src/brief-criteria.ts), [preflight](../src/brief-preflight.ts).

## Execution and assumptions

The brief's constraints remain text that stages interpret under their existing authority.
There is no execution approval contract, declaration, request inbox or decision transport.
If a stage cannot obtain a resource, it continues as far as possible and names the gap in
its structured result. Independent gates assess that result; the human reads it at wrap-up.
Historical authorization frontmatter has no engine meaning.

The engineering entry chooser chooses a shape and records `assumptions` in its closed-schema
result. Those assumptions are retained in the run record and summary. Invalid output fails
its attempt and uses the existing retry allowance. The chooser cannot change the declared
mode or demand research fields from an engineering brief. Research authoring errors are
reported by parse/preflight before execution.

## Inputs, outputs and validation

Declare inputs in leading YAML frontmatter. Project-relative directory names are accepted
without a trailing slash there; unsafe declarations are reported unresolved. Paths mentioned
in prose are references and do not declare inputs or authorize reuse of existing outputs.
To freeze a file or tree, use a structured input such as `{path: notes.md, frozen: true}`.
Inputs are not frozen by default; `frozen: false` also leaves them mutable. Only the boolean
frontmatter field grants this protection: notes, roles, headings and prose are not enforced.
Nonboolean `frozen` values are unresolved input declarations, not coercions to true.
Settlement rejects and restores changed frozen bytes, and accepts identical bytes.

Outputs accept path strings or structured entries with `path`, optional `type: file|directory`
and `on_existing: update|append|replace`. They are create-only by default. Declaring an existing
output as an input records intentional reuse. Nonempty create-only files, create-only symlinks
and unsupported entry types block the output inventory. Explicit existing-content authority
admits project symlinks. Archival preserves symlink objects without traversing their targets.
Absolute external outputs require an explicit directory declaration: protected/root-level
overlaps and aliases are refused.
Their contents are not recursively inventoried by preflight. Rehearsal substitutes temporary
locations. A declaration is authority for its named location, not permission for siblings.
Project outputs may lie inside declared frozen input directories: freezing excludes the
declared output file or directory tree, while other frozen input paths stay protected. Existing-content rules
still apply.

`validation.commands` is a nonempty mapping of `build`, `test` and/or `lint` to
`{command: string, args: string[]}`. These declarations supply shell-free argv; unknown roles,
extra fields and control characters refuse parsing. Without declarations, setup discovers
commands from project configuration. [Setup](operations.md#setup-validation) owns the exact
baseline and comparison semantics. Do not replace the full configured suite with a subset.

Sources: [input/output inventory](../src/ship-inputs.ts), [setup parser](../src/cli-ship-setup.ts),
[validation discovery](../src/project-validation.ts).

## Research rounds

`research.measurement` is the only research contract. Roots use normalized,
portable project-relative filesystem names; drive-qualified roots, traversal and
Git metadata roots are refused at parse. Scope construction quotes punctuation
literally, so a root such as `src/[a].json` never grants writes to `src/a.json`.
See the runnable synthetic
[example](../examples/research-instrument.brief.md); it demonstrates the protocol,
not a benchmark result.

```yaml
research:
  measurement:
    frozen: [instrument/evaluate.cjs, instrument/answers.json]
    candidate: [src]
    environment: {DATASET: development-v1}
    replicates: 4
    metrics:
      wall: {direction: min, scale: fraction}
      passes: {direction: max, scale: count}
    primary: [wall]
    development: {command: /usr/bin/node, args: [instrument/evaluate.cjs, development]}
    guards:
      - name: retention
        command: /usr/bin/node
        args: [instrument/evaluate.cjs, retention]
        pass: {field: passes, equals: true}
    held_out:
      command: /usr/bin/node
      args: [instrument/evaluate.cjs, held-out]
      allowance: 2
      pass: {exit_code: 0}
    timeout_seconds: 300
  stop: {max_rounds: 20, max_wall_hours: 8, halt_after_no_improvement: 3}
terminal_states:
  ceiling_hit: {paths: [reports/research.md]}
```

The declaration constructs a producer and a read-only independent reviewer. The producer
chooses the next candidate from the brief and the engine journal; it never chooses a workflow.
A producer that fails or cannot dispatch fails the run. A round submits candidate-root content:
when its digest equals the current best's, the engine journals `no_candidate`, spends one
round of non-improvement, and runs no measurement. There are no author labels or result slots.

Review judges the candidate against the brief's stated scope, frozen instrument and checks
retaining their power. Review does not judge improvement, numbers, terminal-report prose or
missing engine reports. Rejected submissions are journaled with the review reason and never
measured or kept. The next round starts from the retained best.

Every producer result carries labelled `notes` with `hypothesis`, `files_changed` and
`property_evidence`. These are advisory text, never numeric measurement evidence.

Before any producer, the engine copies frozen roots, candidate roots and executable bytes,
then executes exactly the declared baseline replicate count. Failed calibration fails closed.
The incumbent is the per-item mean of every baseline replicate, paired by item ID. Raw count observations remain integers; their baseline means can be fractional. Replicate
count is author-declared (the existing schema requires at least two); no new minimum is imposed.
The frozen instrument must include its complete code/data dependency closure. A file that
loads code from a live checkout outside those roots does not make that dependency frozen.

Development prints one JSON object, for example
`{"items":[{"id":"task-a","metrics":{"wall":12.5,"passes":1}}]}`.
Metrics are finite and nonnegative; count observations are integers. Stable unique item IDs
must match across observations. Fractional baseline items must be positive.

For fractional noise the engine uses 4096 seeded cluster resamples (LCG seed 1108): choose
one ordered pair of distinct replicate runs, then sample paired items with replacement,
keeping that run pair for the entire resample. The population SD of pooled right/left ratios
includes whole-run shared shifts. Count noise is the root mean squared difference of complete
run totals across replicate pairs, with the existing one-count floor. Nonfinite noise fails
calibration. This replaces per-item replicate pairing, which cancelled shared run shifts.

A candidate is kept only if a primary metric improves strictly more than twice calibrated
noise and every guard passes. Fraction improvement uses pooled totals relative to the current
best; count improvement uses the difference. Exact decimal cross-products preserve strict
boundaries. Guards require an exact named JSON value or declared exit code (including nonzero).
They run only after development clears noise. Held-out runs only after development and guards
pass. Each held-out use is durably spent before launch, including failure or interruption;
uses cannot exceed the declared allowance and interrupted uses are never repeated.

Frozen and candidate roots must be regular local files/directories, disjoint and non-overlapping,
without symlinks. Identity binds bytes, permissions and directory membership, including empty
directories. The fingerprint binds the instrument declaration, frozen files, executable bytes
and explicit environment. Terminal reports must be outside frozen and candidate roots; publication checks physical destinations too. Relative arguments resolve within the retained instrument; absolute
declared project arguments and environment paths are rebound to retained inputs. Undeclared
absolute project inputs refuse measurement. Evaluators read candidate snapshots from
`FC_RESEARCH_CANDIDATE`; `FC_RESEARCH_CANDIDATE_SHA256` gives their digest.

Commands receive only declared environment, fixed PATH/LANG and private HOME/TMP. Reserved
injection variables and `FC_RESEARCH_*` cannot be declared. Linux x86_64/aarch64, Landlock ABI
at least 3 and `/usr/bin/python3` are required for write confinement. Only private HOME/TMP
and `/dev/null` are writable. The executable-start acknowledgement distinguishes launch failure
from a command exit code. Before and after execution, the engine checks originals, snapshots
and executable identity; change stamps also catch temporary permission changes restored before
command completion. Failed confinement, altered frozen roots, invalid output and command failures
produce an unmeasured observation that cannot keep a candidate.

After settlement the engine restores only candidate roots from the retained best. Every
ancestor is checked before the first mutation; an installed ancestor alias fails safely,
and a leaf alias can be removed without changing its target. Other evidence stays in place.

The loop consumes only these stop fields:

| Field | Consumer and meaning |
|---|---|
| `max_rounds` | `researchStopReason`: mandatory positive submission budget |
| `max_wall_hours` | `researchStopReason`, stage and measurement deadlines: elapsed allowance from original run start |
| `halt_after_no_improvement` | `researchStopReason`: consecutive submissions not kept, including unchanged/rejected submissions |
| `beat` | `researchStopReason`: optional inclusive target on the first primary metric after a kept candidate |

Held-out exhaustion also stops search. A successful target becomes `shipped`; other budget
stops become `ceiling_hit`, including an honest search with no kept candidate. Measurement
commands use the smaller of authored `timeout_seconds` and remaining run wall allowance;
there is no separate engine maximum on `timeout_seconds`. Research terminal floors cannot
extend the search budget. Ordinary engineering terminal floors retain their own behavior.

An unfinished budget handoff retains its files and re-pends the unfinished stage and
its consumers through the shared continuation lifecycle. Neither an unfinished producer
nor an unfinished reviewer can submit a candidate. The existing `max_continuations`
allowance bounds retained slices per stage and submission; without it, the finite run
iteration allowance supplies the continuation bound. Exhaustion yields `incomplete`
without measuring or discarding the unfinished work. Handoffs never become journal rounds.

The engine is the sole terminal-report author. It composes `engine/research_report.md` and
the declared terminal report from `engine/research_measurement/state.json`: baseline replicates,
mean incumbent, noise, fingerprint, each submission's comparison/decision/guards, and separately
labelled producer notes. Reality checks inspect candidate evidence before the terminal decision;
an engine-authored terminal report is the output of that decision, not a pending input to it.
Do not declare checks that require the terminal report before the decision. Checking its
existence or prose would duplicate the engine's publication checks, without independently
checking the candidate or instrument.

The engine commits the accepted terminal status and its report destinations under the run
lock, then publishes the report from that committed state. Normal project reports are written
once; no pending project report or provisional acknowledgement exists. The report, pointer
and completion event are idempotent projections of the committed state and measurement
journal. Conclusion, explicit recovery and the daemon's existing bounded reconciliation
sweep use the same projection. A terminal run missing these outputs is repaired without
dispatching stages or measuring again; complete projections are left unchanged. A lost
state-write acknowledgement propagates, and recovery reads the committed decision rather
than inventing another outcome. Actual report-publication failures still commit `failed`
before correcting exposed destinations. Committed destination intent retains those paths.
Cancellation fences both state and report publication; an in-flight measurement's later
journal settlement may refresh the cancelled report, retaining the committed cancelled status.
`terminalArtifact` names a successfully published report for the final status. Cancellation
remains authoritative even if a declared report cannot be published.
Stages never write this report. Measurement result records retain
command receipts and crash-safe held-out spending. A measurement comparison and its round journal entry commit together; recovery replays the same receipt without rerunning a spent instrument use. Resumption retains the baseline, noise,
best and spent allowance; interrupted initialization cannot recalibrate from a later candidate.

`flowcrew rehearse` uses the same constructor, admission, ready frontier and isolated stage
execution for the producer and reviewer. Its scripted results are labelled synthetic. It
fails if the constructed producer cannot dispatch, calls no model, and never executes declared
instrument commands. It verifies dispatch wiring; scientific calibration and instrument
availability are tested by the real run's fail-closed initialization.

### Migration from retired briefs

Declare `research.measurement` with frozen/candidate roots, metrics, primary metrics, baseline
replicates and development command. Move integrity/confirmation predicates into structured
`guards` and, for limited independent checks, `held_out`. Remove `result_file`, `result_schema`,
`report_dir`, `integrity`, `confirm`, `feasibility`, sidecars, author labels, `baseline`, `policy`,
`higher_is_better`, `context_roots` and legacy improvement margins. The engine measures its own
baseline and noise. Keep the supported stop fields above and declare a terminal report path.
No stage should write numeric result files, manifests or terminal reports. Historical records
remain readable without being migrated or rewritten.

Sources: [loop and report owner](../src/scheduler/sched_policy/research.ts),
[instrument and numeric rule](../src/research-measurement.ts),
[active input parser](../src/scheduler/sched_admission/brief-contract.ts),
[historical read types](../src/research-history.ts).

## Evidence authoring policy

When leading brief frontmatter selects `planner_policies: [evidence_statistics]`, the planner receives
these authoring requirements: a requested headline or quoted statistic needs its mean, median
and position in its own distribution; a rule frozen before outcomes needs a structurally
computed qualifying-member count, numeric feasibility floor and revision below that floor
before outcomes are seen. An operator numeric expectation requires exact result fields
`within_expected_range` and `method_was_not_adjusted_to_match_expectation`. These are injected
planning instructions, not an automatic statistic calculator or guarantee of model obedience.

Declare supplied numeric expectations in leading frontmatter as `supplied_numbers: [0, -112.89]`.
The value must be an array of finite YAML numbers; `[]` declares none, and any other shape
is refused. A nonempty array requires both exact anti-anchoring fields above as positive
result requirements; missing either makes preflight and rehearse fail.
This declaration works without operator wording in the body. Prose-only expectations produce
warnings; ordinary counts and the planning-policy selection do not
by themselves declare supplied numbers.

For other evidence, state the user-visible consequence, boundaries, counter-examples and
unacceptable outcomes. Preserve an authoritative exact mechanism when it is required; label
illustrative mechanisms as examples. For a known defect, require the unfixed reproducer and
recurrence evidence, including a failure rate with its denominator when recurrence matters.
Do not replace an outcome with a line-count check; if a count itself is a supplied requirement,
it remains binding. Explain concentrated contributions with per-item, largest-share and
leave-one-out evidence when those properties are part of the task.

Sources: [selected planning policy](../src/planner-policies.ts),
[gate contract](../src/scheduler/sched_settlement/gate-contract.ts).

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
- Declare intended inputs in frontmatter `inputs:`; prose paths are references only.
  Use structured entries with `frozen: true` for evidence that must remain unchanged.
  Reason: prose references neither declare inputs nor enforce freezing.
- Declare only intended task inputs and inspect target content/type collisions rather than
  adding unrelated declarations to satisfy setup; setup's target-copy rules remain authoritative.
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

## Terminal artifacts

`terminal_states` maps a known terminal run status to a path string, path list or object with
`paths` (or `path`). Declare only whole-run terminal products. Nonterminal keys are ignored
with diagnostics. For engineering each terminal path has one final ordinary producer; ordered authors and
repairs may share its write scope. Admission checks the producer's mandatory gate and criterion
ancestors. Intermediate reports belong in outputs,
not terminal declarations.

An entry may include `floor.min_attempted_stages`, `floor.min_wall_minutes` and `stage_glob`
(entry-level wins over floor-level). For generic terminal-file evaluation, attempted-stage proof counts fresh nonempty files
matching the declared evidence pattern. Result checks determine whether those receipts prove the outcome; file length does not.
Research reports are engine-owned and stopping is determined by the declared search budget.
For engineering, with an attempted-stage floor satisfied,
wall time is advisory; without it, wall time can be the sole floor. Use substantive artifacts
and criteria rather than elapsed time as evidence of work.

`post_terminate_hook` accepts `command`, optional string-array `args`, positive
`timeout_seconds` and string-valued `env`. It runs after terminal commit under the command
boundary, with a default 300-second timeout and `FC_PHASE`, `FC_VERDICT_FILE`, `FC_RUN_DIR`,
`FC_PROJECT_DIR`, `FC_RUN_ID` defaulting to the committed terminal context; explicit hook
`env` can override them. A failed/timed-out hook is
recorded without turning the already committed terminal into a live run. Treat it as real
execution authority and review it before launch.

Sources: [frontmatter/floors](../src/scheduler/sched_admission/brief-contract.ts),
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

A script runs via Bash from the project directory. Exit 127 with command-not-found diagnostics
becomes advisory with the failed execution retained. Versioned-JSON shape failures remain
failures unless the check explicitly declares `advisory: true`. This limits what a passing
Reality Gate proves. Rejected terminal candidates are quarantined; prose reports do not create
executable checks.

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
