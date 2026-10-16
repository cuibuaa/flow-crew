# CLI reference

For an operator: which command and parsed options do I use?
Use `node dist/cli.js` from a built source checkout, or `flowcrew` when a command link is
installed. Below, `flowcrew` is the executable prefix. Angle-bracket values are placeholders;
synopses are syntax references, not recipes to run without selecting real identities.
[Operations](operations.md) owns lifecycle, baseline, approvals, campaigns and preservation.
[Configuration](configuration.md) owns defaults and environment routing.

## Dispatch and help

The current dispatcher has 28 named command routes, including the early `fc_tasks`,
`plan-check` and `state` paths. Bare invocation, `--help`, `-h` print top-level help;
`version`, `--version`, `-v` print package version. Unknown commands exit 1. Command help is
an abbreviated synopsis and can omit parsed options (notably state/ledger indexing and
rehearsal's actual options); the tables below follow parsers, not just help text.

| Command | Question answered |
|---|---|
| `init`, `adapter`, `doctor` | Is local configuration/runtime ready? |
| `ship-preflight`, `rehearse`, `plan-check`, `ship-setup` | What can be established before launch? |
| `quick` | Run or register a saved brief |
| `status`, `list`, `state`, `events`, `watch` | What happened or is happening? |
| `guide`, `interrupt` | Request guidance or stop an active stage command |
| `daemon`, `task`, `dashboard`, `start` | Operate the orchestrator or dashboard |
| `inbox` | Resolve a per-request approval |
| `campaign`, `brief` | Inspect grouped history and versioned brief patches |
| `fc_tasks` | Inspect/update optional conversation ledger intent |
| `audit-reality`, `land`, `export`, `clean` | Recheck, preserve, export or reclaim records |
| `version` | Which package version is this? |

`race` is removed. `quick --supervise`, `--no-supervise`, `--foreground`, `--hold-gates`
and unknown long options refuse with exit 1. `--timeout`/`--timeout=...` refuses with a
engine-default migration hint. Foreground is the absence of `--background`.
Standing approval rules are retired. Historic usage records remain readable.

Source: [dispatch/bootstrap](../src/cli.ts), [early ledger](../src/cli-fc-tasks.ts).

## Inspection and setup

| Synopsis | Parsed options and exit contract |
|---|---|
| `init` | No command-specific options. Creates global run storage and the project's stage-skill extension directory. |
| `adapter [auto\|codex\|claude]` | No argument reads engine choice/installed executables; setter writes engine defaults and refuses unavailable physical backend. |
| `doctor` | Diagnostics; exit 1 for failures, 0 also permits warnings. `--repair-registry` or `--compact-registry` select dry-run maintenance; `--apply` performs it. Conflicting maintenance selection refuses. |
| `ship-preflight` | `--json`, `--no-baseline`, `--project`, `--target`, `--campaign`, `--brief`; value options accept separate or equals syntax. Exit 0 for completed fact collection, 1 for argument/read/collection failure. No validation execution. |
| `rehearse <brief>` | `--static-only`, `--keep`, `--project`, `--target` (paths also accept equals). Exit 0 for ready even with warnings, 1 for contract/environment failure. `--json` is not a parsed output mode despite abbreviated help. |
| `plan-check <dispatch-file>` | Exactly one of `--brief <file>` or `--run <run-directory>`; `--project <path>` defaults to cwd. Reads draft and returns JSON admission facts, 0 pass / 1 refusal. Run selector here is a directory, unlike `state`. |
| `ship-setup` | Required `--brief`, `--target`, `--base`, `--branch`; optional `--project`, `--json`. Value options accept equals, duplicates refuse. Exit 0 only for ready record publication, 1 refusal. |

Doctor can inspect authentication state and the dashboard listener. Preflight may inspect
isolated daemon/build identity; neither is a model launch. Rehearsal runs real declared shell
confirmation in its disposable project unless static-only. Review it first.

Sources: [core diagnostics](../src/cli.ts), [maintenance](../src/cli-doctor.ts),
[preflight parser](../src/cli-ship-preflight.ts), [rehearse parser](../src/rehearse.ts),
[plan parser](../src/plan-interface.ts), [setup parser](../src/cli-ship-setup.ts).

## Launch

`quick <brief-path|task-text|->` accepts a path, joined positional text, `--task <text>` or
stdin `-`. Saved briefs need extractable criteria; warning acknowledgment cannot admit a
brief with no criteria. Other preflight findings are advisory and printed before project/run mutation.
Quick writes the submitted brief to `docs/task_brief.md`
in the selected project and warns before replacing different content.

| Option | Meaning |
|---|---|
| `--project <path>` | Select launch project |
| `--adapter <name>` | Override backend; registered auto/codex/claude/mock routing |
| `--workflow <name>` | Explicit workflow file name |
| `--max-iterations <n>` | Run iteration override |
| `--campaign <name>`, `--no-campaign` | Campaign selection/opt-out |
| `--campaign-context=inherit\|skip` | Context policy; equals form required |
| `--no-inherit-campaign` | Compatibility alias for skip |
| `--background` | Register with daemon; daemon must be available |
| `--acknowledge-brief-warnings[=<digest>]` | Confirm changed-run continuation; an optional exact digest checks input identity |
| `--task <text>`, `-` | Alternate input transport |
| `--existing-run-id <id>` | Existing-run continuation; reads saved run brief absent exact transported input |

Internal launch transport also parses `--brief-input-base64 <base64url>` and
`--brief-admission-record <record>`. They bind engine-transferred exact bytes and admission;
use the ordinary file/stdin route in operator scripts. Help omits these internal fields.
Do not use shell command substitution to transport saved brief bytes: it strips trailing
newlines. Quick has multiple refusal/settlement paths; zero means the process succeeded,
not that a research metric won. Inspect final lifecycle and evidence.

Source: [quick parser/admission/launch](../src/cli.ts), [adapter registry](../src/adapters/loader.ts).

## Read and steer

| Synopsis | Parsed options |
|---|---|
| `status` | `--all` or `--project <path>`/`--project=<path>`, `--details`; ambiguous selection refuses |
| `list` | `--limit N`, default 10; recent global runs |
| `state` | Required `--project <path>`, `--run <id>`; `--summary`, `--prompts`; JSON, 0 read / 1 error |
| `events` | `--run`, `--project`, `--stage`, `--type <comma-list>`, `--limit` (1–10000, default 100), `--json`, `--follow`/`-f`, `--include-maintenance`; value options accept equals |
| `watch` | `--once`, `--all`, `--poll <seconds>`/equals; positive seconds within the Node timer limit (2147483.647), default 45; 1 for invalid arguments, alerts alone do not mean command failure |
| `guide "message"` | Optional `--run <id>`, `--stage <id>`; omission of run requires exactly one running candidate; 1 for invalid/ambiguous targets |
| `interrupt ["reason"]` | Required `--run <id>`, `--stage <id>`; exactly one active bound command; omitted reason uses an action description; 1 refusal |

Source: [core status/steering](../src/cli.ts), [state](../src/run-state-access.ts),
[events](../src/cli-events.ts), [watch](../src/cli-watch.ts).

## Services and tasks

| Synopsis | Options and outcomes |
|---|---|
| `start` | Starts dashboard only. `PORT` and `PROJECT_DIR` select listener/project. It can build missing UI; occupied port refuses before that write. Long-running process. |
| `dashboard status` | `--port N`, otherwise PORT/3000. Exit 0 verified fresh; 1 unreachable/invalid arguments; 2 stale or unverified response. |
| `daemon start\|serve\|stop\|restart\|status\|logs` | `--port` or `--socket` selects socket path (port is a compatibility spelling). Start/restart accept `--force`; logs `--tail N` (default 100), `--follow`. Serve is the resident internal process. |
| `daemon hold` | Fence launches and wait for settled stage groups; `--timeout-ms N` (default 60000). Timeout leaves the hold active and returns failure. |
| `daemon hold-status` | Report the durable deployment hold and each registered unit/scheduler's settlement; exit 0 only when ready. |
| `daemon continue` | Validate held runs, release the deployment fence, and continue compatible runs through the queue. Per-run incompatibility returns failure and remains visible. See [deployment procedure](operations.md#deploy-while-tasks-are-in-flight). |
| `task list` | `--status active\|all\|<task-status>`, `--limit N`, `--with-summary` |
| `task show <numeric-id>` | `--summary-only`, `--raw` for tick JSON |
| `task cancel <numeric-id>` | Record cancellation and attempt owned worker cleanup; an active run becomes `stopped` |
| `task resume <numeric-id>` | Explicitly continue compatible stopped (including cancelled), failed or incomplete work after settlement checks, preserving completed stages, history, plan and budget. |
| `task retry <numeric-id>` | Request another launch attempt; a settled terminal run starts fresh, discarding its continuation state |
| `task tail <numeric-id>` | `--tail N` (default 100), `--follow`/`-f` |

Open the dashboard at `http://localhost:<PORT>/`; [configuration](configuration.md#runtime-environment)
owns the default listener port.

Task commands also parse socket `--port`/`--socket`. Daemon status returns 0 for verified
fresh, 1 when no listener, 2 for stale/unverified/nonresponsive evidence; read the diagnosis.
Restart force can accept active-task replay risk but cannot bypass registry corruption.
These commands can control other work; use them only for an intentionally selected service.
Resume resolves the saved run and project from the task ID. The dashboard offers the
same Resume control beside Cancel. A completed nonpassing gate in an incomplete run
is retried in the next remaining iteration; exhausted iteration budget is an error.
Legacy stopped and failed work continues its current iteration. CLI output exits quietly
when a pipe reader closes early. Restart, recovery and automatic retry never resume
a stopped run. Retry remains distinct: before a run settles it requests another launch;
after terminal settlement it starts a new run instead of continuing the previous one.
Parked approval requests continue through `inbox approve` or `inbox deny`.

Sources: [daemon](../src/cli-daemon.ts), [task](../src/cli-task.ts),
[dashboard identity](../src/cli-dashboard.ts), [dashboard startup](../src/cli.ts).

## Approval and campaign controls

| Synopsis | Options |
|---|---|
| `inbox list` | `--state pending\|resolved\|all`, `--run <id>` |
| `inbox show <request-id>` | Optional `--run` to disambiguate |
| `inbox approve\|deny <request-id>` | `--run`, `--reason <text>`, `--no-resume`; 0 winning resolution, 2 lost first-responder race, 1 failure |
| `campaign status\|pending\|review <campaign-id>` | No command-specific flags; review reads accept/reject/skip/quit interactively or one answer per stdin line |
| `brief head\|log <brief-directory>` | Inspect current version or revision log |
| `brief diff <brief-directory> <from> <to>` | Inspect version difference |
| `brief rollback <brief-directory> <version>` | Author a rollback revision |

`inbox --always`, `rules`, `revoke` refuse. Decisions can relaunch work unless no-resume.
Only explicit external authority requests wait for a human. Legacy local or ambiguous
requests receive engine decisions without parking; resolved history includes those answers.
An approval cannot override engine ownership or admitted scope guards.
Campaign review/brief rollback change versioned state; review a patch before accepting it.

Sources: [inbox parser](../src/cli-inbox.ts), [campaign/brief dispatch](../src/cli.ts).

## Audit, export and cleanup

| Synopsis | Options and boundary |
|---|---|
| `audit-reality` | `--task <numeric-id>`, `--range last-21-days`, `--output <path>`; executes recorded deterministic checks and prints Markdown. Exit 0 for completed audit, including failed/unverifiable rows. |
| `land` | Required `--run`; `--json`; `--remove`, `--acknowledge-regenerable=<count>`; optional closure pair `--complete-fc-task`, `--fc-task-session`, `--fc-tasks-root`. Value options also accept separate syntax. Audit/removal outcomes can refuse nonzero; read reasons. |
| `export [run-id]` | Writes a JSON bundle to the current directory, default latest global run |
| `clean` | `--keep N`, default 5; removes selected old readable runs and expired reservations, skipping verified live schedulers; zero keeps no recent readable runs |

These are execution or deletion authority, not passive status commands. Detailed preservation
requirements are in [operations](operations.md#preserve-and-reclaim).

Sources: [audit](../src/reality-gate/audit-reality.ts), [landing](../src/cli-land.ts),
[export/clean](../src/cli.ts).

## Optional ledger

`fc_tasks render|list|reconcile|create|update` uses a separate validating parser.
[Ledger reference](fc_tasks.md) owns its complete option and record grammar. It does not
install frontend configuration or implicitly close human wrap-up because a run ended.
