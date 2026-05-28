# CLI Reference

## Core Commands

```bash
flowcrew init
flowcrew quick "task"
flowcrew status
flowcrew list
flowcrew guide "message"
flowcrew start
flowcrew doctor
flowcrew clean
flowcrew export
flowcrew version
```

## `flowcrew quick`

`flowcrew quick` runs a task without needing the dashboard server.

```bash
flowcrew quick "fix failing tests"
flowcrew quick --task "$(cat task.md)"
echo "review this module" | flowcrew quick -
```

Common flags:

| Flag | Default | Description |
|---|---|---|
| `--project <path>` | cwd | Project directory |
| `--adapter <name>` | `defaults.yaml` | `codex` or `claude` |
| `--workflow <name>` | `default` | Workflow from `config/workflows/` |
| `--max-iterations <n>` | config | Max plan-execute-review cycles |
| `--timeout <ms>` | config | Per-stage timeout |
| `--supervise` | on | Enable supervisor |
| `--no-supervise` | off | Disable supervisor for this run |
| `--campaign <name>` | config or cwd slug | Attach run to a campaign |
| `--no-campaign` | off | Run without campaign tagging |
| `--no-inherit-campaign` | off | Do not inject campaign history |
| `--background` | off | Register with daemon and detach |
| `--task "text"` | none | Provide task as a flag |
| `-` | none | Read task from stdin |

## Daemon Commands

```bash
flowcrew daemon start
flowcrew daemon stop
flowcrew daemon status
flowcrew task list
flowcrew task show <id>
flowcrew task stop <id>
```

Use daemon mode for background or long-running tasks where the shell session should not own the process lifetime.

## Reality Audit

```bash
flowcrew audit-reality
flowcrew audit-reality --task <id>
```

Reality audit applies deterministic checks to past runs and reports which terminal results were supported by real evidence.
