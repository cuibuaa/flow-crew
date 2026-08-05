# Configuration

FlowCrew reads project config from `config/defaults.yaml` and role overrides from `config/agents/<role>.yaml`.

## Defaults

```yaml
default_timeout_ms: 3600000
default_max_iterations: 5
default_gate_retry_loops: 3
default_stage_technical_retries: 1     # adapter/transport retry, separate from gate loops
default_plan_stage_retries: 2          # a plan stage that emits zero valid stages gets this many re-prompts before escalating
default_supervisor_max_rejects: 2      # bounds how many times the supervisor can send one deliverable back for rework

adapter: auto
session_reuse: false                   # resuming a session measured ~9% lower wall time but 29% more output tokens; opt in with FC_SESSION_REUSE=1
model: default
reasoning_effort: default

paths:
  agents: config/agents
  workflows: config/workflows

campaign_triggers:
  enabled: true
  regression_after: 2
  plateau_after: 3
  plateau_threshold: 5
  repeated_failure_after: 3

supervisor:
  poll_interval_ms: 30000              # cheap heartbeat: detect transitions/anomalies
  routine_assessment_interval_ms: 180000  # throttled semantic LLM review; anomalies bypass both intervals
  stuck_threshold_ms: 600000
```

## Adapters

Newly initialized projects start undecided:

```yaml
adapter: auto
```

`auto` chooses the only installed CLI, or recommended `codex` when both are installed. It
does not write that runtime choice back to disk. If neither CLI is installed, live commands
exit nonzero with the correct Codex and Claude Code installation commands; `flowcrew init`
still succeeds and keeps `auto` so non-interactive scaffolding never blocks.

Inspect or set the value without hand-editing YAML:

```bash
flowcrew adapter
flowcrew adapter codex
flowcrew adapter claude
```

Existing explicit `adapter: codex` and `adapter: claude` configurations keep their meaning
and are never migrated. You can also override a single role when that stage benefits from
Claude Code.

```yaml
# config/agents/qa.yaml
adapter: claude
model: claude-opus-4-7
reasoning_effort: xhigh
```

Leave a field absent or set to `default` to inherit the project default.

## Supervisor

Supervisor mode is on by default for `flowcrew quick`. The supervisor uses the configured backend unless overridden:

```yaml
supervisor:
  stuck_threshold_ms: 600000
  adapter: claude
  model: claude-opus-4-7
  reasoning_effort: high
```

Use `--no-supervise` to disable it for a single run.

## Campaign Tagging

Resolution order:

```text
flowcrew quick "task" --campaign release-audit  -> explicit campaign
flowcrew quick "task"                            -> config campaign or slug(cwd)
flowcrew quick "task" --no-campaign             -> untagged run
```

Campaign metrics are written under `~/.fc/campaigns/`.

Campaign context is independent of that ownership decision:

```text
flowcrew quick "task" --campaign-context=inherit -> attached; inject relevant planner history (default)
flowcrew quick "task" --campaign-context=skip    -> attached; omit verbose planner history
flowcrew quick "task" --no-campaign              -> standalone; no campaign telemetry, KG aggregation, or grouping
```

`--campaign-context=skip` does not remove the campaign ID or its telemetry. It is an escape hatch for
planner context only; the compact deduplicated ledger still carries all known dead ends. The legacy
`--no-inherit-campaign` spelling remains accepted as an alias for `--campaign-context=skip`, but the
explicit context form is recommended for new scripts.
