# Configuration

FlowCrew reads project config from `config/defaults.yaml` and role overrides from `config/agents/<role>.yaml`.

## Defaults

```yaml
default_timeout_ms: 3600000
default_max_iterations: 5
default_gate_retry_loops: 3
default_stage_technical_retries: 1

adapter: codex
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
  stuck_threshold_ms: 600000
```

## Adapters

The current project default is:

```yaml
adapter: codex
```

Set `adapter: claude` globally or override a single role when that stage benefits from Claude Code.

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
