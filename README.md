<p align="center">
  <img src="assets/flowcrew_mascot.svg" width="260" alt="FlowCrew crew mascot" />
</p>

# FlowCrew

<p align="center"><strong>Give it a brief. Walk away. Come back to a result it has already proven — or an honest "it didn't work."</strong></p>
<p align="center"><em>Long-running AI work — research, RL, refactors, whole features — that ships only what survives its own gates.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg" alt="Node >= 22.5" />
  <img src="https://img.shields.io/badge/default_backend-Codex-111827.svg" alt="Codex default backend" />
</p>

```text
> Beat the current model on val accuracy. Ship only a result that re-confirms
> on a fresh split.
> /ship
```

`/ship` in Claude Code; `$ship` in Codex.

**Most AI agents are eager to tell you they succeeded. FlowCrew is built to catch itself when it didn't.**

Hand it a task brief and it runs as a supervised crew — planner, coder, researcher, reviewer, QA, supervisor — that plans, executes, retries, and checks its own work for hours, unattended.

Self-checking is designed into every step, not bolted on at the end — and an *independent*
re-check, not the crew, decides whether a result may be called **shipped**.

## Will this run on your machine?

- **Linux or macOS.** Both are covered by CI on every commit. WSL2 with systemd enabled
  behaves as Linux and gets the full experience.

  | | Background tasks | Process identity |
  |---|---|---|
  | **Linux + systemd user session** | supervised units, restart on crash | full — a recorded pid is bound to that process's start time, so a recycled pid can never be mistaken for it |
  | **Linux without a systemd session** | detached process fallback | full — same as above, `/proc` is what provides it |
  | **macOS** | detached process fallback | reduced — see below |

  macOS identifies processes slightly more loosely than Linux — see
  [Known issues](#known-issues). Everything else works the same.
- **Node.js 22.5+** — FlowCrew uses the built-in `node:sqlite`.
- **An authenticated Codex CLI or Claude Code** — for live runs only. The zero-token
  rehearsal in [Get started](#get-started) needs neither, and is the recommended way to
  try FlowCrew before installing anything else.
- **A live run gets unattended shell access to the target project**, for hours — see the
  warning under [Before you start](#before-you-start).

**You probably don't need FlowCrew** if you want one agent to do one bounded task — use
Codex or Claude Code directly. The gates, supervisor and retry loops only pay for
themselves once the work runs longer than you are willing to sit and watch it.

### Before you start

- **One task per project at a time.** Queue as many as you like — the daemon holds the rest and starts the next when the current one reaches a terminal state. The guard is per project, so tasks in different projects do run concurrently.

> [!WARNING]
> **Live runs receive unattended shell access.** The Codex and Claude adapters bypass their normal approval, permission, and sandbox prompts. Starting a live run — from the `ship` skill, from the Dashboard, or with `flowcrew quick` — can therefore give an agent full shell access to the selected project for hours. Use a dedicated workspace or suitably isolated Linux container, and review the task before launch.
>
> Every launch path first prints the same static brief preflight used by `rehearse`. Consequential findings require the explicit `--acknowledge-brief-warnings` choice; the flag never skips or hides inspection. After admission, `quick` writes the submitted text to `<projectDir>/docs/task_brief.md`, replacing different content only after warning. Start with `flowcrew rehearse`: it launches no agent process or model, spends no tokens, and does not modify your project; an in-process scripted adapter exercises the scheduler in isolated temporary directories.

## Get started

**The way in is the `ship` skill from your coding agent** — `/ship` in Claude Code, `$ship` in
Codex. It interviews you, turns the discussion into a brief, and rehearses that brief before
anything runs. That matters more than it sounds: a run's outcome is decided mostly by its
brief, and the skill carries the accumulated rules for writing one (see the
[brief contract](guide/brief-contract.md)). The CLI is how you then watch, steer and verify.

### 1. Clone, install, and expose the local CLI

```bash
git clone https://github.com/cuibuaa/flow-crew.git && cd flow-crew
npm install
npm link
flowcrew doctor
```

`npm install` builds both the TypeScript engine (`dist/`) and React dashboard (`ui/dist/`). `npm link` makes this clone's `flowcrew` command available on your `PATH` — note that if you already have a global `flowcrew` from another checkout, this silently repoints it at this one, and nothing warns you — check with `which flowcrew`. Doctor reports every missing build, CLI, login, or environment item clearly, and when a dashboard already holds the port it names which install that dashboard belongs to; address its attention items before a live run.

### 2. Install the coding-agent skills

```bash
./skills/install.sh
```

The installer checks which requested CLIs are actually on `PATH`; an absent agent is
explicitly skipped and never reported as installed. Install one with
`npm i -g @openai/codex` or `npm i -g @anthropic-ai/claude-code`, then rerun the command.
Claude Code receives `/ship` and `/fc-status` under `~/.claude/commands/`. Codex receives
enumerable skills under `~/.agents/skills/`; use `$ship`/`$fc-status` or select them from
`/skills`. Codex installation succeeds only after its own no-token `skills/list` API sees
both skills. `flowcrew doctor` reports missing or outdated copies and prints the exact
installer command to repair them.

### 3. Run the safe, zero-token first task

```bash
flowcrew rehearse examples/hello-research.brief.md
```

The report ends with a contract-ready verdict. That means the brief's YAML frontmatter, research-loop policy, scheduler lifecycle, terminal artifacts, and confirmation wiring survived a real scheduler rehearsal. It does **not** claim that any research result is correct: rehearsal launches no agent process or model, uses an in-process scripted adapter, and creates its Git repository with isolated temporary HOME, config, hooks, and templates. If setup still fails, the report gives a plain explanation plus a pasteable static-only command instead of a Node stack trace. See the [rehearsal reference](guide/rehearse.md) and [`examples/README.md`](examples/README.md) for the campaign dry-run and an isolated mock-adapter loop.

### 4. Ship from your coding agent

Shape the task in the conversation, then invoke `/ship` in **Claude Code** or `$ship` in
**Codex**:

```text
> Split auth into token validation and session management.
> Keep the public API compatible and add focused regression tests.
> /ship        # Claude Code; use $ship in Codex
```

FlowCrew turns the confirmed discussion into a brief, runs the crew, and reports back — while you watch the dashboard or walk away.

### Run it your way — Codex, Claude, or both

FlowCrew runs end to end on **Codex or Claude** — either works on its own.

**We recommend: plan in Claude Code, execute in Codex.** Long multi-agent sub-runs are token-hungry, and Claude subscription budgets deplete faster than Codex's — so shape the plan where the conversation flows best (Claude Code), then hand the heavy execution to Codex (the default backend).

Prefer one tool? Run the whole loop on **Codex** (the default) — or entirely in **Claude Code**. The split is a token-budget optimization, not a requirement.

## You bring the problem. It brings the rigor.

Point FlowCrew at an open-ended goal — *"find an edge in this data," "make this 10× faster," "implement this to spec"* — and its planner decomposes the work, chooses the checks, and drives it to a trustworthy conclusion, unattended for hours. **You don't wire the gates — the engine does.**

The real risk in long autonomous work isn't a wrong answer; it's a *confident* wrong one. So honesty is built into the engine, not left to how closely you're watching:

- **Verify-before-trust.** Before the engine calls a run **shipped**, it re-confirms the win with an *independent* check it set up itself. Beat the metric but fail the re-check? Downgraded, not shipped.
- **Honest by construction.** "Found nothing" (**ceiling**), "ran out of budget mid-search" (**incomplete**), and "it worked" (**shipped**) are distinct, first-class outcomes — never a crash dressed up as a win, never faked progress.
- **Self-remediation.** Flaky planning retries instead of dying; an insufficient deliverable gets sent back for rework; a stalled stage is detected and aborted. It gets itself unstuck.
- **Research *and* engineering.** The same engine chases a **metric** (beat a baseline) or satisfies a **contract** (pass the tests) — the planner composes both from the same primitives.

### One loop, from research to engineering

You give the goal; it does the rest. A sense of what that looks like across the spectrum:

| Point it at… | Kind | What comes back |
|---|---|---|
| Find an edge in a dataset or strategy | research | a real, re-confirmed win — or an honest *"the frontier is exhausted"* |
| Train an agent to beat a baseline | research | a verified beat, or an honest ceiling — never a fake one |
| Make a hot path faster | engineering | a shipped speedup, gated on byte-identical outputs |
| Implement a module to a spec | engineering | a shipped implementation, gated on the full test suite |
| Synthesize cited research | engineering | a report where every claim's source is re-fetched and quoted verbatim |
| Refactor without changing behavior | engineering | a shipped refactor, gated on behavior-pinning tests |

### From brief to verified run

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/how_it_works_dark.png" />
    <img src="assets/how_it_works.png" width="620" alt="FlowCrew execution flow: a brief from the ship skill goes to the planner, which dispatches coder stages; their output meets a QA gate that either sends a bounded fix round back or passes the work to the Reality-Gate, which decides between shipped/complete and reality_gate_failed. A supervisor watches progress and can trigger a re-plan on regression, plateau or repeated failure." />
  </picture>
</p>

The important boundary: the supervisor **steers** but never edits files or runs commands. Work
happens in worker stages; evidence is checked by gates, Reality-Gate, and — before any
`shipped` — the confirm-gate.

## What you can run

Three shapes of work, all entered the same way: describe it in your coding agent, then
invoke its `ship` skill (`/ship` in Claude Code, `$ship` in Codex). The skill interviews
you, writes the brief, rehearses it, and launches. Each example below uses Claude Code's
`/ship` spelling and shows **what you say** — and the contract the skill writes from it, because
that contract is what the engine actually enforces.

### Research loop (metric) — beat a baseline, honestly

```text
> Beat our current docs-search relevance baseline. Only ship a result that
> re-confirms on a fresh split — an honest ceiling is a fine answer.
> /ship
```

Research settings live in the brief's leading YAML frontmatter, and nowhere else. The
contract the skill writes starts with the form the engine parses:

```yaml
---
research:
  baseline: 0
  policy: greedy_stack
  result_file: docs/hello-research/round_result.json
  confirm:
    command: |
      test "$(git ls-files '*.ts' | wc -l)" -ge 1
  stop:
    beat: 1
    max_rounds: 3
---
```

`examples/hello-research.brief.md` is exactly this shape, complete with a result schema and
terminal paths. Replay it against the real scheduler for free — no agent, no tokens, about
a second — with `flowcrew rehearse examples/hello-research.brief.md`.

### Engineering (acceptance) — satisfy a contract

```text
> Add a public test proving `flowcrew --help` lists every top-level command.
> Don't change any command's behavior.
> /ship
```

The same engine-owned decision and confirm gate carry engineering work. The engine parses
`objective:` and `research:` identically — on engineering work `objective:` says what you
mean. The contract belongs in the brief's frontmatter, never buried in the task prose:

````markdown
---
objective:
  baseline: 0
  policy: replace_if_better
  result_file: artifacts/acceptance/round_result.json
  report_dir: artifacts/acceptance
  result_schema:
    type: object
    required: [label, result]
    properties:
      label: {type: string}
      result: {type: number}
  confirm:
    command: npm run build && npm test
    requires: The engine build and complete test suite must pass.
  stop:
    beat: 1
    max_rounds: 3
---
# Add a CLI help regression test

Add a public test proving that `flowcrew --help` lists every top-level command.
Do not change command behavior. After measuring the acceptance checks, write
`{"label":"cli-help-contract","result":1}` to
`artifacts/acceptance/round_result.json` only when every check passes; otherwise
write a result below 1.
````

### Unknown bug hunt

```text
> Find the root cause of the intermittent checkout failure. Add a reproducer
> that fails before the fix, then make it pass 50× consecutively. Don't
> re-try a hypothesis this campaign already marked a dead end.
> /ship
```

That last sentence is not a hint. The campaign's dead ends are handed to the planner as
facts, so a direction disproved in an earlier run is one it is told not to propose again.

See [Brief and file contract](guide/brief-contract.md) for every frontmatter and runtime
artifact field, and [`examples/README.md`](examples/README.md) for the runnable tracked
example and the zero-token flows around it. Launching any of these from the command line
instead — for a brief you already have, or for scripted and scheduled runs — is in the
[CLI reference](guide/cli.md).

## What makes it work

### A crew of roles, and one authority withheld

A run is carried out by specialists — a planner, a coder, a researcher, a reviewer, a QA gate —
each seeing only the context its own job needs. That much is ordinary.

What is not: **the planner emits a stage graph the scheduler executes literally**, written in a
fixed vocabulary the engine validates, so a role it invents is rejected rather than guessed at.
A **supervisor** watches the run rather than the task — it samples progress, sends insufficient
work back, ends a stage that has gone quiet, and can force a re-plan — but it never decides
that the work is done.

That last authority is withheld on purpose. **The same population of models writes the work,
measures the work, and judges the measurement**, so a natural-language opinion that the bar was
met is not independent evidence. What ends a run successfully is the **Reality Gate**: the
checks the work declared for itself, executed as scripts. Only success is gated — a failure
needs no proving. The crew can raise this bar on itself, because the planner may add checks for
constraints it derives from the goal. Nothing in the crew can lower it.

The [architecture guide](guide/architecture.md) has the grammar, the anti-tampering rules and
the scope machinery in full.

### Every hand-off is a checkable artifact, not a message

Agents in FlowCrew never pass each other free-form prose. Every hand-off — the plan, the work,
a verdict, a scope request, an approval — is a typed artifact at a known path in the run
directory, with one producer and one consumer, and a malformed one is refused rather than
interpreted. The [brief contract](guide/brief-contract.md) lists them.

Two consequences are worth knowing before you run anything. A stage that writes outside its
declared paths has those files **restored to their pre-stage contents** — so do not hand-edit
the project while a run is working in it, because attribution is a snapshot diff and cannot
tell your edit from the stage's. And because every hand-off is a file rather than a
conversation, the whole lifecycle can be driven by a scripted stand-in instead of a model:
that is what makes `flowcrew rehearse` possible — the *real* scheduler, a fake agent, no
tokens, about a second.

### Knowing when to stop is a rule, not a judgement call

In research mode the crew proposes and measures, but whether a result is kept, and whether to
continue, ship, or declare a ceiling, is computed from the history of results by a fixed
policy — and that policy, not the supervisor, owns the ending. A round counts as an improvement
only if it beats the running best by more than the measurement's own uncertainty, so noise
cannot be banked as progress.

### When this is the wrong tool

<details>
<summary><strong>Compared with scripted / in-session orchestration</strong></summary>

(e.g. a Claude Code <em>Workflow</em> — a script that fans work out to subagents, authored and
conducted from your session)

| Scripted / in-session orchestration | FlowCrew |
|---|---|
| A single fan-out you conduct — chain more rounds by hand | A self-governing loop: hours to days, cross-session, resumable |
| You author the control flow (the stage DAG) | The planner generates the stage DAG from a plain-language brief |
| **You** hold terminal authority — read each result, decide what's next | The **engine** self-governs done / ship / ceiling / rework |
| Verification is whatever you script in | Verify-before-trust + Reality-Gate are built in |
| Results return to you; no cross-run memory | Persistent run memory + campaign knowledge graph |
| Best for a bounded fan-out you drive now | Best for fire-and-forget autonomous research/engineering |

They are complementary. Reach for a Workflow to reason inside a conversation; reach for
FlowCrew when the work must outlive the chat and something has to decide, honestly, when it
is genuinely done.

</details>

## Run memory

FlowCrew records *why* a run made decisions, not just what changed. A run captures goals, approaches, findings, insights, results, cited sources, and dead ends as a knowledge graph, and the engine reads it back: a dead end marked in one round is one the planner is told not to re-propose in the next.

Across a campaign those graphs roll up into a **knowledge digest** — findings and insights in one list, disproved approaches in another, deduped across runs by substance so the same finding reported three times collapses to one entry, each linking back to the run that produced it. Alongside it the campaign page names the best measurement per direction, and says plainly when the evidence is not enough to name one.

<p align="center">
  <img src="assets/screenshot_knowledge_digest.png" width="800" alt="Campaign knowledge digest on the campaign page: nine accepted nDCG measurements ending in ceiling_hit with the best at 0.815, seven key findings and two disproved approaches, each linking back to the run that produced it" />
</p>

The digest above is the campaign-level rollup, and it deliberately shows only what a person
scanning a campaign needs. The full graph is per run, on that run's page. These are its node
types — and, because a record nothing reads is just clutter, what actually consumes each one:

| Type | Recorded when | What reads it back |
|---|---|---|
| `goal` | the objective a run is pursuing | summarised into every later stage's prompt |
| `approach` | a strategy the planner chose | same, carrying its score; retired to a dead end when the campaign stops improving |
| `result` | a measured outcome | plateau detection and the improvement ratchet |
| `dead_end` | a direction that failed | the planner, as a direction not to propose again — plus the campaign digest |
| `user_hint` | guidance you gave mid-flight | summarised into every later stage's prompt |
| `finding` | evidence discovered during work | the campaign digest |
| `insight` | a reusable lesson | the campaign digest |
| `source` | an external reference cited during research | **nothing yet** — it is captured and stored, but no engine path or view reads it back |

## Configuration

FlowCrew reads `config/defaults.yaml` (`auto` recommends Codex when both CLIs are installed):

```yaml
default_timeout_ms: 3600000
default_max_iterations: 5
default_gate_retry_loops: 3
default_stage_technical_retries: 1     # adapter/transport retry, separate from gate loops
default_plan_stage_retries: 2          # transient empty/invalid plan → bounded retry, not fatal
default_supervisor_max_rejects: 2      # supervisor can send a deliverable back, bounded

adapter: auto
session_reuse: false                   # measured benefit was ~9% wall clock; off by default
model: default                         # inherit the adapter's own config unless set here
reasoning_effort: default

campaign_triggers:
  enabled: true
  regression_after: 2
  plateau_after: 3
  plateau_threshold: 5
  repeated_failure_after: 3

supervisor:
  poll_interval_ms: 30000
  routine_assessment_interval_ms: 180000
  stuck_threshold_ms: 600000           # no-progress stage watchdog
```

A brief's `research:` (or `objective:`) block drives the native loop and its honesty gates:

```yaml
research:
  baseline: 0.72
  higher_is_better: true
  integrity:
    field_floors: { real_train_iters: 150 }   # anti-smoke: reject token rounds
  confirm:
    command: "bash confirm.sh"                 # verify-before-trust: must pass before `shipped`
```

## The CLI is the advanced tool, not the front door

You should not need it to get value out of FlowCrew. The `ship` skill starts the work and the
dashboard watches it. Reach for the command line when you want something those two do not
give you: a scripted or scheduled launch, a brief you already wrote, or an operational
answer about the install itself.

Five are worth knowing on day one:

```bash
flowcrew doctor                   # is this install actually ready?
flowcrew adapter                  # current choice, installed CLIs, and recommendation
flowcrew adapter claude           # set an installed backend explicitly
flowcrew rehearse <brief.md>      # replay a brief for free before spending anything
flowcrew status                   # what is running right now
```

`flowcrew init` decides once and writes what it decided: the only installed CLI when there
is one, recommended Codex when both are installed (an interactive init preselects it and
lets you choose), and `adapter: auto` only when neither is installed, so scaffolding never
hangs on a prompt. Every later run resolves without prompting and never rewrites the
project; use `flowcrew adapter <name>` for an explicit change.

All 20 commands — launching, steering, approvals, brief history, daemon and dashboard
lifecycle, registry repair, reality audit — are documented with their options and exit
codes in the **[CLI reference](guide/cli.md)**.

## Known issues

Reproduced on the current release. Listed here rather than discovered by you.

- **`npm audit` reports two moderate advisories in `ui/`** (React Router). No published
  version closes both at once, and the alternative trades them for two high-severity ones.
  Production dependencies (`npm audit --omit=dev`) report none.
- **`flowcrew status` and `/fc-status` are not project-scoped.** Run from any directory,
  they report the most recent run across every project on the machine — including one
  that belongs to a different project entirely. A run that has already reached a terminal
  state can also still render as `In progress`. Use `flowcrew task show <id>` for a
  specific run until this is fixed.
- **A `config/defaults.yaml` that fails to parse is not self-repairing.** `flowcrew
  doctor` names the exact parse error with line and column, but the `flowcrew init` it
  suggests will not overwrite an existing file, so the fix is currently manual.
- **Two spec files are timing-sensitive under load.** `spec/negotiation.test.ts` and
  `spec/deterministic-retry-clock.test.ts` assert sub-200ms scheduling budgets and can
  fail on a saturated machine while passing in isolation. If `npm test` fails only
  inside those two, re-run them alone before treating it as a regression.
- **Without a systemd user session — on macOS, or on Linux outside a login session — a
  background task can finish without the daemon noticing.** The run's own record reaches a
  terminal state correctly, but `flowcrew task list` may keep reporting it as running. Read
  the outcome with `flowcrew task show <id>` until this is fixed.
- **macOS identifies processes slightly more loosely than Linux.** Without `/proc` a process is
  matched by pid and command line rather than by an exact start-time token, so if the operating
  system recycles a pid before FlowCrew notices the original exited, it can mistake the new
  process for the old one. Liveness, ownership and cancellation are unaffected. This is a
  deliberate trade — the faithful alternative needs a native addon.

## Documentation

- [Atom Architecture](design/atom-architecture.md): self-describing atoms and the planner composition model.
- [Architecture](guide/architecture.md): scheduler, worker, supervisor, loops, storage.
- [Run Lifecycle](guide/run-lifecycle.md): all 13 statuses and their operator meaning.
- [Brief and File Contract](guide/brief-contract.md): frontmatter and agent-engine artifacts.
- [Approval Inbox](guide/approvals.md): park/resume, decisions, CLI, dashboard, and standing rules.
- [Zero-token Rehearsal](guide/rehearse.md): what the wind tunnel proves and what it cannot prove.
- [Campaigns and Run Memory](guide/campaigns.md): campaigns, plateaus, pivots, knowledge graph.
- [Reality-Gate](guide/reality-gate.md): deterministic evidence checks before terminal success.
- [Configuration](guide/configuration.md): defaults, adapters, per-role overrides, supervisor settings.
- [Agent Skills](guide/skills.md): Claude Code slash commands, Codex skills, and installation.
- [CLI Reference](guide/cli.md): all 20 commands and their subcommands/options.
- [Contributing](CONTRIBUTING.md): build, test, documentation, commit, and PR expectations.

## License

[MIT](LICENSE)

## Author

FlowCrew Captain — LinkedIn: [Profile](https://www.linkedin.com/in/qian-cui/)
