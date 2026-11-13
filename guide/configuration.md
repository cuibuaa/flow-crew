# Effective configuration

For an operator: which settings change behavior, and which value wins?

## Project validation

`config/validation.json` belongs to the target project. It declares commands and
structured reporters, independently of engine defaults. It uses the brief's
`{commands: {build|test|lint: {command, args, report?}}}` schema. Overlapping brief declarations must agree with
the project's argv and reporter. If neither project nor brief declares commands, the author reads the repository
and includes the fixed command-selection schema in its existing result. Invalid or empty selection remains unmeasured;
there is no filename/script/lockfile discovery fallback. Dependency preparation belongs in the
selected executable/argv. Invalid explicit configuration refuses selection before execution.
See [validation evidence](agent-protocol.md) for report bounds and result interpretation.

## Engine defaults

Defaults, roles and workflows come from the engine package's `config/` directory.
Target-project `config/defaults.yaml`, `config/agents/` and `config/workflows/` files have
no effect. `adapter` setters update the engine's defaults; `init` creates state storage
and the project's stage-skill extension directory.

The table records the shipped engine defaults. All times are milliseconds.
Parser field names are listed exactly.

| Key | Shipped value | Effect |
|---|---:|---|
| `stage_idle_timeout_ms` | 600000 | Minimum observed silence before watchdog abort |
| `validation_attempts` | 3 | Executions of an unfinished validation batch; the project's `config/validation.json` or a brief's `validation.attempts` replaces it (brief first) |
| `validation_concurrency` | 1 | Distinct trees validated at once across daemon scheduler processes; engine-owned, not a brief field |
| `validation_priority` | 19 | Unix niceness adjustment of validation commands; engine-owned, not a brief field |
| `max_iterations` | 5 | Workflow iteration limit; also bounds unfinished slices unless the brief declares `max_continuations` |
| `gate_retry_loops` | 3 | Gate repair-loop bound |
| `stage_technical_retries` | 1 | Technical execution retry bound; fallback ordinary retry default |
| `plan_stage_retries` | 2 | Re-prompts for an empty or invalid injected plan |
| `scheduler_heartbeat_interval_ms` | 2000 | Scheduler progress publication cadence |
| `scheduler_stall_threshold_ms` | 120000 | Nonadvancing scheduler warning threshold |
| `scheduler_stall_observer_poll_ms` | 5000 | Independent observer polling cadence |
| `adapter` | `auto` | Runtime backend choice |
| `model` | `default` | Inherit adapter configuration unless pinned |
| `reasoning_effort` | `default` | Inherit adapter effort unless pinned |
| `session_reuse` | `false` | Legacy configuration field; managed stages always start fresh |

Git ignore rules own ordinary disposable-output inventory. Tracked files and task-frozen
evidence retain content protection regardless of spelling. Idle, heartbeat, observer and
worktree bounds are validated as positive finite numbers and floored to integers.

`supervisor.*` has no effective runtime setting. Stage/workflow timeout and resource metadata is ignored; set the engine deadline
and provision capacity outside the engine.

Launch and `plan-check` use the engine's `config/agents` and `config/workflows` locations.
Stage skills remain project extensions loaded from fixed `config/skills`; they do not
select engine defaults, roles or workflows. A brief can select task-specific
[evidence authoring policies](brief-contract.md#evidence-authoring-policy).

Source: [defaults parser](../src/config.ts), [engine defaults](../config/defaults.yaml),
[launch](../src/cli.ts), [plan-check](../src/plan-interface.ts).

## Precedence and adapters

A quick adapter flag wins over the engine's `adapter`. A role's explicit `adapter` selects its
backend; omission inherits the run adapter. `adapter: default` is not an inheritance
sentinel. `auto` selects the only installed CLI or Codex when both are installed, without
writing that runtime resolution back. `mock` is a registered test adapter; `scripted` is used internally by rehearsal.

Role `model` and `reasoning_effort` pins win over engine defaults; missing or `default` role
values resolve to engine defaults. For Codex, remaining `default` values inherit its global
configuration, then its CLI defaults. Claude reads the machine-local
`~/.config/flowcrew/claude.json` (for example, `{"model":"<id>"}`) and
`$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json`) at every invocation.
The local model wins over settings `model`, below an explicit role/engine model pin;
missing, invalid or `default` local values fall through to settings.
`modelSettings[model].effortLevel` takes precedence over `effortLevel` for the selected
model key. Model aliases are passed unchanged. Explicit model and effort pins each win
over inherited settings; absent valid inherited values leave the corresponding CLI flag unset.
Claude keeps other user settings isolated. Its invocation transport records each passed
value and source (`role`, `local-default`, `user-settings`, or `cli-default`), with `null` for an omitted flag.
Both adapters keep model choice an operator policy: they do not force a cheaper model or
translate another provider's model name. Rejected model/effort parameters can be removed by
bounded native-error repair; that does not verify the suitability of the resulting model.
Managed stages, retries and continuations start fresh. Retained context comes from the
evidence ledger and current diff, with the exact same-stage predecessor record when available.
Legacy session-reuse settings do not select a provider conversation.

`--max-iterations` wins over engine/workflow launch defaults. Campaign selection and context
precedence belong to [operations](operations.md#campaigns). A stage deadline is immutable
once execution starts; [architecture](architecture.md#deadlines-and-idle-progress) owns
its watchdog and termination semantics. Neither adapter adds an arbitrary native turn or
spend cap; stage adequacy and those budgets remain shared engine/operator policy.

The worker keeps the brief in the ordinary stage's system prefix; planner prior guidance
can precede it. Claude retains the native default system prompt and appends the role prefix
from a file. It does not enable the dynamic system-section cache option without measured
benefit on the same workload.

Claude disables ambient customizations, user/project/local settings and MCP servers for
stage execution, and removes nested-CLI launch markers. Authentication, provider variables and
HOME remain owned by the CLI. CLAUDE_CONFIG_DIR points to the stage's private session
home; CLAUDE_SECURESTORAGE_CONFIG_DIR retains the operator-selected credential source.
The standalone adapter's explicit resume API copies only native conversation state, never OAuth credentials;
managed execution does not use that API. Settings isolation is not OS filesystem confinement.

Source: [role parser](../src/scheduler/sched_admission/configuration.ts),
[availability](../src/adapters/availability.ts), [Codex adapter](../src/adapters/codex.ts),
[Claude adapter](../src/adapters/claude.ts), [session admission](../src/scheduler/sched_admission/sessions.ts).

## Roles and workflows

A role YAML accepts `name` and `prompt` (required), `description` (default empty),
`model` and `reasoning_effort` (default `default`), `tools` (default empty list), optional
`adapter`, and `handoff_visibility: full|minimal|none`. All visibility values use the
structured ledger and diff; none grants transcript access. Use `tools: [default]` for normal adapter execution. An empty list selects read-only
inspection: Codex's native read-only sandbox, or Claude's restricted Read/Glob/Grep tools
in plan mode with permission prompts denied. These Claude arguments are covered by local
transport fixtures; no live-provider confinement proof is claimed. Any nonempty list selects
normal execution for both adapters; individual names are not forwarded as an allow-list.
The role registry supplies the planner's available role names. Raw role loading and base prompt
loading both inject the shared review acceptance and run-directory safety contract.

Illustrative role template:

```yaml
name: reviewer
description: Inspect the admitted criteria.
model: default
reasoning_effort: default
tools: [default]
handoff_visibility: minimal
prompt: Review the work and return evidence for every assigned criterion.
```

A workflow YAML requires `name` and a nonempty `stages` list. `description` is optional.
`defaults` accepts `max_retries` and `max_iterations`. A fixed nonempty `dispatch` requires
a `dynamic_dispatch` stage: it replaces the planner call with a fixed answer, still admitted
through the same boundary. Static stages use the fields in the stage schema, including
optional ordinary `max_retries`; stage wins over workflow, then the engine technical retry
default. Dynamic dispatch does not control retry policy: recorded `max_retries` is stripped.

Static parsing preserves absent scope for compatibility. Scope entries are planning and
reporting estimates; neither missing nor empty estimates prohibit project writes. Authors
sharing a mutable project tree wait for the active author to settle. Settlement protects
task-declared immutable evidence, with exact task outputs taking precedence.
See [scope reconciliation](../src/scheduler/sched_scope/reconciliation.ts).

A brief declaring `research.protocol: research-instrument/v1` constructs its author and optional declared project reviewer directly. The frozen project instrument owns verdicts and final report content.
Engineering briefs enter `entry.yaml`; its chooser selects a fixed author/review/repair shape or
releases the dynamic planner. The parsed declaration alone decides research versus engineering. The fixed author's result routes
through a read-only assessment to focused or full independent review. Full review remains available.
Historical workflow files remain readable for admitted runs and library fixtures.

Any stage can declare `decision: {successors: [next_stage, replan], default: next_stage}`.
A decision returns one JSON object with `successor` and `reason`; review decisions also return
closed risk-area objects and the engineering chooser returns `assumptions`.
The default must belong to the declared set. `continue` releases ordinary dependencies; `replan`
reruns planning at an idle boundary in the same iteration. Invalid ordinary outputs take the
declared default and record why; invalid chooser outputs fail their attempt and use the existing retry. Outside-set
choices are refused and recorded. Declared paths remain subject to full plan, scope, result-duty
and finite-budget admission. Replanning cannot change executed duties or discard result obligations.
Gate verdicts and historical repair edges translate to these same bounded successor transitions.
Unstarted descendants of an unchosen alternative are skipped. A dependency join covering all
alternatives (including their descendant stages) waits for the selected work; it cannot hide an
unfinished selected result. Revision acceptance consumes its pending replan in the same durable
transaction, so recovery does not spend another revision or plan attempt.

Sources: [schemas](../src/scheduler/sched_admission/configuration.ts),
[workflows](../config/workflows/planner.yaml), [direct](../config/workflows/direct.yaml),
[worker context](../src/worker.ts).

## Runtime environment

| Variable | Consumer and purpose |
|---|---|
| `FC_HOME` | State root; default is the user's `.fc` directory. Daemon socket defaults to `<FC_HOME>/daemon.sock`; `--socket` selects an explicit endpoint |
| `PROJECT_DIR` | Default project selection in core CLI/dashboard startup |
| `PORT` | Dashboard port, default 3000 |
| `FLOWCREW_DAEMON_SOCKET` | Ignored; select a private state root with `FC_HOME` or an explicit endpoint with `--socket` |
| `FC_SESSION_REUSE` | Legacy literal 0/1 setting; managed execution always starts fresh |
| `FC_TASKS_ROOT`, `CODEX_THREAD_ID` | Optional ledger selection; see [ledger](fc_tasks.md) |
| `MOCK_FIXTURE_DIR` | Mock fixture input directory |
| `CODEX_HOME` | Source adapter configuration/home location |
| `CODEX_PLUGINS_CACHE`, `CODEX_SKILLS_CACHE` | Codex adapter cache sources |
| `FLOWCREW_DOCTOR_SKILL_ROOT` | Doctor's skill-package inspection root |
| `TMPDIR`, `TMP`, `TEMP` | Platform temporary-directory selection used by Node/tooling |
| `FLOWCREW_NODE`, `FLOWCREW_CODEX_VERIFY_TIMEOUT_MS` | Skill installer's Node executable and enumeration timeout |

Source: [store](../src/store.ts), [RPC routing](../src/orchestrator-rpc.ts),
[CLI](../src/cli.ts), [installer](../skills/install.sh). This table covers operator-facing
routing and test-adapter inputs, not private handshake variables between engine processes.
