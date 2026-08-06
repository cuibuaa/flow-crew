# Architecture

FlowCrew separates planning, execution, verification, and supervision so long-running agent work remains inspectable and recoverable.

## Runtime Flow

```text
brief
  -> planner writes dispatch.yaml
  -> scheduler runs the stage DAG
  -> worker launches the configured backend adapter
  -> QA gates write verdicts
  -> fix stages retry failed gates
  -> supervisor observes and can guide, abort, replan, or mark early success
  -> run summary and knowledge graph are persisted
```

The supervisor is backend-driven. It uses the configured adapter and model, reads run state, stage output, and knowledge graph updates, then emits steering signals. It never edits code or runs shell commands directly.

## Inner Loop

The inner loop handles stage-level convergence:

- A planner creates stages.
- Workers execute stages.
- QA gates evaluate acceptance criteria.
- Failed gates trigger matching fix stages.
- Gates re-run up to `default_gate_retry_loops`; a gate that passes ends the loop
  immediately rather than consuming its remaining retry budget.
- Exhausted retries escalate to the outer loop.

This keeps one implementation attempt from being treated as a final answer.

## Outer Loop

The outer loop handles campaign-level convergence:

- Related runs share campaign history.
- Metrics, failures, and dead ends are carried forward.
- Regressions and plateaus can force a different strategy.
- Later planners receive context about approaches already tried.

Use the outer loop when the task needs exploration, repeated measurement, or multi-round improvement.

## Storage

Runs live under the global FlowCrew directory so one dashboard can show every project:

```text
~/.fc/runs/<runId>/run.json
~/.fc/runs/<runId>/task_brief.md
~/.fc/runs/<runId>/dispatch.yaml
~/.fc/runs/<runId>/knowledge_graph.json
~/.fc/runs/<runId>/supervisor_log.md
~/.fc/runs/<runId>/summary.md
~/.fc/runs/<runId>/.reality-gate.json
~/.fc/campaigns/<name>.jsonl
```

## Design Boundary

FlowCrew keeps "decide what should happen" separate from "make changes":

- Planner decides the stage graph.
- Worker stages do the work.
- QA stages verify.
- Supervisor steers but does not execute.
- Reality-Gate performs deterministic final checks.

That boundary makes runs easier to debug, replay, and audit.

## The atom grammar the planner writes in

The planner does not return prose that something later has to interpret. It emits a stage
graph the scheduler executes literally, written in a small fixed vocabulary — enough to
express not just *who does what*, but the shape of the work:

- **dependency** — which stages must finish first, and, for every edge, *why* it exists. An
  unexplained edge is not accepted, so the graph cannot quietly serialise itself into a chain.
- **iteration** — a stage can be marked a gate, and a gate names where failing work goes back
  to. That pair is the loop construct: rework is a declared edge in the graph, not an agent
  deciding to try again.
- **runtime expansion** — a stage can be allowed to emit further stages once it knows more, so
  the planner commits to a subgraph now and the rest when the problem is understood.
- **capability** — each stage declares which paths it may write. Declaring nothing means
  writing nothing; the closed case is the default, not an oversight.
- **budget** — a soft time budget per attempt and an immutable ceiling for the stage as a
  whole, so a stage can ask for more time without any path to unbounded time.

Because it is a grammar rather than a fixed template, the planner composes these freely for
the problem in front of it — a wide parallel fan-out for independent work, a narrow chain with
a gate looping back for work that must converge, an expansion point where the shape is not yet
knowable.

And because it is a grammar rather than prose, it can be checked before it runs. Each role
describes itself at its own source; a registry hands the planner the vocabulary it may compose
from and rejects anything it invents that is not in it. The menu and the validator are the same
list, so adding a role needs no prompt edit and the two cannot drift apart. A stage that does
not parse is dropped and named — never guessed at.

## Why the crew never certifies its own success

The same population of models writes the work, measures the work, and judges the measurement,
so a natural-language opinion that the bar was met is not independent evidence. Two rules
follow, and both are enforced rather than advised.

**A gate cannot move its own goalposts.** A gate stage writes its own verdict, but the engine
validates it against the declared acceptance contract and against the measurement the run
recorded separately. Renaming the metric, quietly lowering the threshold, claiming a pass on a
value that misses, and returning a verdict with no numeric value at all are each rejected into
a structured `{ pass: false, reason }` the retry loop can act on.

**A boundary that cannot be enforced is not a boundary.** Anything a stage writes outside its
declared paths is restored to its pre-stage contents, and the restore is re-read to confirm it
took. A stage that genuinely needs another file can ask, and the answer comes from a
deterministic scheduler policy rather than from persuading the supervisor — one of its
predicates being that the file must not already have been touched. A refusal is handed to the
next planning round as something the planner must grant properly or explicitly defer, rather
than leaving the stage to be retried into the same wall.
