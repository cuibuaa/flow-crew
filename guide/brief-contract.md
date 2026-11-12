# Brief contract

For a task author: how do I express the outcome, evidence and limits the run must satisfy?

Write a self-contained outcome, explicit input paths and real constraints. Declare machine
criterion identities in frontmatter `criteria: [{id, text}]` when planning or coverage needs
them. Prose, headings, numbering, bold labels, examples and languages have no criterion or
admission meaning. Stages still read and judge the complete brief.

## From a raw task

`flowcrew quick "<plain task>"` uses the configured, read-only `brief_writer` role when no
criteria are declared. `flowcrew brief "<plain task>"` prints composed bytes and digest for
review without launching; each preview makes a fresh call. An existing nonempty `criteria`
declaration skips authorship. See [CLI](cli.md#write-a-brief-before-running).

The model returns five string-array fields in one fixed schema: `criteria` (nonempty),
`constraints`, `inputs`, `assumptions`, and `blocking_questions`. Composition writes explicit
criterion IDs and text into leading frontmatter, preserving other metadata values and the
original body bytes. It appends constraints, input references, assumptions and questions as
stage-readable prose. Multiline criterion text stays a YAML value, including when the
original task has unclosed Markdown fences. There is no wording filter. A declared blocking
question stops authorship with exit 3; it is never retried into a guessed answer.

Generated input references must be repository-relative and present in Git's tracked HEAD
tree, where the prepared target will read them. Absolute, escaping, missing and ignored-only
paths use the correction path. The references are recorded as prose. Generated input references do not grant
input-freezing/output-reuse authority. The original input/output declarations are preserved. Author such declarations explicitly when needed.
The model supplies no workflow field. When `quick` generates a brief and the supplied
project has no exact setup record, it requires a clean Git source and prepares a sibling
worktree from `HEAD` through `ship-setup`, retaining all its admission checks. Target
and branch names use the composed digest, never model prose. An authored brief keeps
its existing exact-record requirement. The entry chooser and independent gates apply; research loops require the versioned instrument declaration.
Static rehearsal and preflight validate generated content, with reasons returned for up
to two correction retries. Authored briefs passed to inspection/setup/rehearsal do not need Markdown criteria;
invalid declarations are refused with their field names. Failed provider calls stop with exit 4, are not
replies and consume no correction retry. An exhausted invalid invocation can be rerun
with fresh attempts; all previous evidence remains. Only valid, unregistered replies
are replayed after a host stop. Preview evidence follows the composed digest across targets.

## Engineering and workflow selection

This is an illustrative engineering envelope, not a complete launch-ready task:

```yaml
---
criteria:
  - {id: result, text: The requested result is independently verified.}
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

Follow it with stage-readable goal, constraints and acceptance prose. Engineering enters a
model chooser, which chooses author/review/repair work or decomposition. A `research` block with
`protocol: research-instrument/v1` constructs an author and an optional declared project
review directly. No model chooses the research workflow. Legacy active declarations,
including `objective:`, are refused with a diagnostic naming the required version.
Historical records remain readable through a separate legacy decoder.
Use ordinary engineering gates and configured validation for a known pass/fail task.

Sources: [frontmatter](../src/scheduler/sched_admission/brief-contract.ts),
[criterion declarations](../src/brief-criteria.ts), [preflight](../src/brief-preflight.ts).

## Criterion identities and admitted records

`criteria` is optional. When present it must be a nonempty array of strict `{id, text}`
objects with unique nonempty IDs and nonempty text. IDs are authored and stable across
wording changes; the brief hash still binds exact bytes. Planning, gate coverage and discharge
use only these IDs. Without a declaration there is no machine criterion inventory; stages
and independent review still judge the complete brief. Headings and lists create no IDs.
Existing run records and stored criterion artifacts retain their admitted identities,
including historical slug IDs and illustrative-exclusion metadata. Status, watch, listing
and UI readers do not run the active brief schema over archives. Continuations retain the
admitted workflow, metadata and criterion artifact; they do not reinterpret old prose.
Legacy input paths come from the exact setup verification receipt when available, with a
read-only decoder that preserves the exact historical path aliases, normalization and
freezing semantics in older records. Unrelated metadata does not create input authority.
New runs commit all admitted metadata with a configuration-complete marker; preparation
interrupted before that commit finishes from the original stored brief bytes, including
publication of a missing declaration snapshot. Legacy archives without that marker retain
their admitted interpretation.

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

One strict schema reads only the leading top-level `inputs`, `outputs` and `criteria`
fields. Other frontmatter contracts have their own readers; arbitrary nested metadata is
never searched for paths. Inputs are an array of path strings or `{path, frozen?, type?, sha256?}` entries.
The opening delimiter must start at the first byte (after an optional BOM); a leading blank
line or other whitespace makes the block body prose in admission and configuration alike.
`type` is `file|directory`; `sha256` is a lowercase 64-digit digest checked against file bytes.
A supplied hash on a directory is refused. Copy verification also compares source/target hashes.
Outputs are an array of path strings or `{path, type?, on_existing?}` entries. No field
aliases, nested path collections or guessed metadata keys are accepted inside these entries;
unknown fields are schema errors naming the key. For example:

```yaml
---
inputs: [src, {path: evidence.csv, frozen: true}]
outputs: [result.md, {path: reports, type: directory, on_existing: update}]
criteria:
  - {id: evidence, text: The result includes independently checked evidence.}
---
```

Paths are literal filesystem names. Project-relative directories may have a trailing slash.
Traversal, surrounding path whitespace and absolute inputs are refused. Relative paths must
retain their spelling under the engine project-path normalizer; unsupported root spellings
are schema errors. Punctuation and numeric path components are literal; the engine does not guess whether a string looks like prose or a fraction.
Paths mentioned in prose are references and grant no input or output authority.
Only `frozen: true` freezes an input; omission or `false` leaves it mutable. Nonboolean
values and unknown annotations are schema errors. Input/output identity and admitted frozen
bytes are checked by hashes and physical paths, not by preservation wording.
Settlement rejects and restores changed frozen bytes, and accepts identical bytes.

Outputs accept path strings or structured entries with `path`, optional `type: file|directory`
and `on_existing: create|update|append|replace`. They are create-only by default. Declaring an existing
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
extra fields and control characters refuse parsing. The block may also state the validation
limits, both optional positive integers: `timeoutMs` (the time one execution of the whole
batch may take, shared among its commands; at most 2147483647) and `attempts` (the executions
of an unfinished batch). A non-number, a non-positive or fractional value, or any other field
refuses parsing with its name. The project's own `config/validation.json` accepts the same two
fields. Per field, the brief's value wins, else the project's, else the engine's
`validation_timeout_ms` or `validation_attempts`. A brief may state limits without `commands`;
the commands then come from the project declaration. Concurrency and priority are not brief fields. Without declarations, setup discovers
commands from project configuration. [Setup](operations.md#setup-validation) owns the exact
command selection semantics. Do not replace the full configured suite with a subset.
The engine validates settled author and repair trees outside author budgets. One completed
record per content hash supplies every review and gate with direct exits and structured
reporter totals. All zero exits accept validation; any nonzero exit rejects. Unfinished
executions retry within the declared `attempts` and `timeoutMs` (engine defaults when absent);
exhaustion parks the run without spending a review or repair round. A suite that needs longer
than the engine default declares its own `timeoutMs` (project or brief); the record shows the limits in force. The
store-wide FIFO uses engine `validation_concurrency` and `validation_priority` (niceness),
across daemon scheduler processes. Resume reuses completed records and preserves spent resource allowance.
A completed record is reused under any limits and is never executed again. The record's
allowance is `timeoutMs × attempts`; each execution is charged its full `timeoutMs`. An
unfinished record runs again only while its spent total is below the requesting declaration's
allowance, so the same or a smaller allowance never reopens an exhausted record.
Authors run related tests and end their invocation; they never run or poll full validation.

Sources: [input/output inventory](../src/ship-inputs.ts), [setup parser](../src/cli-ship-setup.ts),
[validation discovery](../src/project-validation.ts).

## Research instrument protocol

The project owns measurements, replicates, statistics, thresholds, diagnostics, early
stopping and report content. The engine owns immutable snapshots, write confinement,
execution receipts, replay, the incumbent pointer, hard budgets and cancellation.

The complete active declaration is:

```yaml
research:
  protocol: research-instrument/v1
  candidate: [src]
  frozen: [instrument, instrument-config.json]
  argv: [/usr/bin/node, instrument/run.cjs]
  environment: {}
  author:
    role: coder
    instruction: Propose the next candidate using the incumbent and instrument history.
  budget:
    max_rounds: 6
    wall_seconds: 3600        # optional total elapsed cap, from original run start
    invocation_seconds: 60   # optional per-invocation cap
  review:                    # optional; absent means no review stage
    role: qa
    criteria:
      - Candidate preserves the project's specified compatibility property.
  publication: reports/research.md  # optional project destination
```

Roots are normalized literal project-relative paths, with no aliases, traversal or
Git metadata roots. Frozen instrument/config roots and candidate roots must be
non-overlapping. The publication path must be outside both. Review `criteria` become declared
criterion identities `review-1`, `review-2`, … for the review gate; the engine reads no brief prose for them. `argv[0]` is an absolute
executable; its bytes are retained along with frozen roots. Arguments and environment
values are passed literally. They are not rewritten to guess embedded dependency paths.
The command's working directory is the retained frozen tree. The program reads candidate
and instrument paths from its request. The explicit environment is supplemented only by
engine-owned HOME/temporary directories, PATH and LANG; runtime injection variables are
reserved. The project is responsible for its transitive read/executable dependency closure.
Write confinement is inherited by child processes; it does not claim hermetic reads.

The engine appends one read-only JSON request path to the declared argv. There are three
phases: `initialize`, `evaluate`, `finalize`. Every request has these fields:

| Field | Contract |
| --- | --- |
| `protocol` | Exactly `research-instrument/v1` |
| `run_id`, `invocation_id`, `phase`, `round` | Engine identities; initialize is round 0 |
| `instrument_sha256`, `instrument_path` | Digest of declaration, frozen tree and executable; retained root |
| `candidate` | `{path, sha256, label}` identifying the immutable submitted snapshot |
| `initial`, `incumbent` | The same identity shape for initial and retained candidates |
| `history` | Every committed outcome in order, including rejected and failed invocations and non-measured submissions |
| `previous_state` | Previous valid response's `next_state`, including rejects and unavailability, unchanged JSON; initially null |
| `remaining_budget` | Remaining `rounds` and `wall_ms`, plus the declared per-call `invocation_ms` cap; null means no cap in that dimension |
| `engine_stop_reason` | Present at finalize; an engine control reason, separate from project conclusions |

Every history entry retains candidate and round identity, outcome and reason, and
`{path, sha256}` references to its engine-owned `request`, `result` and `raw` process
receipt when an invocation exists. Complete validated responses and advisory author/review
results are also included. Non-invoked submissions have a result reference and no fabricated
request, raw observation or response. References are verified before reuse.

An instrument writes exactly one bounded JSON response to stdout (4 MiB limit per output
stream). Stderr is retained separately with the same bound; exceeding a bound retires the
process and records an execution error. The response schema is:

```json
{
  "protocol": "research-instrument/v1",
  "run_id": "echo request run_id",
  "invocation_id": "echo request invocation_id",
  "phase": "evaluate",
  "round": 1,
  "instrument_sha256": "echo request instrument_sha256",
  "candidate_sha256": "echo request candidate.sha256",
  "status": "ok",
  "verdict": "reject",
  "reason": "Project-defined explanation",
  "observations": {"arbitrary": ["project", "JSON"]},
  "diagnostics": {"nested": {"arbitrary": true}},
  "artifacts": [],
  "next_state": {"arbitrary": "project state"},
  "stop": null
}
```

All identity fields must match exactly. At initialize, an `ok` response requires
`verdict: baseline`; at evaluate it requires `keep` or `reject`. At finalize, `ok`
requires `report: {content: "project report text"}` and no verdict. A valid
`status: unavailable` has no verdict or report. The project decides whether to request
another round or stop; the engine does not infer a scientific result from unavailability.
`observations`, `diagnostics` and `next_state` accept arbitrary JSON and are never narrowed
to metric names, task IDs or selected fields. The raw stdout is retained as well. Opaque numeric tokens retain their wire spelling, including values beyond JavaScript precision or range. Invalid UTF-8 stdout is an execution error before envelope validation; invalid raw streams retain their original bytes as base64 in the receipt. A valid UTF-8 replacement character remains ordinary opaque data.
`stop`, if present, is null or `{reason: "project reason", outcome: <arbitrary JSON>}`.
An artifact is `{path: "relative/file", sha256: "file digest"}`. Paths refer to regular
files under the invocation's HOME scratch directory; the engine verifies and retains them
before scratch retirement. TMPDIR is also writable but is command-lifetime scratch.
Unknown envelope fields are refused; project-specific extensions belong in opaque payloads.

A reject is a successful execution of project policy. Missing/unstarted executables,
nonzero exit, timeout, malformed or identity-mismatched envelopes and changed inputs are
**execution errors**, never rejects. Raw start, direct exit/signal, stdout, stderr and duration
receipts survive failures. The engine stops the loop on unrecoverable execution error.
An author may discuss numbers, but neither an author note nor an independent review can
supply an instrument verdict. A failed declared review is a review outcome, never a numeric
observation. An unchanged candidate consumes one round as `no_candidate` without invoking
the instrument or inventing an observation.

The sequence is freeze initial/instrument → initialize → author from incumbent → capture
submission → optional declared review → evaluate → atomic commit of result, opaque state
and incumbent → restore incumbent → repeat within budget → finalize. The next author sees
the incumbent and the complete lossless committed history, diagnostics and state in its
prompt and read-only state carrier. A reserved invocation is not silently repeated after
an uncertain crash; external effects should use the invocation ID as their idempotency key.
A committed result replays without remeasurement, including a crash before state projection. The same commit journal records the engine stop intent before finalization, so a crash after finalizer settlement cannot start another author or replace the control result.
Retained unfinished author work continues through the ordinary continuation mechanism.
Hard wall caps and cancellation also retire owned processes; finalization cannot exceed a cap.
After native cancellation proves the scheduler and its owned work stopped, control uses
the same finalization journal to restore the incumbent and write the manifest. Cancelled
runs launch no new instrument work, including a finalizer; its non-execution is recorded.
Unresolved process fate defers restoration. This replaces dependence on a surviving
scheduler finish closure and does not authorize recovery to publish project files.
Restoration also requires the cancelled run to retain project write ownership. Launch
claims retain their last owner after release; the existing lock primitive serializes
admission and restoration for that project. A newer live or completed run revokes the
older run's writes. Unknown or advanced ownership skips restoration and records
`restoration_skipped: project_ownership_changed_or_unknown` in the cancelled manifest;
the retained incumbent remains available in its immutable snapshot. This replaces
unconditional delayed restoration, without ordering reports or changing the run result.
The effective execution deadline is the earlier of the remaining wall allowance and
the per-call cap. If no finalizer can execute within that allowance, the manifest
retains its execution error and the incumbent; no project report is fabricated.

The current confined runner requires Linux x86_64/aarch64, Landlock ABI 3 or newer,
and `/usr/bin/python3`. These are execution capabilities, not project measurement
rules. A confinement or executable-start failure has the same execution-error
boundary as a malformed response. Requests and retained inputs are read-only to
the instrument and its children; only private HOME/TMP scratch is writable.

`engine/research_measurement/` contains snapshots, immutable requests, raw receipts, results
and atomic commits. `engine/research_measurement/state.json` is a recoverable projection of those commits. Finalize
consumes the complete committed history and supplies the project report. The authoritative
run-local `engine/research_manifest.json` records the engine stop reason, initial and final
incumbent identities, instrument digest, all outcomes and finalizer/report references.
`engine/research_report.md` contains the project report, when available. A finalizer error
is retained in the manifest; the engine never invents scientific report content.
Ordinary completed research loops use process status `complete`, regardless of project
success or ceiling claims; the project outcome remains opaque in the response.

The terminal publisher attempts the optional project destination once. It writes
`engine/research_publication.json` with a unique attempt identity before delivery, then records publication or its error. Only the active research loop calls the terminal publisher; shared conclusion and recovery paths never deliver project files.
A lost acknowledgement remains a recorded uncertain/failed delivery, not permission to retry.
Publication never changes run status, stop reason or incumbent. Recovery and `land` never
write project reports, including when a previously published report was removed. Native
cancellation is reflected in the run-local manifest even when it wins between finalization
and terminal commit; this control reconciliation never republishes project files. There is
no cross-run report ordering, supersession scan or replay publication. The run-local
manifest remains authoritative if another run later publishes at the same project path.

The protocol envelope and one invocation reservation/commit journal replace the
metric/guard DSL, baseline repetition and separate limited-check spending records.
The same history replaces the lossy author observation projection. Optional project
review replaces universal review criteria, and finalizer content plus the separate
publication receipt replace engine scientific report templates and report recovery.

Summaries and campaign views read the manifest and committed instrument history without inferring metrics or scientific success. They show the incumbent digest, each recorded outcome, opaque diagnostics and publication state. Historical journal and measurement-era records use an explicit legacy decoder; their archived decisions and unknown fields remain unchanged. The engine no longer supplies a dose panel or interprets graded-floor prose.

See the runnable [controlled example](../examples/research-instrument.brief.md),
[protocol schema](../src/research-instrument.ts), [runner and record API](../src/research-measurement.ts),
[loop](../src/scheduler/sched_policy/research.ts) and [read-only protocol and legacy readers](../src/research-history.ts).

## Evidence authoring policy

Statistical rigor and anti-anchoring requirements belong in the authored brief and project
checks. The engine does not inspect numeric expectations, negation, example labels, or
English/Chinese phrases, and injects no statistical planning obligations. The retired
`planner_policies` and `supplied_numbers` metadata have no engine meaning. State any required
result fields and independent-computation evidence explicitly for stages and reviewers.
There are no retained prose advisories in P1; authoring preflight/rehearse show declared
contracts, hashes and bounded inspection results. A warning never grants stage authority.

When the project needs a quoted statistic, the author can require its mean, median and
position in its own distribution. For a rule frozen before outcomes, the author can require
a qualifying-member count and numeric feasibility floor before outcomes are seen. These
are optional project authoring requirements; the engine neither infers nor injects them.

For other evidence, state the user-visible consequence, boundaries, counter-examples and
unacceptable outcomes. Preserve an authoritative exact mechanism when it is required; label
illustrative mechanisms as examples. For a known defect, require the unfixed reproducer and
recurrence evidence, including a failure rate with its denominator when recurrence matters.
Do not replace an outcome with a line-count check; if a count itself is a supplied requirement,
it remains binding. Explain concentrated contributions with per-item, largest-share and
leave-one-out evidence when those properties are part of the task.

Sources: [declaration schema](../src/brief-declarations.ts),
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
  accompanied by any project-required anti-anchoring evidence, rather than a settled premise.
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
with diagnostics. Engineering terminal acceptance belongs to the terminal evaluator: the artifact must
be present with content different from its launch baseline, required work must settle, and the
effective independent gate outcomes must pass. Authorized authors, repairs and other authorized
stages can produce it; a stage's write ledger does not prove publication. Touching or rewriting
identical launch bytes does not count. A gate's study-completion verdict follows the same evaluation.
Existing frozen-input, read-only review and engine-record
protections still refuse unauthorized writes. Criterion review uses the same admission rules for
terminal reports and other work. Intermediate reports belong in outputs, not terminal declarations.
Passing independent review must follow the product changes it accepts; a dependency edge does not
substitute for that execution order. Read-only execution preserves ignored-file preimages for rollback;
special filesystem entries retain unknown preimages, which never authorize destructive restoration.
If a refused write leaves an unrestored file or topology, the existing integrity disposition stops
the run before a retry can adopt that content. Unsupported special entries remain untouched and
cannot qualify as terminal files.
An archived engine snapshot remains reader evidence; it does not substitute for an absent declared
project artifact at settlement. Multiple fresh outcomes are ambiguous and cannot terminate the run.
Historical records without a
content baseline retain their original timestamp interpretation for readers and continuation.

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
[criterion admission](../src/scheduler/sched_admission/dispatch.ts),
[terminal settlement](../src/scheduler/sched_policy/terminal.ts).

## Deterministic checks

Declare `reality_checks` as an array in leading frontmatter. Markdown headings and body
examples create no executable checks, even when headed `## Reality checks`. Existing
admitted legacy runs retain their original checks. The scheduler also consumes its admitted
planner check snapshot. Each check supplies
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
---
reality_checks:
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
---
```

Legacy archives without a setup receipt retain mutable and frozen input identities through a read-only compatibility decoder. That decoder does not admit new briefs or confer new output authority.
