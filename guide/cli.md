# CLI Reference

## Top-level Commands

The current `src/cli.ts` dispatcher exposes 20 commands:

| Command | Purpose |
|---|---|
| `init` | Initialize FlowCrew configuration and storage in a project. |
| `adapter` | Show or explicitly set the project adapter choice. |
| `quick` | Run or enqueue one task brief. |
| `status` | Show the latest run. |
| `list` | List recent runs. |
| `guide` | Send guidance to one explicitly selected running supervisor. |
| `clean` | Delete old run directories. |
| `export` | Export a run as JSON. |
| `campaign` | Run and manage configured campaigns. |
| `campaign-loop` | Run the autonomous research direction loop. |
| `daemon` | Operate the background orchestrator. |
| `dashboard` | Query the running web dashboard. |
| `task` | Inspect and control daemon tasks. |
| `audit-reality` | Re-run deterministic checks against task history. |
| `inbox` | Resolve approval requests that parked runs. |
| `rehearse` | Exercise a brief with the real scheduler and a scripted agent. |
| `brief` | Inspect, diff, or roll back a versioned brief. |
| `doctor` | Check the runtime, configuration, builds, and agent CLIs. |
| `start` | Start the web dashboard. |
| `version` | Print the FlowCrew version. |

## Core Commands

```bash
flowcrew init
flowcrew adapter
flowcrew adapter claude
flowcrew quick "task"
flowcrew rehearse <brief.md>
flowcrew status
flowcrew list
flowcrew guide --run <run-id> "message"
flowcrew start                       # web dashboard only
flowcrew daemon status               # background orchestrator identity/freshness
flowcrew daemon restart              # reload the background orchestrator
flowcrew dashboard status            # query the web dashboard listener
flowcrew campaign run <config.yaml>
flowcrew campaign-loop - --project <dir> --campaign <name>
flowcrew task list
flowcrew audit-reality
flowcrew inbox list
flowcrew brief head <briefDir>
flowcrew doctor
flowcrew clean
flowcrew export
flowcrew version
```

## `flowcrew rehearse`

Rehearse a brief before spending tokens or allowing a live agent to run:

```bash
flowcrew rehearse examples/hello-research.brief.md
flowcrew rehearse path/to/brief.md --static-only
```

The default command parses the brief and then runs the real scheduler with an in-process scripted adapter in an isolated temporary project and `FC_HOME`. It launches no agent process or model, consumes no tokens, and does not write to the selected project. Its temporary Git repository ignores inherited `GIT_*`, global/system config, signing, hooks, and templates. If Git or the simulation still cannot run, the report gives a concise explanation and a pasteable `--static-only` command; raw child-process buffers and Node stacks are not the user-facing diagnosis. `--static-only` skips the scheduler simulation; `--keep` preserves the otherwise temporary rehearsal artifacts for inspection.

An exit-zero report ends with `✅ Contract ready`. The static section also prints the exact brief digest and whether live admission requires an explicit acknowledgement. This verifies the engine-to-brief contract—frontmatter, research result consumption, stop rules, terminal paths, and confirmation wiring—not the truth or quality of a future research result. A `✗` is a contract failure that should be fixed before launch; a `⚠` is a review item that may be intentional.

See [Zero-token rehearsal](rehearse.md) for the complete boundary.

## `flowcrew adapter`

Inspect adapter state without changing the project:

```bash
flowcrew adapter
```

The output names the current configuration value, the physically installed adapter CLIs,
and the recommended execution backend. Set a value with a directly pasteable command:

```bash
flowcrew adapter auto
flowcrew adapter codex
flowcrew adapter claude
```

An explicit physical adapter must be installed before it can be selected. `auto` remains
undecided on disk: at runtime it chooses the only installed CLI, or recommended `codex`
when both are installed. If neither is installed, live execution exits nonzero and prints
both installation commands. Runtime fallback is in memory only; `quick`, `start`, and the
dashboard never rewrite `config/defaults.yaml` while resolving an adapter. Existing
projects with explicit `codex` or `claude` values remain valid and are not migrated.

`flowcrew init` uses the same facts when creating a new project. With both CLIs it prompts
only on a TTY and preselects `codex`; non-interactive init chooses the recommendation and
states why. With neither CLI it creates `adapter: auto` and succeeds, so daemon-oriented
or image-building scaffolds cannot hang on a prompt.

## `flowcrew guide`

Target a running run directly whenever more than one task may be executing:

```bash
flowcrew guide --run 2026-08-02T12-00-00-a1b2c3 "try the isolated reproduction"
```

Without `--run`, guidance is sent only when exactly one readable run is currently
executing. With no running run or multiple candidates, the command exits non-zero
without writing any `user_input.md`; the ambiguous case lists the candidate run IDs
and task titles. Explicit targets must exist and still be running.

## `flowcrew quick`

`flowcrew quick` runs an already-authored task brief without needing the dashboard server.
It always prints the shared static preflight before loading an adapter, writing the project
brief, registering a daemon task, or creating a run. A single-line request is reported as
plain text because no structured brief contract was available to validate; use the `ship`
skill (`/ship` in Claude Code, `$ship` in Codex) to author one or
`flowcrew rehearse <brief.md>` to inspect a file first.

```bash
flowcrew quick "fix failing tests"
flowcrew quick - < task.md
flowcrew quick --background - < task.md
```

Warnings and contract failures are honest diagnostics, not an absolute denial policy. If
the report has consequential findings, `quick` exits before launch and prints the exact
digest-valued continuation flag. A human two-pass launch can use:

```bash
flowcrew quick - < task.md
flowcrew quick --acknowledge-brief-warnings=<digest-from-report> - < task.md
```

CI and cron may use the bare `--acknowledge-brief-warnings` flag when their policy accepts
findings on the current input. It still inspects and prints every result, and it never reads
an interactive answer from stdin, so unattended jobs cannot hang. Reading a file through
stdin preserves trailing newlines; `--task "$(cat task.md)"` does not.

> [!WARNING]
> `quick` runs the selected agent without approval or sandbox prompts and can retain full shell access for hours. Use a dedicated workspace or isolated environment. It also writes the submitted task to `<projectDir>/docs/task_brief.md`; if different content already exists there, FlowCrew warns and then replaces it.

Common flags:

| Flag | Default | Description |
|---|---|---|
| `--project <path>` | cwd | Project directory |
| `--adapter <name>` | `defaults.yaml` | Registered adapter: `auto`, `codex`, `claude`, or `mock` |
| `--workflow <name>` | `default` | Workflow from `config/workflows/` |
| `--max-iterations <n>` | config | Max plan-execute-review cycles |
| `--timeout <ms>` | config | Per-stage timeout |
| `--supervise` | on | Enable supervisor |
| `--no-supervise` | off | Disable supervisor for this run |
| `--campaign <name>` | config or cwd slug | Attach run to a campaign |
| `--no-campaign` | off | Run without campaign tagging |
| `--campaign-context=inherit\|skip` | `inherit` | Include or skip relevant planner history without changing campaign ownership |
| `--background` | off | Register with daemon and detach |
| `--acknowledge-brief-warnings[=<digest>]` | off | Explicitly continue the current inspected brief; never skip the report |
| `--task "text"` | none | Provide task as a flag |
| `-` | none | Read task from stdin |

Unknown adapter names fail before a task runs and list the registered values. The `mock` adapter reads deterministic per-stage JSON files from `MOCK_FIXTURE_DIR` and never invokes a model; use the isolated example in [`examples/README.md`](../examples/README.md) to see a complete zero-token loop.

Campaign ownership and planner context are separate dimensions. `--no-campaign` makes the run fully
standalone: it writes no campaign telemetry, contributes no campaign KG aggregation, and appears
ungrouped in the dashboard. `--campaign-context=skip` keeps the run attached and grouped, but omits the
verbose prior-run score/phase block from planner prompts. The compact deduplicated ledger, including all
known dead ends, remains available. `--no-inherit-campaign` is retained only as a compatibility alias for
`--campaign-context=skip`; new commands and scripts should use the explicit context form.

Research configuration belongs in the brief's leading YAML frontmatter. See
[Brief and file contract](brief-contract.md).

## Campaign Commands

Validate and inspect a campaign configuration without launching it:

```bash
flowcrew campaign run examples/example_campaign.yaml --dry-run
```

The example prints the resolved campaign plan and exits with `Campaign hello-research-example: dry_run`. Its launch command is intentionally a placeholder; replace the launch settings before removing `--dry-run`.

The complete subcommand set is:

```bash
flowcrew campaign run <config.yaml> [--dry-run] [--background]
flowcrew campaign status <campaignId>
flowcrew campaign stop <campaignId>
flowcrew campaign pending <campaignId>
flowcrew campaign review <campaignId>
```

`pending` lists proposed brief patches. `review` interactively accepts,
rejects, skips, or quits them; redirected standard input supplies scripted
answers one per line.

## `flowcrew campaign-loop`

```bash
flowcrew campaign-loop - --project <dir> --campaign <name> \
  [--max-directions N] [--no-scout]
flowcrew campaign-loop - --project <dir> --campaign <name> \
  < research.brief.md
```

Use a `research:` frontmatter block. The outer parser also accepts the
`objective:` alias, and spawned inner `quick` runs use the canonical parsed
research configuration for workflow selection. Unless `--no-scout` is present,
the configured literature scout may use live model and network access. This is
a long-running live command, not a rehearsal.

## `flowcrew doctor`

Checks the agent CLIs (installed and authenticated), each installed agent's FlowCrew skill
copies, `config/defaults.yaml` and the configured adapter, every `config/agents/*.yaml` and
the shared base prompt, and whether the dashboard port is already held. Agents absent from
`PATH` receive no missing-skill warning. For an installed agent, doctor checks the supported
project and global paths against the packaged source bytes, reports incomplete, changed, or
older copies, and gives the matching `skills/install.sh --<agent> --global|--project`
command.

Doctor is diagnostic-only: it reports the installed adapters, current value, recommendation,
and a pasteable `flowcrew adapter <name>` correction without creating or changing project
files. Installation commands come from the same shared constants used by runtime errors.

The port check does more than report "something is listening": when a FlowCrew dashboard
answers, it resolves the listener's pid through `/proc` and compares the serving process's
working directory against this checkout's own root. `ok` means this install's dashboard is
running; a `warn` names the other checkout serving that port (and the alternate-port
command to start this one alongside it) instead of falsely reporting success. The PATH
check likewise resolves the `flowcrew` executable with `realpath` and compares it with this
checkout's built CLI; another checkout is reported as a different install, never as `ok`.

`flowcrew doctor --repair-registry` and `--compact-registry` are documented under
[Registry maintenance](#registry-maintenance) below.

## Daemon Commands

```bash
flowcrew daemon status
flowcrew daemon restart
flowcrew daemon restart --force
flowcrew daemon start        # compatibility: only starts when no daemon is listening
flowcrew daemon stop
flowcrew daemon logs [--tail N] [--follow]
flowcrew daemon serve        # foreground/internal orchestrator service entry
flowcrew task list
flowcrew task show <id>
flowcrew task cancel <id>
```

`flowcrew start` and `flowcrew daemon serve` are deliberately different: **start is the web dashboard**;
**daemon serve is the long-lived background orchestrator** that owns `daemon.sock`. Existing `daemon start`
scripts remain compatible, but `flowcrew daemon restart` is the operator entry point for loading a new engine build.
On Linux it resolves the listener from the Unix-socket inode in `/proc`, never from a command-line pattern.
Off Linux there is no inode-to-pid map to consult, so it falls back to the pid the daemon recorded for itself
and accepts it only while that process is still alive — strictly weaker than the inode lookup, and stated
here rather than implied away.

`flowcrew daemon status` prints the listener pid, `startedAt`, socket path, startup-time SHA-256 build hash,
module count, uptime, watched-task count, and unreadable registry-record count. The startup identity is persisted
as `daemon.json` beside the configured socket (so a custom `FLOWCREW_DAEMON_SOCKET` keeps all daemon state together).
If current `dist/**/*.js` content differs from the process's loaded build, status prints
`STALE: dist is newer than the running daemon — its fixes are NOT loaded` and exits 2. Missing or conflicting
identity is `UNVERIFIED` and also exits nonzero.

Restart has a replay-safety interlock. If any task is `running` without a bound `run_id`, restart exits 3 before
stopping or signaling anything and lists `flowcrew task cancel <id>` commands. `--force` explicitly accepts that
brief-replay risk; it does not bypass unreadable registry evidence. A successful background registration names
the receiver as `Task #N registered (daemon pid=…, build=…)`. If the RPC response times out after delivery, the
outcome remains unknown—confirm both task state and receiver freshness with `flowcrew daemon status`; the timeout
does not claim the daemon was absent.

`flowcrew dashboard status [--port N]` remains a status-only command. When it proves the
loaded Dashboard is stale, it reports the validated PID and selected port in an executable
next step: `kill <pid> && PORT=<port> flowcrew start`. It does not advertise a nonexistent
`dashboard restart` command.

Additional task operations are:

```bash
flowcrew task list [--status active|all|<task-status>] [--limit N] [--with-summary]
flowcrew task show <id> [--summary-only]
flowcrew task retry <id>
flowcrew task tail <id> [--tail N] [--follow|-f]
```

`task tail` reads the run's captured output. Where a systemd user journal exists, `--follow` streams it
through `journalctl`; where it does not — macOS, or any Linux without a systemd session — it follows the
log the supervising shim captured instead. If neither is available it says so and exits, rather than
failing on a missing binary.

### Registry maintenance

```bash
flowcrew doctor --repair-registry [--apply]
flowcrew doctor --compact-registry [--apply]
```

The registry that tracks background tasks is append-only, so a process killed mid-write can
leave a torn final row. `--repair-registry` recovers what is recoverable and quarantines the
rest rather than guessing; `--compact-registry` rewrites the file down to the last record per
task, which is what `daemon status` counts.

Both are **dry-run by default**: without `--apply` they report what they would change and
exit without touching the file. `--apply` takes a backup and verifies it is readable before
the original is replaced.

## Approval Inbox

```bash
flowcrew inbox list [--state pending|resolved|all] [--run <runId>]
flowcrew inbox show <requestId> [--run <runId>]
flowcrew inbox approve <requestId> [--reason "..."] [--always] [--no-resume]
flowcrew inbox deny <requestId> [--reason "..."] [--no-resume]
flowcrew inbox rules
flowcrew inbox revoke <action> <target> [--project <dir>]
```

See [Approval inbox](approvals.md) for park/resume, first-wins resolution, and
standing-rule restrictions.

## Versioned Briefs

```bash
flowcrew brief head <briefDir>
flowcrew brief diff <briefDir> <fromVersion> <toVersion>
flowcrew brief rollback <briefDir> <version>
flowcrew brief log <briefDir>
```

Rollback makes historical content the new head and records a revision; it does
not erase version history.

## Reality Audit

```bash
flowcrew audit-reality
flowcrew audit-reality --task <id>
flowcrew audit-reality --range last-21-days
flowcrew audit-reality --output <report.md>
```

Reality audit applies deterministic checks to past runs and reports which terminal results were supported by real evidence. With `--output`, it writes and also prints the Markdown report.
