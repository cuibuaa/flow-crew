<p align="center">
  <img src="assets/flowcrew_mascot.svg" width="300" alt="FlowCrew Mini-Bot Crew" />
</p>

# FlowCrew

<p align="center"><em>Turn agent work into visible, reviewable, long-running workflows with persistent memory.</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg" alt="Node >= 22.5" />
  <img src="https://img.shields.io/badge/default-Codex-111827.svg" alt="Codex default" />
  <img src="https://img.shields.io/badge/workflow-visual_DAG-2563eb.svg" alt="Visual DAG workflow" />
  <img src="https://img.shields.io/badge/execution-reliable_plan_completion-f97316.svg" alt="Reliable plan completion" />
  <img src="https://img.shields.io/badge/memory-run_memory_graph-0f766e.svg" alt="Run Memory Graph" />
</p>

## What it is

FlowCrew is a browser-based control plane for Codex-powered multi-agent work, with experimental Claude support. It turns a clear discussion into a staged plan you can review, then drives that plan toward reliable completion with visible execution, structured recovery, and task-local run memory.

<p align="center">
  <strong>Discuss</strong> → <strong>Approve the DAG</strong> → <strong>Watch agents run</strong> → <strong>Keep the run memory</strong>
</p>

<p align="center">
  <img src="assets/demo.gif" width="900" alt="FlowCrew dashboard demo" />
</p>

## Experience at a glance

| Discuss a clear plan | Monitor while running | Complete reliably | Remember after completion |
|---|---|---|---|
| Discussion turns user intent into a visible DAG with roles, dependencies, gates, and retry paths. | Live Monitor shows stage status, terminal output, attempts, alerts, and artifacts as agents work. | FlowCrew keeps pursuing the approved plan through QA-confirmed fixes and strategy re-planning when local fixes are not enough. | Run Memory Graph keeps findings, evidence, dead ends, decisions, and scores attached to the run. |

## ✨ Features

- 🔄 **Reviewed Execution Plans** - Turn a clear discussion into a staged DAG you can inspect before agents act.
- 💬 **Interactive Discussion** - PTY-based planning conversations before execution starts.
- 📊 **Live Dashboard** - Real-time stage progress, terminal output, discussion UI, campaign trendlines, and collapsible recent events.
- 🤖 **Multi-Agent Execution** - Assign different agent roles to different stages.
- 🔁 **Reliable Plan Completion** - FlowCrew keeps a reviewed plan moving through QA-confirmed fixes, retries, and re-planning when needed.
- 🧠 **Run Memory Graph** - Users can inspect what agents learned, what failed, what evidence mattered, and what should carry into the next stage.
- 🧬 **Campaign Memory** - Related runs remember score history, prior attempts, failed strategies, and pivot signals.
- 🧾 **Traceable Artifacts** - Outputs, verdicts, metrics, token counts, and changed files stay inspectable after the run.
- 📁 **Persistent State** - Run state survives restarts under `.fc/runs/`.
- 🔌 **Adapter System** - Codex is the default adapter; Claude support is experimental.
- 🛡️ **Skills** - Inject domain knowledge via Markdown skill files.

## Why FlowCrew works for long runs

| 👁️ Visual plan | ✅ Reliable completion | 🧠 Persistent run memory | 🧬 Campaign memory |
|---|---|---|---|
| Review a generated DAG before agents touch the project. Roles, dependencies, gates, and retry paths are visible upfront. | After the plan is approved, FlowCrew keeps executing toward completion: fix confirmed failures, re-check gates, and re-plan when the current strategy is exhausted. | Findings, evidence, dead ends, decisions, scores, and user hints stay attached to the run instead of disappearing into chat history. | Related runs remember what was tried, what scored well, what failed repeatedly, and when the strategy should pivot. |

FlowCrew has been dogfooded on FlowCrew itself. The current runtime includes operational safeguards for real agent runs:

- **Verdict-gated execution** - gates must produce explicit pass/fail verdicts before dependent stages proceed.
- **Live observability** - dashboard streams stage status, terminal output, events, attempts, artifacts, token usage, and alerts.
- **Resilient retries** - scheduler retries QA/fix loops, worker retries transient adapter failures with backoff, and stale executions are detected.
- **Durable context** - run state, dispatch plans, iteration logs, campaign metrics, trace events, and Run Memory Graph updates are persisted under `.fc/`.

## How is FlowCrew different?

| Tool | Best for | FlowCrew difference |
|---|---|---|
| CrewAI | Role-based agent collaboration | FlowCrew is the visual operations layer: users review the plan, watch every stage run, inspect outputs, and retry failed gates without losing context. |
| oh-my-codex | Codex prompts, skills, and workflow guidance | FlowCrew turns prompt practices into an executable browser workflow with generated DAGs, live terminals, QA verdicts, artifacts, and durable run memory. |
| open-claw | Always-on assistant and channel automation | FlowCrew is project-local and review-first: it makes agent execution observable, keeps decisions and evidence attached to the run, and preserves knowledge for later stages. |

FlowCrew's core advantage is not just launching agents. It helps users turn a clear discussion into an approved plan, then makes long-running execution operable: progress is visible, failures are handled by structured recovery, and useful context survives beyond a single chat transcript.

## 🎯 Design

**Visible Execution Plan**
The planner agent analyzes a task and produces a topologically sorted DAG of stages. The dashboard shows this plan for human review before execution. Once approved, stages run in parallel where dependencies allow. The generated plan is persisted as `dispatch.yaml` so runs remain reproducible and inspectable.

**Reliable Plan Completion**
FlowCrew is built for long-running agent workflows that should not collapse after the first failed check. The user discusses scope first, reviews the generated DAG, then lets FlowCrew drive the approved plan toward completion. Under the hood, an inner loop handles targeted gate failures: when QA fails, the linked fix stage re-runs and QA re-checks up to the configured retry limit. If local fixes are exhausted, an outer loop re-plans with full iteration history so the next attempt can change strategy instead of repeating the same failed path.

**Run Memory Graph**
Run Memory Graph is designed for user visibility, not just agent storage. During a run, it helps answer practical questions: what did the agents already try, which findings are backed by evidence, which paths were dead ends, what should the next stage reuse, and why did the final verdict happen? FlowCrew stores this task-local memory in `.fc/runs/<runId>/knowledge_graph.json`, renders it as the Knowledge Graph view in the browser, and tracks it as an artifact whenever stages update it.

**Campaign Intelligence**
Score tracking across runs is stored in JSONL. The system can detect regression, plateau, and repeated failure signals. When those triggers fire, the planner receives campaign context and can pivot strategy instead of treating each run as isolated.

## 🧭 Use Cases

**Campaign-driven development** - Link multiple runs into a campaign. Run #3 can build on what #1 and #2 tried, what scored well, and what failed. FlowCrew can detect plateaus, regressions, and repeated failures, then trigger a strategy pivot.

**Autonomous research** - Set up a pipeline with `researcher`, `paper_writer`, `paper_reviewer`, and optional detector or QA roles. The chain can gather evidence, draft a report, score it, and revise until the gate passes.

**Interactive task scoping** - Before any code runs, the Discussion UI lets you talk to the planner. It can ask clarifying questions about scope, constraints, and edge cases, then write `task_brief.md` and produce an execution plan for review.

**Self-correcting code pipelines** - QA writes focused tests, the coder fixes only confirmed failures, and the gate re-checks. If the inner loop exhausts retries, the planner re-plans with accumulated history.

**Long-running agent workflows** - Use FlowCrew when a task needs more than one-shot chat execution. Start with a clear discussion, approve the plan, then let FlowCrew keep the run inspectable, retry local failures, re-plan when strategy fails, and persist the context needed for the next attempt.

**Custom agent roles** - Configure role definitions under `config/agents/` when you need specialized agents. Ships with planner, coder, QA, researcher, paper writer, paper reviewer, AI detector, doc writer, doc reviewer, and discussion roles.

## 🔄 How It Works

1. **Create a task** - Click "+ New Task" in the dashboard. Optionally attach it to a campaign to build on previous runs.
2. **Discuss** - Chat with the planner agent in the Discussion tab. It clarifies requirements and writes `task_brief.md`.
3. **Review the plan** - The planner produces a DAG of stages with roles, dependencies, and gates. You see it visually in Plan Review and can approve or send it back.
4. **Execute** - Approved stages run in parallel where dependencies allow. The Live Monitor shows real-time terminal output per stage.
5. **Build run memory** - Stages add reusable findings, failed approaches, source references, decisions, and scores to the task-local Run Memory Graph.
6. **QA gates** - Gate stages run tests and produce explicit verdict files. Failed gates trigger the inner retry loop.
7. **Recover** - If local retries exhaust, FlowCrew re-plans with full history instead of blindly repeating the same attempt.
8. **Iterate** - Campaign-aware runs also get cross-run context for smarter pivots.
9. **Done** - Final scores and artifacts are persisted. The next campaign run can reuse that context.

## Architecture

```text
┌─────────────┐     ┌────────────┐     ┌──────────────┐
│     UI      │────▶│  Scheduler │────▶│   Adapters   │
│  Dashboard  │     │  (stages)  │     │ codex|claude │
└─────────────┘     └────────────┘     └──────────────┘
       │                  │                    │
       ▼                  ▼                    ▼
┌─────────────┐     ┌────────────┐     ┌──────────────┐
│  Fastify    │     │   Store    │     │ Agent Roles  │
│  API + SSE  │     │ .fc/runs/  │     │ config/agents│
└─────────────┘     └────────────┘     └──────────────┘

Task-local memory:
  .fc/runs/<runId>/knowledge_graph.json
```

## 📸 Screenshots

| Dashboard | Plan Review |
|:-:|:-:|
| ![Dashboard](assets/screenshot_dashboard.png) | ![Plan Review](assets/screenshot_plan_review.png) |

| Live Monitor | Task Discussion |
|:-:|:-:|
| ![Live Monitor](assets/screenshot_monitor.png) | ![Discussion](assets/screenshot_discussion.png) |

| Run Memory Graph |
|:-:|
| ![Run Memory Graph](assets/screenshot_knowledge_graph.png) |

## 🚀 Quick Start

First, install your backend agent CLI: Codex or Claude Code.

```bash
npm install
npx flowcrew init
npx flowcrew doctor
npx flowcrew start
```

Open the dashboard at [http://localhost:3000](http://localhost:3000).

1. Open the dashboard.
2. Click "+ New Task", give it a name, and optionally link it to a campaign.
3. Describe what you want in the Discussion tab.
4. Review the generated execution plan in Plan Review and click Approve.
5. Watch stages execute in the Live Monitor.
6. Inspect QA verdicts, artifacts, campaign scores, and the Run Memory Graph.

## Discussion Starter Examples

Paste one of these prompts into Discussion to start a practical workflow quickly.

### QA-first bug hunt loop

```text
Run a QA-first bug hunt loop on <project-path>
QA must inspect the code, write focused tests under tests/ that reproduce discovered bugs, and produce a verdict.
Coder fixes only QA-confirmed bugs.
After each fix, QA must add new or different tests targeting previous failures and any newly discovered edge cases.
Continue the QA/Coder retry loop until QA returns PASS with no reproducible bugs found within the scoped code area.
Do not broaden scope outside this project.
```

### Open research task

```text
Run an open research campaign on <topic> with a strict evidence-first workflow.
Researcher must gather primary sources, summarize key claims, and capture uncertainties.
Reviewer must score evidence quality and identify weak or conflicting claims.
Writer produces a concise brief with: findings, tradeoffs, recommended next steps, and explicit open questions.
If evidence quality is below the threshold, loop researcher -> reviewer with a new search angle.
Stop only when the reviewer marks evidence quality as PASS for decision support.
```

## Adapters

| Adapter | Status | Default |
|---------|--------|---------|
| Codex | Stable | ✅ |
| Claude | Experimental | — |

Set the adapter in `config/defaults.yaml`.

## 🧩 Skills

Skills are Markdown files in `config/skills/` that inject domain knowledge into agent prompts. FlowCrew ships with `deep-interview.md`, adapted from [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), which teaches agents Socratic clarification: probing for scope, constraints, and edge cases before acting. Create your own skills for project-specific conventions, coding standards, or review criteria.

## Generated Plan Format

Normal users do not need to write this by hand. This is the persisted plan shape FlowCrew uses after the planner turns a task brief into executable stages.

```yaml
name: coding-agent-workflow
defaults:
  timeout_ms: 1800000
  max_retries: 2
  max_iterations: 3
stages:
  - id: implement
    role: coder
    prompt_template: "Implement the requested change with minimal, scoped edits."
  - id: verify
    role: qa
    depends_on: [implement]
    is_gate: true
    prompt_template: "Write focused tests under tests/, run them, and report a verdict."
  - id: fix
    role: coder
    depends_on: [verify]
    retry_to: [verify]
    prompt_template: "Fix issues from the QA verdict, keeping changes scoped."
```

## Project Structure

```text
src/
  index.ts             # Entry point
  dashboard.ts         # Fastify server + API
  scheduler.ts         # Workflow execution engine
  store.ts             # Persistent run state
  worker.ts            # Stage worker
  condition.ts         # Condition evaluation
  handoff.ts           # Stage handoff logic
  adapters/
    base.ts            # Adapter interface
    codex.ts           # Codex adapter
    claude.ts          # Claude adapter
config/
  defaults.yaml        # Global defaults
  agents/              # Agent role configs
  workflows/           # Generated or advanced workflow definitions
  skills/              # Skill documents
ui/                    # React dashboard
assets/                # Mascot, demo, screenshots
.github/               # Issue and PR templates
```

## License

[MIT](LICENSE)

## Author

FlowCrew Captain
LinkedIn: [Profile](https://www.linkedin.com/in/qian-cui/)
