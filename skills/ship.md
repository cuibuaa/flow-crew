# /ship — Hand off your plan to FlowCrew for multi-agent execution

When the user invokes `/ship`, follow these steps:

## 1. Extract the Task Brief

Review the current conversation and extract a **fully self-contained** task brief.

CRITICAL: The executor (FlowCrew planner) has ZERO context from this conversation. It only sees the task_brief.md file. The brief must be completely standalone — no references to "above", "as discussed", "the issues mentioned", "the plan we agreed on". Every detail must be explicit.

Include:
- **Goal**: What to accomplish (1-2 sentences)
- **Context**: Background, constraints, requirements — enough for someone who hasn't seen this conversation
- **Specific details**: If the conversation identified specific files, line numbers, bugs, or changes — list ALL of them explicitly with full file paths and descriptions
- **Approach**: Step-by-step plan (not "fix the issues" — list each issue and how to fix it)
- **Success Criteria**: Measurable criteria the QA gate can verify
- **Key Files/Modules**: Full paths to every file that needs changes

Self-contained test: Could a developer who has never seen this conversation read the brief and know EXACTLY what to do? If not, add more detail.

If the user said `/ship <specific instruction>`, use that as the task directly.
If the conversation has no clear plan yet, ask the user to clarify before proceeding.

## 2. Confirm with User (REQUIRED — do NOT skip)

Present the brief and ask for confirmation:

```
Here's what I'll ship to FlowCrew:
---
Goal: [goal]
Context: [context]
Approach: [approach]
Success Criteria: [criteria]
Key Files: [files]
---

Settings:
- Max iterations: 5 (plan→execute→review cycles)
- Stage timeout: 5 minutes (per-stage time limit)
- Workflow: default

Shall I proceed? You can edit the brief or adjust settings.
```

Wait for explicit approval. "Looks good", "yes", "ship it" = confirmed.
If user edits → incorporate changes and re-confirm.

## 3. Write and Execute

Once confirmed:
1. Write the brief to `docs/task_brief.md`
2. Run:
```bash
flowcrew quick --task "$(cat docs/task_brief.md)" --project . --max-iterations <N> --timeout <MS>
```

The adapter (claude/codex) is auto-detected. Override with `--adapter claude` or `--adapter codex` if needed.

If `flowcrew` is not found, try: `npx flowcrew quick ...`

## 4. Report Back

Tell the user:
- Task shipped to FlowCrew
- Workflow and settings used
- How to check progress: type `/fc-status`
- Or open dashboard: http://localhost:3000

## Variants

- `/ship --workflow engineering` — use the engineering workflow (includes QA gate + retry)
- `/ship --adapter claude` — force Claude adapter
- `/ship --adapter codex` — force Codex adapter
- `/ship --supervise` — enable supervisor brain (monitors + steers execution)
