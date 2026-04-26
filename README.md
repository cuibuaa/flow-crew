<p align="center">
  <img src="assets/flowcrew_mascot.svg" width="300" alt="FlowCrew — Mini-Bot Crew" />
</p>

# FlowCrew

<p align="center"><em>Browser-based multi-agent workflow runner for Codex, with experimental Claude support</em></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20" />
</p>

## What it is

FlowCrew is a browser-based multi-agent workflow runner for Codex, with experimental Claude support. It makes agent execution visible, reviewable, and retryable: discuss scope with a planner, review the generated execution plan, then watch agents run live in the browser with retries, QA gates, and persistent state.

<p align="center">
  <img src="assets/demo.gif" width="900" alt="FlowCrew dashboard demo" />
</p>

## ✨ Features

- 🔄 **Planner-Generated Plans** — Turn a task brief into a staged execution DAG
- 🤖 **Multi-Agent** — Assign different AI agents to different stages
- 🔌 **Adapter System** — Codex (default) and Claude (**Experimental**)
- 📊 **Live Dashboard** — Real-time stage progress, terminal output, discussion UI
- 💬 **Interactive Discussion** — PTY-based agent conversations for task planning
- 🔁 **Auto-Retry & Iteration** — Configurable retries with verdict-based loops
- 📁 **Persistent State** — Run state survives restarts (`.fc/runs/`)
- 🛡️ **Skills** — Inject domain knowledge via Markdown skill files

## Dogfooded Improvements

FlowCrew has already been used to improve FlowCrew through real multi-agent runs. Recent resolved improvements include:

- Campaign iteration visibility in the dashboard
- Research-injection and campaign pivot surfaces
- Campaign-aware trigger logic using previous run history
- Safe campaign ID persistence
- Existing campaign selection when creating new tasks
- Clean campaign naming without internal prefixes
- Richer live monitor with DAG, attempt history, and output panels
- Persistent task settings that survive reloads

## How is FlowCrew different?

| Tool | Best for | FlowCrew difference |
|---|---|---|
| CrewAI | Role-based agent collaboration | FlowCrew focuses on visual plan review, live execution monitoring, and retryable staged runs. |
| LangGraph | Programmatic agent graphs | FlowCrew is browser-first and human-review-first, so plans and execution state are visible before and during a run. |
| AutoGen | Agent conversation patterns | FlowCrew adds persistent runs, QA gates, retry loops, and dashboard monitoring around staged workflows. |
| Shell scripts | Simple automation | FlowCrew gives structured stages, agent roles, dependencies, verdict files, and run history. |

## 🎯 Design

**Visible Execution Plan**
The planner agent analyzes a task and produces a topologically-sorted DAG of stages. The dashboard shows this plan for human review before execution. Once approved, stages run in parallel where dependencies allow. The generated plan is persisted as `dispatch.yaml` so runs remain reproducible and inspectable.

**Two-Layer Retry Loop**
Inner loop — when a QA gate fails, the targeted fix stage re-runs and the gate re-checks (up to 3×). Outer loop — if the inner loop exhausts retries, the system re-plans with full iteration history (up to `max_iterations`). QA writes NEW and DIFFERENT tests each cycle to avoid repeating the same checks.

**Campaign Intelligence**
Score tracking across runs via JSONL. The system auto-detects regression (score drops after N runs), plateau (score stuck within threshold for N runs), and repeated failures. When detected, it triggers a strategy pivot — the planner gets campaign context and adjusts approach.

## 🧭 Use Cases

**Campaign-driven development** — Link multiple runs into a campaign. Run #3 automatically knows what #1 and #2 tried, what scored well, and what failed. FlowCrew detects plateaus (score stuck for N runs), regressions (score drops), and repeated failures — then triggers a strategy pivot. You keep iterating on the same goal and the system builds on prior work.

**Autonomous research** — Set up a pipeline with the `researcher` role (web search + fetch), `paper_writer`, `paper_reviewer` (numerical scoring), and `ai_detector`. The whole chain runs with QA gates — if the reviewer scores below threshold, the writer revises. Works for literature surveys, technical reports, or any knowledge-gathering workflow.

**Interactive task scoping** — Before any code runs, the Discussion UI lets you talk to the planner. Using skills like Socratic clarification, it asks probing questions about scope, constraints, and edge cases. Once aligned, it writes a `task_brief.md` and produces an execution plan you review visually before approving.

**Self-correcting code pipelines** — The two-layer retry loop means you don't babysit. QA writes new tests each cycle (not the same checks), the coder fixes, and the gate re-checks. If the inner loop exhausts retries, the planner re-plans with full iteration history. Set `max_iterations` and walk away.

**Custom agent roles** — Configure role definitions under `config/agents/` when you need specialized agents. Ships with: planner, coder, qa, researcher, paper_writer, paper_reviewer, ai_detector, doc_writer, doc_reviewer, discussion. Each defines its own tools, prompt, and identity. The planner composes these roles into workflow stages.

## 🔄 How It Works

1. **Create a task** — Click "+ New Task" in the dashboard. Optionally attach it to a campaign to build on previous runs.
2. **Discuss** — Chat with the planner agent in the Discussion tab. It clarifies requirements and writes `task_brief.md`.
3. **Review the plan** — The planner produces a DAG of stages with roles, dependencies, and gates. You see it visually in Plan Review and can approve or send back. FlowCrew persists the approved plan as `dispatch.yaml`.
4. **Execute** — Approved stages run in parallel where dependencies allow. The Live Monitor shows real-time terminal output per stage.
5. **QA gates** — Gate stages run tests and produce verdicts with scores. Failed gates trigger the inner retry loop (fix → re-check, up to 3×).
6. **Iterate** — If inner retries exhaust, the outer loop re-plans with full history. Campaign-aware runs also get cross-run context for smarter pivots.
7. **Done** — Final scores are logged to the campaign JSONL. The next run in the campaign starts with this context.

## Architecture

```
┌─────────────┐     ┌────────────┐     ┌──────────────┐
│     UI      │────▶│  Scheduler │────▶│   Adapters   │
│  Dashboard  │     │  (stages)  │     │ codex|claude │
└─────────────┘     └────────────┘     └──────────────┘
       │                  │                    │
       ▼                  ▼                    ▼
┌─────────────┐     ┌────────────┐     ┌──────────────┐
│  Dashboard  │     │   Store    │     │ Agent Roles  │
│  (Fastify)  │     │ .fc/runs/  │     │ config/agents│
└─────────────┘     └────────────┘     └──────────────┘
```

## 📸 Screenshots

| Dashboard | Plan Review |
|:-:|:-:|
| ![Dashboard](assets/screenshot_dashboard.png) | ![Plan Review](assets/screenshot_plan_review.png) |

| Live Monitor | Task Discussion |
|:-:|:-:|
| ![Live Monitor](assets/screenshot_monitor.png) | ![Discussion](assets/screenshot_discussion.png) |

## Example Workflows

The `examples/` directory contains reference plans based on the shipped agent roles and current workflow schema. In normal use, users describe the task in the browser; the planner generates this structure for review.

- `examples/coding-agent-workflow.yaml` — planner, coder, QA gate, and targeted fix loop.
- `examples/bug-fix-qa-workflow.yaml` — reproduce a bug, fix it, and verify with new tests on retries.
- `examples/research-workflow.yaml` — research, draft a technical summary, and review it for accuracy.

## 🚀 Quick Start

First, install your backend agent CLI: Codex or Claude Code.

```bash
npm install
npm run dev
```

Opens the dashboard at http://localhost:3000.

1. Open http://localhost:3000
2. Click "+ New Task", give it a name (optionally link to a campaign)
3. Describe what you want in the Discussion tab — the planner will ask clarifying questions
4. Review the generated execution plan in Plan Review → click Approve
5. Watch stages execute in real-time on the Live Monitor
6. Check results — QA gates show pass/fail verdicts with scores

## Adapters

| Adapter | Status | Default |
|---------|--------|---------|
| Codex   | Stable | ✅      |
| Claude  | **Experimental** — not fully tested | —       |

Set the adapter in `config/defaults.yaml`.

## 🧩 Skills

Skills are Markdown files in `config/skills/` that inject domain knowledge into agent prompts. Ships with `deep-interview.md` (adapted from [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)) which teaches agents Socratic clarification — probing for scope, constraints, and edge cases before acting. Create your own skills for project-specific conventions, coding standards, or review criteria.

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

```
├── src/
│   ├── index.ts             # Entry point
│   ├── dashboard.ts         # Fastify server + API
│   ├── scheduler.ts         # Workflow execution engine
│   ├── store.ts             # Persistent run state
│   ├── worker.ts            # Stage worker
│   ├── condition.ts         # Condition evaluation
│   ├── handoff.ts           # Stage handoff logic
│   └── adapters/
│       ├── base.ts          # Adapter interface
│       ├── codex.ts         # Codex adapter
│       └── claude.ts        # Claude adapter
├── config/
│   ├── defaults.yaml        # Global defaults
│   ├── agents/              # Agent role configs
│   ├── workflows/           # Generated or advanced workflow definitions
│   └── skills/              # Skill documents
├── ui/                      # React dashboard (Vite + Tailwind)
├── assets/                  # Mascot, screenshots
└── .github/                 # Issue & PR templates
```

## License

[MIT](LICENSE)

## Author

FlowCrew Captain  
LinkedIn: [Profile](https://www.linkedin.com/in/qian-cui/)


