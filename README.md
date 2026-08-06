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
  <img src="https://img.shields.io/badge/verify--before--trust-confirm--gate-16a34a.svg" alt="Confirm-gate: verify before trust" />
  <img src="https://img.shields.io/badge/memory-knowledge_graph-2563eb.svg" alt="Knowledge graph memory" />
</p>


```text
> Beat the current model on val accuracy. Ship only a result that re-confirms
> on a fresh split.
> /ship
```

**Most AI agents are eager to tell you they succeeded. FlowCrew is built to catch itself when it didn't.**

Hand it a task brief and it runs as a supervised crew — planner, coder, researcher, reviewer, QA, supervisor — that plans, executes, retries, and checks its own work for hours, unattended.

And the difference isn't one clever check at the end — it's systemic. Self-checking, exploring, and self-correcting are designed into every step: the planner probes the problem and stages the work, gates catch weak output and fire targeted fixes, the supervisor retries and sends insufficient work back — and only after all that does an *independent* re-check decide whether the result is real enough to call **shipped**. Beat the metric but fail that check? Downgraded, not shipped. It reports honest negatives, refuses to fake progress, and remembers every dead end so the next run never repeats it.

A one-shot agent hands you a best-effort answer. FlowCrew hands you an auditable result you can trust — because it didn't trust itself first.

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
    <img src="assets/how_it_works.png" width="620" alt="FlowCrew execution flow: a brief from /ship goes to the planner, which dispatches coder stages; their output meets a QA gate that either sends a bounded fix round back or passes the work to the Reality-Gate, which decides between shipped/complete and reality_gate_failed. A supervisor watches progress and can trigger a re-plan on regression, plateau or repeated failure." />
  </picture>
</p>

The important boundary: the supervisor **steers** but never edits files or runs commands. Work
happens in worker stages; evidence is checked by gates, Reality-Gate, and — before any
`shipped` — the confirm-gate.

## What makes it work

Four design choices carry most of the weight. Each is stated with what it actually
buys you, not what it aspires to.

### Self-describing atoms — the planner prompt is a composition engine, not a dictionary

A role describes itself in its own config (`config/agents/*.yaml`, field `description:`).
A registry collects those descriptions, injects them into the planner at runtime, and the
engine validates the planner's output against the same registry. **Adding a role requires
zero planner-prompt edits.**

That invariant is the point: when a primitive's meaning lives in the prompt *and* in the
engine, the two copies drift, and every change becomes a hand-edit in two places. Here the
meaning lives at the primitive's own source and is injected.

The role is the reference case; the same treatment is being generalised to the other
composable primitives — see [`design/atom-architecture.md`](design/atom-architecture.md).

### A harness you can rehearse for free

`flowcrew rehearse` runs the **real scheduler** against a **scripted fake agent** — no model,
no tokens, seconds. It exercises the whole lifecycle, not a mock of it:

```bash
flowcrew rehearse examples/hello-research.brief.md
```

It reports line by line what the harness actually did: a decoy result triggered `ship` and the
confirm-gate rejected it, the round floor was met, the terminal artifact landed at its declared
path, and the confirm command was executed by the engine and recorded — ending in a
contract-ready verdict.

About a second in a fresh clone. It separates two questions most systems conflate:
*is the harness wired correctly* and *did the agent do good work*. The first is now free.

The harness also reports on itself:

- `daemon status` / `dashboard status` compare the loaded build against the one on disk,
  print `FRESH` or `STALE`, and **exit non-zero when stale** — a deploy script can refuse to proceed.
- A scheduler that dies without settling gets its run rewritten as `failed` with the reason,
  instead of leaving a record that still claims `running`.

### Two layers of specification — and hard constraints go through deterministic checks

| Layer | What it defines | Where it lives |
|---|---|---|
| **HOW** | the atom vocabulary: roles, checks, terminal states | flow-crew — general, public |
| **WHAT** | this project's acceptance contract and the brief | `<project>/.flowcrew/contract.yaml` — never in the engine |

The rule that keeps this honest:

> A hard constraint must be enforced by a **deterministic check**, not by an agent-judged QA
> prompt. The planner may *derive* what to check from the goal; enforcement runs as a script
> whose exit code decides.

An agent asked "did this meet the bar?" can be argued with. A `Reality check` is a script:
it runs, it exits, and a failing exit code keeps the run out of a terminal state.

The spec layer has its own static check — `rehearse` lints a brief and flags wording that
binds an *implementation* to "must", the shape a gate faithfully turns into an assertion
unrelated to what you meant. It also refuses to let a brief declare a finish condition that
nothing in the engine will ever satisfy, which otherwise surfaces only as a run that will not
end.

### Observable execution — including what it could not determine

**What you see.** The operating loop is three pages, each answering one question.

| Page | Answers |
|---|---|
| `/inbox` | Is anything waiting on me? |
| `/campaign/<id>` | Where does this campaign stand? |
| `/run/<id>` | What is this run doing — or what did it conclude? |

Distinct outcomes stay distinct. `shipped`, `complete`, `ceiling_hit`, `incomplete`,
`reality_gate_failed` and `stopped` mean different things and are never collapsed into a
generic pass or fail — the run page names the one that applies and, beside it, what that
status means.

**What it admits.** The surface states what it does *not* know:

```text
Canonical status      running
Run elapsed           56.8s
                      Wall clock since the run started; not the current attempt duration.
Known recorded usage  17,567 tokens
                      Known portion only, including recorded supervisor usage; unsettled
                      or unavailable fields are not treated as zero.
```

The labels themselves carry the claim. A finished run reads `Canonical outcome`,
`Total wall time` and `Total recorded usage` — the word changes only when the number has
actually become complete. At campaign scale the same rule produces lines like *"11 of 16
runs have incomplete cost evidence: token or attempt telemetry is incomplete for 11 runs.
Affected totals are lower bounds."*

<p align="center">
  <img src="assets/screenshot_run_page.png" width="820" alt="FlowCrew run page for a completed run: canonical outcome, total wall time, total recorded usage, an honest note that recorded progress is not presented as the final conclusion, and an execution-history panel naming zero failed attempts" />
</p>

Each line is a deliberate refusal to present a number as more complete than it is.

**What is underneath.** A live stage streams its log over SSE with a byte counter, so
"still producing" is visible rather than guessed. Every attempt records duration, exit code,
token evidence (measured counters or an explicit unknown marker), and files written. A failed
Reality-Gate check lands in `run.json` **named**, with ANSI-stripped output tails — no hunting.

**What you can do without stopping it.** `flowcrew guide --run <run-id> "message"` injects context
mid-flight. Omitting `--run` is accepted only when exactly one run is executing, so concurrent
runs cannot receive guidance by recency accident. `flowcrew inbox` resolves approval gates that
parked the run. The daemon owns the run, so closing your session changes nothing.

**What not to do while it runs.** Do not edit the project yourself while a run is working in it.
Attribution comes from a filesystem snapshot diff, which cannot tell your edit apart from the
stage's: your change is recorded as that stage's work, and where a stage has been told which
paths it may write, enforcement can restore anything outside them to its pre-stage contents —
including your edit. Say what you want changed with `flowcrew guide` instead, or wait for a
terminal state.

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

## Before you start

- **Node.js 22.5 or newer** is required. FlowCrew uses the built-in `node:sqlite` module.
- **Linux with a systemd user session** is the supported setup for the complete background-task and dashboard experience. The engine falls back to a detached Bash process when `systemd-run --user` is unavailable, but process inspection still relies on Linux `/proc`; macOS and Linux environments without a working user session are not fully supported.
- **A logged-in agent CLI is required for live work.** Install and authenticate either OpenAI Codex CLI or Claude Code. The zero-token rehearsal below does not require either one.
- **The engine and dashboard are separate build targets.** A repository install runs both builds through the package `prepare` hook, producing `dist/` and `ui/dist/`.
- **One task per project at a time.** Queue as many as you like — the daemon holds the rest and starts the next when the current one reaches a terminal state. The guard is per project, so tasks in different projects do run concurrently.
- **`npm audit` reports two moderate advisories in `ui/`** (React Router). No published version closes both at once, and the alternative trades them for two high-severity ones. Production dependencies (`npm audit --omit=dev`) report none.

> [!WARNING]
> **Live runs receive unattended shell access.** The Codex and Claude adapters bypass their normal approval, permission, and sandbox prompts. Starting a live run — from the `ship` skill, from the Dashboard, or with `flowcrew quick` — can therefore give an agent full shell access to the selected project for hours. Use a dedicated workspace or suitably isolated Linux container, and review the task before launch.
>
> Every launch path first prints the same static brief preflight used by `rehearse`. Consequential findings require the explicit `--acknowledge-brief-warnings` choice; the flag never skips or hides inspection. After admission, `quick` writes the submitted text to `<projectDir>/docs/task_brief.md`, replacing different content only after warning. Start with `flowcrew rehearse`: it launches no agent process or model, spends no tokens, and does not modify your project; an in-process scripted adapter exercises the scheduler in isolated temporary directories.

## Get started

**The way in is the `ship` skill from your coding agent.** Invoke it as `/ship` in Claude
Code or as `$ship` in Codex (you can also choose `ship` from Codex's `/skills` list). It interviews you, turns the
discussion into a brief, and rehearses that brief before anything runs. That matters more
than it sounds: a run's outcome is decided mostly by its brief, and the skill carries the
accumulated rules for writing one — state criteria as properties rather than naming the
instrument, put the boundaries in the brief instead of sending them later, declare terminal
artifacts only on what the last stage writes.

The CLI is how you **watch, steer, verify, and operate** a run. `flowcrew quick "one
sentence"` is still available for scripts and direct operation, but it now says plainly that
the input has no structured brief contract, prints the shared preflight report, and stops
until the caller explicitly acknowledges the current exact text. It checks; it does not
interview you or author the missing contract. Use the `ship` skill for that primary authoring path.

Dashboard **+ New Run** follows the same boundary: the first action checks the writable
brief and shows frontmatter, contract, and criterion findings inline; the second action
starts that exact checked text, with a checkbox when consequential findings remain.

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

Four are worth knowing on day one:

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
