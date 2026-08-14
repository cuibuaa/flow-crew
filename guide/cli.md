# CLI Reference

## Top-level Commands

The current `src/cli.ts` dispatcher exposes these commands:

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
| `ship-preflight` | Gather prior-run, campaign, build, and declared-input facts before shipping. |
| `ship-setup` | Create the declared launch worktree and fail closed on unreachable or invalid inputs. |
| `land` | Audit terminal artifacts and unique worktree state; optionally remove a proven-safe linked worktree. |
| `audit-report` | Re-derive supported numeric and path-bearing claims from a terminal report. |
| `watch` | Report edge-triggered stall judgements for live runs. |
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
flowcrew ship-preflight --brief docs/task_brief.md
flowcrew ship-setup --brief docs/task_brief.md --target ../task-worktree --base HEAD --branch task-work
flowcrew land --run <run-id>
flowcrew audit-report --report docs/final.md --run-dir <run-dir>
flowcrew watch --once
flowcrew brief head <briefDir>
flowcrew doctor
flowcrew clean
flowcrew export
flowcrew version
```

## `flowcrew ship-preflight`

Gather the facts needed before authoring or launching a FlowCrew handoff:

```bash
flowcrew ship-preflight
flowcrew ship-preflight --brief docs/task_brief.md --json
flowcrew ship-preflight --campaign <name> --brief docs/task_brief.md
```

Campaign resolution follows launch precedence: explicit `--campaign`, parsed
`config/defaults.yaml::campaign`, then the repository main-worktree basename. An uncertain
resolution stays unknown; preflight never substitutes another campaign's hygiene. The report
summarises readable and unreadable run entries rather than printing one error per entry.

For a requested brief, preflight distinguishes inputs from outputs and checks every declared
input for existence and readability. Mechanically bound row-count, date-span, recursive
file-count, and SHA-256 claims are reported as confirmed, refuted, or not checkable. It also
discovers the target's build, test, and lint scripts from checked-in configuration, executes
that untouched baseline, and states later gate criteria as a delta from the observed result.
The report separately records daemon→`dist` and `src`→`dist` freshness.

Exit 0 means the facts were gathered, even when history is adverse, a baseline is red, a build
is stale, or an input is missing; invalid arguments, an unreadable requested brief, or a
collection failure exit non-zero. `--json` emits the same facts as one machine-readable object.

## `flowcrew ship-setup`

Create an exact launch worktree only after the brief's inputs can be proven usable:

```bash
flowcrew ship-setup --brief <path> --target <path> --base <ref> --branch <name> [--project <path>] [--json]
```

`--brief`, `--target`, `--base`, and `--branch` are required. `--project` identifies the
source repository and defaults to the current directory. The target must not already exist.
Git receives the declared base and branch as argv, without a shell.

Setup is fail-closed in two phases. Before creating a worktree, it verifies every source input
and every bound row-count, date-span, file-count, or SHA-256 assertion. Missing, unreadable,
refuted, and not-checkable inputs refuse the command before Git runs. After Git creates the
worktree, each declared input absent from the target is linked from the source at that exact
relative path. This makes ignored inputs such as `data/` and `node_modules/` reachable without
copying or guessing sibling modules. Existing target entries are never overwritten, and the
same assertions are evaluated again through the target path.

Only a fully verified target advances to the configuration-discovered build, test, and lint
baseline. A pre-existing red check is recorded honestly with a no-new-failure delta criterion;
it is not rewritten as an impossible absolute-zero gate. A command that cannot run in the target
environment is not a red baseline: in particular, exit 127 makes the verdict line
`Ship setup: REFUSED` and leaves every affected gate unresolved. Success exits 0 and atomically
stores the JSON-ready record under the FlowCrew state root. The record stores the SHA-256 of the
exact brief bytes and its path is content-addressed by that digest together with the canonical
target, so different briefs at the conventional path cannot overwrite or impersonate one
another. Refusal exits non-zero and names every blocker. **No ready record is written** for a
partial link, a target mismatch, an unusable validation baseline, a validation launch error, or
a record-write failure; an already-created worktree may remain for diagnosis.
Every structured blocker includes `phase`, `reason`, and `repair` (plus the
offending input/assertion when available); human output prints the repair
directly beneath its refusal.

Test-population evidence has its own three-way result. Setup first prefers an exact Vitest, pytest,
or explicitly declared-file collector. If that knowledge is unavailable, it runs the source test
suite once and compares complete top-level TAP identities with the output observed from the target
test baseline. Every population record must carry a non-empty test name; ordinals alone prove only
a count. This generic fallback is not free: it uses two full suite executions (source and target),
whereas the collector path uses one target suite execution plus two cheap collections. An identity
mismatch refuses. Output that cannot establish complete named TAP parity reaches ready as
`UNVERIFIED`; human output and the ready record name the configured runner and the reason. In that
state the operator retains the executable target baseline and all its unchanged gates, but loses
the assurance that source and target test populations match. A target command that cannot launch,
including exit 127, remains a refusal regardless of population state.

## `flowcrew land`

Inspect one explicitly selected run before reclaiming its linked worktree:

```bash
flowcrew land --run <run-id>
flowcrew land --run <run-id> --json
flowcrew land --run <run-id> --remove --acknowledge-regenerable=<audited-count>
```

The audit reports the run's recorded status and every artifact declared for that status. An
artifact is present when either its project path or the scheduler's preserved run snapshot
exists. It takes an unfiltered Git census of tracked modifications and deletions, every
untracked and ignored path, and each commit after the recorded base that is absent from all
remote refs. It reports those unpushed commits, then separately identifies commits with no ref
that would survive deletion of the selected worktree branch. Grading happens only after that
complete census: proven build outputs and installed dependencies are summarized by count, while
source, data or state, symlinks, and anything not proven regenerable are named individually. A
symlink is identified as a link and includes its
exact target. A source-like file inside a build directory stays named; an inspection failure is
an issue and an enumerated unknown, never a hidden count.

Removal requires the operator to state the exact count of paths the audit proved regenerable.
An absent or mismatched count refuses before any destructive Git call. That acknowledgement is
only consent to discard that measured set; it cannot cover tracked changes, source, data or
state, symlinks, unknown items, inspection failures, or any other ungraded path. Archive, move,
commit, or otherwise account for such unique content, remove the local copy, and rerun the
audit.

Without `--remove`, inventory is read-only and unique items are reported without turning the
audit itself into a removal attempt. With `--remove`, every enumerated ungraded item remains an
unconditional non-zero refusal, while the summarized regenerable set crosses the boundary only
under an exact count acknowledgement. Before a destructive Git call, any non-terminal status,
absent declared artifact, incomplete Git inspection, at-risk commit, or ungraded inventory item
is a non-zero refusal. A commit already merged into another local branch is still reported as
unpushed but is not at risk merely because no remote contains it. A clean request still has to
prove that the target is a linked
(not primary or bare) worktree with an attached local branch. Removal uses non-force worktree
removal, pruning, and `branch -d`, stopping at the first failure.
Each refusal has a position-matched repair in `refusalRepairs`, and human output
prints it beside the reason. A failed removal step likewise records the failed
Git operation and a repair that preserves unique data and surviving refs.

`land` does not decide whether a terminal result is good or whether its evidence answers the
right question. The operator reads and independently judges the result before requesting
removal; the command enforces only the mechanical preservation boundary.

## `flowcrew audit-report`

Check a report's own arithmetic and artifact attributions against one run and its project:

```bash
flowcrew audit-report --report <path> --run-dir <path>
flowcrew audit-report --report <path> --run-dir <path> --json
```

The report itself and every named artifact must resolve within the run or project root.
Relative artifact paths are checked against both; if the same path exists in both, use
`project:<path>` or `run:<path>` to make the attribution unambiguous. Symlinks and `..` cannot
escape those roots. Validation commands are tokenized into direct argv and run in the project
without a shell; shell operators, environment-prefix assignments, launch failures, and
unparseable commands remain visible as `not_checkable`.

These sentence forms are checkable (punctuation around them is optional):

```markdown
`project:guide/cli.md`: 509 lines.
`artifacts/evidence` contains 14 files.
`project:guide/cli.md`: 20 sections.
Validation command `npm test`: exit 0; 412 passed, 0 failed.
`artifacts/result.json` field `metrics.percentile` = 97.
`run:research_round_1.json` field `/series/0/mean` = -1.25.
```

Line counts use logical text lines, recursive file counts include regular files, and section
counts include Markdown ATX headings outside fenced examples. JSON fields accept dotted paths
or JSON Pointers and must resolve to a scalar. A command claim compares its direct exit code
and every stated passed/failed/skipped/error tally. Other numeric sentences that name a path
are retained as `not_checkable` instead of being silently ignored.

Each claim is `confirmed`, `contradicted`, or `not_checkable`. Only a contradiction makes the
command exit non-zero. Confirmation proves that the report repeated the measured value
accurately; it deliberately does not prove that the chosen measurement or framing was sound.

## `flowcrew watch`

Watch all FlowCrew runs continuously, or perform one deterministic pass:

```bash
flowcrew watch
flowcrew watch --once
flowcrew watch --poll 15
```

The first pass always prints a heartbeat with entry, readable-run, live-run, and scan-time
counts. Later output is edge-triggered: an unchanged condition is silent, and ordinary stage
transitions are not reported. The heartbeat makes a quiet healthy scan distinguishable from a
watcher too slow to finish its first pass. A run counts as live only when `run.json` says `running`
and its `scheduler.pid` names a process that is alive. A known-dead scheduler suppresses live-run
stall judgements; an unreadable marker produces an evidence-gap diagnostic instead.

The watch command makes these judgements, including when already present on the first pass:

- **Terminal indecision:** a live run has a valid declared terminal contract, no recorded terminal
  artifact or completion timestamp, at least one complete/failed/skipped stage, and no running
  stage. A pending stage is quiescent here, because an unused repair stage can remain pending after
  its gate passes. The condition fires only after nine minutes without a scheduler-owned write.
  The activity clock is the newest mtime among `run.json`, existing event/progress/supervisor
  records, and existing stage status, live-log, and output files. The bounded scan does not follow
  symlinks. A fresh write, a running stage, an all-pending DAG, a terminal result, a missing
  terminal contract, a dead scheduler, or a run still within grace does not fire this condition.
- **Gate direction:** the latest two durable rejected verdicts in canonical iteration/round order
  must name the same gate, metric, numeric threshold, declared direction (when present), and
  nonzero side of that threshold. Current archives carry the numeric observation in the matching
  `metric_<gate>.json`; legacy verdict-embedded metrics remain readable. Equal absolute distance is
  a plateau; greater distance is a regression; movement toward the threshold is silent. Canonical
  iteration evidence takes precedence over legacy round-only archives. One verdict, an unscored
  rejection, a changed or missing threshold/metric/direction, a score at the threshold, or a
  threshold crossing is not called a stall.
- **Evidence gaps:** unavailable roots, unreadable run or scheduler records, malformed or
  unreadable gate archives, unjudgeable terminal clocks/contracts/stages, and incomparable latest
  gate verdicts emit `[EVIDENCE GAP]`. This means **not judged**, not healthy and not stalled.
  Diagnostics are bounded, edge-triggered, clear on recovery, and re-arm if the gap recurs.
- **Status disagreement:** when a terminal artifact unambiguously declares a status different from
  the persisted lifecycle status, the command emits `[STATUS MISMATCH]`; terminal and live runs are
  both covered.

Nine minutes rounds the independently re-derived current-contract terminal-lag tail up to the
45-second polling cadence; the final verification report records the population, full distribution,
and sensitivity strata. A future healthy run quiet beyond that historical tail will alert once even
if it later terminates normally. Attempt count is deliberately not a stall judgement: attempts three
and four can still be converging, while a plateau or regression can be visible after only two
comparable gate rounds.

`--poll` accepts 1 through 3600 seconds and defaults to 45. `--once` emits the initial heartbeat,
existing stalls, status mismatches, and evidence gaps, then exits. The command is read-only: it
**does not write run or task status**, decide whether wrap-up is complete, accept a terminal status,
or depend on an operator home-directory layout. A judgement only reports durable evidence; it never
changes that evidence.

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

`task list` and `task show` keep the persisted lifecycle status intact. When the bound run's
recorded terminal artifact maps unambiguously to a different declared terminal status, they
display that artifact status beside the lifecycle status rather than silently presenting the
contradiction as an ordinary completion.

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
