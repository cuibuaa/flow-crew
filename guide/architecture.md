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
