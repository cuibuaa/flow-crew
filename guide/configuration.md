# Effective configuration

For an operator: which settings change behavior, and which value wins?

## Engine defaults

Defaults, roles and workflows come from the engine package's `config/` directory.
Target-project `config/defaults.yaml`, `config/agents/` and `config/workflows/` files have
no effect. `adapter` setters update the engine's defaults; `init` creates state storage
and the project's stage-skill extension directory.

The table records the shipped engine defaults. All times are milliseconds.
Parser field names are listed exactly.

| Key | Shipped value | Effect |
|---|---:|---|
| `default_timeout_ms` | 10800000 | Base scheduled execution deadline |
| `default_stage_idle_timeout_ms` | 600000 | Minimum observed silence before watchdog abort |
| `default_validation_timeout_ms` | 2700000 | Bound for one configured validation command |
| `default_max_iterations` | 5 | Workflow iteration limit |
| `default_gate_retry_loops` | 3 | Gate repair-loop bound |
| `default_stage_technical_retries` | 1 | Technical execution retry bound; fallback ordinary retry default |
| `default_plan_stage_retries` | 2 | Re-prompts for an empty or invalid injected plan |
| `live_constraint_fallback_scan_ms` | 30000 | Portable reconciliation scan cadence |
| `live_constraint_monitor_deadline_ms` | 600000 | Maximum gap without a completed constraint scan |
| `scheduler_heartbeat_interval_ms` | 2000 | Scheduler progress publication cadence |
| `scheduler_stall_threshold_ms` | 120000 | Nonadvancing scheduler warning threshold |
| `scheduler_stall_observer_poll_ms` | 5000 | Independent observer polling cadence |
| `git_worktree_add_timeout_ms` | 1800000 | Worktree checkout command bound |
| `adapter` | `auto` | Runtime backend choice |
| `model` | `default` | Inherit adapter configuration unless pinned |
| `reasoning_effort` | `default` | Inherit adapter effort unless pinned |
| `session_reuse` | `false` | Opt into compatible cross-stage Codex UUID continuation |
| `live_constraint_exempt_patterns` | See below | Recognized generated paths exempt only while untracked |

The shipped exemptions are `**/__pycache__/**`, `**/*.pyc`, `**/.pytest_cache/**`,
`**/.mypy_cache/**`, `**/.ruff_cache/**`, `node_modules/.vite/vitest/**`, and
`**/*.tsbuildinfo`. A tracked matching path is still guarded. Unsafe or unrecognized cache
patterns refuse parsing. Idle, scan, heartbeat, observer and worktree bounds are validated
as positive finite numbers and floored to integers; do not assume every numeric setting
has that same validation.

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
configuration, then its CLI defaults. Claude reads `$CLAUDE_CONFIG_DIR/settings.json`
(or `~/.claude/settings.json`) at every invocation: `model` supplies the model, and
`modelSettings[model].effortLevel` takes precedence over `effortLevel` for the selected
model key. Model aliases are passed unchanged. Explicit model and effort pins each win
over settings; missing or invalid settings leave the corresponding CLI flag unset.
Claude keeps other user settings isolated. Its invocation transport records each passed
value and source (`role`, `user-settings`, or `cli-default`), with `null` for an omitted flag.
Both adapters keep model choice an operator policy: they do not force a cheaper model or
translate another provider's model name. Rejected model/effort parameters can be removed by
bounded native-error repair; that does not verify the suitability of the resulting model.
Session reuse can be overridden per process
by `FC_SESSION_REUSE=0` or `1`. Validation stages do not inherit an author's session.

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
Claude copies only native conversation state for an admitted resume, never OAuth credentials. Settings isolation is not OS filesystem confinement.

Source: [role parser](../src/scheduler/sched_admission/configuration.ts),
[availability](../src/adapters/availability.ts), [Codex adapter](../src/adapters/codex.ts),
[Claude adapter](../src/adapters/claude.ts), [session admission](../src/scheduler/sched_admission/sessions.ts).

## Roles and workflows

A role YAML accepts `name` and `prompt` (required), `description` (default empty),
`model` and `reasoning_effort` (default `default`), `tools` (default empty list), optional
`adapter`, and `handoff_visibility: full|minimal|none`. Visibility selects predecessor
context. Use `tools: [default]` for normal adapter execution. An empty list selects read-only
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

Static parsing preserves absent scope for compatibility. Settlement distinguishes a declared
empty scope from an unnegotiated missing declaration: the latter has an audit-only legacy
case without a live scope guard. Negotiation grants only named paths. Declare explicit scopes
in new static workflows rather than relying on that compatibility gap.
See [scope reconciliation](../src/scheduler/sched_scope/reconciliation.ts).

The shipped `default` and `research` workflows begin with a dynamic planner. `direct` supplies
a fixed author, independent read-only gate and conditional repair plan. It has broad author
scope; a dedicated workspace and the brief's constraints still matter. Brief `workflow`
selection and refusal of direct research/program loops belong to [brief contract](brief-contract.md).

Sources: [schemas](../src/scheduler/sched_admission/configuration.ts),
[workflows](../config/workflows/default.yaml), [direct](../config/workflows/direct.yaml),
[worker context](../src/worker.ts).

## Runtime environment

| Variable | Consumer and purpose |
|---|---|
| `FC_HOME` | State root; default is the user's `.fc` directory |
| `PROJECT_DIR` | Default project selection in core CLI/dashboard startup |
| `PORT` | Dashboard port, default 3000 |
| `FLOWCREW_DAEMON_SOCKET` | Explicit daemon socket routing; task/daemon socket options can override |
| `FC_SESSION_REUSE` | Literal 0/1 session-reuse override |
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
