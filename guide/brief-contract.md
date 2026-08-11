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

`objective` is accepted as an alias for `research`. A numeric `baseline` is the
field that activates parsing. An omitted or unknown `policy` defaults to
`greedy_stack`. The `quick` command's automatic workflow selection recognizes
the `research:` spelling; pass `--workflow research` explicitly when using the
`objective:` alias.

| Key | Contract |
|---|---|
| `baseline` | Required number: the running-best value at entry. |
| `policy` | `greedy_stack`, `best_of_n`, or `replace_if_better`. |
| `higher_is_better` | Direction of improvement; defaults to true. Boolean strings `"true"` and `"false"` are coerced. |
| `result_file` | Project-relative latest-round JSON. Default: `docs/research_round_result.json`. |
| `report_dir` | Project-relative directory for framework-owned reports and `run_manifest.json`. Default: `docs`. |
| `result_schema` | JSON Schema subset used both in planner context and at round ingestion. |
| `context_roots` | Project-relative roots inventoried for a dynamic planner. Default: `data`. |
| `directions` | Opaque portfolio labels an outer campaign should cover before accepting a frontier. |
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
| `verdict_<stageId>.json` | Gate stage | Scheduler | `<runDir>`; durable gate evidence for retries, summaries, and campaign metadata. |
| Round result | Measurement stage | Research advance gate | Path from `research.result_file`; one fresh JSON object per round. After ingestion it is moved to `<runDir>/research_round_<N>_consumed.json` and journaled. |
| `approval_request.json` | Any stage needing authority | Approval park gate | Prefer `<runDir>/stages/<stageId>/approval_request.json`; consumed into `approvals/` and the append-only inbox log. |
| `reality_checks.md` | Planner | Reality-Gate | `<runDir>/reality_checks.md`; evaluated with the brief's own checks before a successful terminal commit. |
| `handoff_<stageId>.md` | Each stage on completion | The next stage that depends on it | `<runDir>/handoff_<stageId>.md`; what a stage passes forward, rather than the next stage re-reading its predecessor's full output. |
| `scope_revision_request.json` | A stage needing a path outside its declared scope | Scheduler policy, which writes `scope_revision_decision_*.json` beside it | `<runDir>/stages/<stageId>/`; answered by a deterministic predicate chain — matching run and live attempt, digest-verified paths, no collision with a running peer, and the requested file not already modified — never by the supervisor. |
| Guidance | Supervisor, scheduler, or operator path | Later workers/planner | Run-level `supervisor_guidance.md` plus optional `stages/<stageId>/guidance.md`; snapshotted for each consuming stage and archived by iteration. |
| Terminal artifact | Agent, or the research engine when it owns the decision | Terminal-state gate, summary, operator | Project path declared in `terminal_states`; snapshotted as `<runDir>/terminal_<basename>` when detected. |
| Stage output | Every stage attempt | Retries, summary, operator | `<runDir>/stages/<stageId>/output.md` always holds the latest attempt. A retry that needs to read what an *earlier* attempt actually produced uses `output_attempt_<n>.md`, written alongside it for every numbered attempt — `output.md` alone was overwritten by each new attempt, so a passing attempt's output could be destroyed by a later one that failed in seconds. |

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
  timeout_ms: 600000
  timeout_total_ms: 1800000
  max_retries: 1
  skills: []
  dynamic_dispatch: false
  is_gate: false
  retry_to: []
```

`id` and `role` are required. `prompt_template` defaults to empty, and `task` is
accepted as a compatibility alias. Optional fields are `depends_on`,
`condition`, `timeout_ms`, `timeout_total_ms`, `max_retries`, `skills`, `dynamic_dispatch`,
`is_gate`, `retry_to`, and `scope`. Unknown roles and invalid or duplicate stages are
skipped; an entirely unusable dispatch triggers a bounded re-plan or an
actionable escalation.

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

`timeout_ms` is the initial attempt budget. `timeout_total_ms` is the immutable
cap for the complete technical chain (scheduler retries, adapter retries,
backoff, and fallback) and defaults to `3 * timeout_ms`; it cannot be smaller
than the resolved initial budget. A running stage or supervisor may propose a
reasoned extension of the current soft deadline, but worker policy records the
decision first and never grants beyond this total cap. A real timeout retry is
scheduled only with a strictly larger budget than the timed-out attempt.

Every `retry_to` target is normalized to a gate and added to the repair stage's
dependencies. Only a completed, validated `pass:false` verdict makes that
repair eligible; a pending or never-run gate blocks terminal success but does
not dispatch its repair.

### Gate verdicts

A gate stage is instructed to write:

```json
{"pass": false, "reason": "The acceptance command still fails."}
```

`pass` and `reason` are the core fields. Scored gates may also provide `score`,
`metric`, and `threshold`; campaign phase gates may carry the phase metadata
listed in their prompt. The path is specific to the gate stage, so concurrent
gates do not overwrite one another.

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

Setup is the fail-closed boundary: it creates the declared worktree, links exact ignored inputs
that Git omitted, verifies their assertions again through the target, and records the target's
baseline only when everything is reachable and the commands can actually run. Its ready record
stores the exact brief digest and is keyed by that digest plus the canonical target. Use
`flowcrew watch` after launch for a continuous heartbeat and edge-triggered stalls; `--once`
performs one read-only pass.
