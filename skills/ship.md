# /ship — Hand off your plan to FlowCrew for multi-agent execution

When the user invokes `/ship`, follow these steps:

## 0. Prior-Run Handoff Check (BEFORE drafting)

If the most recent FlowCrew run for this project ended in `escalated` or `ceiling_hit`, read its terminal artifact and treat its findings as REQUIRED input to the new brief. Skipping this often produces a brief that re-litigates the same path the previous run already eliminated.

```bash
# Find the latest run that targeted this project
LATEST_RUN_DIR=""
for d in $(ls -1t "$HOME/.fc/runs/" 2>/dev/null); do
  RJ="$HOME/.fc/runs/$d/run.json"
  [ -f "$RJ" ] || continue
  PROJECT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('projectDir',''))" "$RJ" 2>/dev/null)
  if [ "$PROJECT" = "$PWD" ]; then LATEST_RUN_DIR="$HOME/.fc/runs/$d"; break; fi
done

if [ -n "$LATEST_RUN_DIR" ]; then
  PRIOR_STATUS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$LATEST_RUN_DIR/run.json" 2>/dev/null)
  PRIOR_ARTIFACT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('terminalArtifact','') or '')" "$LATEST_RUN_DIR/run.json" 2>/dev/null)
  if [ "$PRIOR_STATUS" = "escalated" ] || [ "$PRIOR_STATUS" = "ceiling_hit" ]; then
    echo "Prior run ended: $PRIOR_STATUS (artifact: $PRIOR_ARTIFACT)"
    # Read the terminal artifact — search common research dirs
    find "$PWD/docs" -name "$PRIOR_ARTIFACT" 2>/dev/null | head -1 | xargs -r cat
  fi
fi
```

Behavior:
- If prior status is `escalated`: read `escalation_note.md` (blocker + options); the new brief MUST address the blocker or explicitly pick one of the options. Do not propose unrelated direction without acknowledging the blocker.
- If prior status is `ceiling_hit`: read `ceiling_report.md`; the new brief MUST either (a) attempt a clearly different alpha source than what was tested, OR (b) acknowledge the ceiling and pivot scope (e.g., execution alpha instead of model alpha). Do not re-test the same signals.
- If prior status is `complete` / `shipped` / no prior run: nothing to do, proceed to step 1.

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

## 2. Campaign Hygiene Check (BEFORE confirming)

FlowCrew injects prior-phase context from the project's campaign into every planner prompt. If recent campaign entries look terminal/stuck (fail-closed, halt, ceiling, escalation) AND the new brief is a different direction (fresh research, new approach, etc.), that inherited context can mislead the planner into continuing the old phase chain instead of executing the new brief.

Run this check before presenting the brief:

```bash
# Resolve campaign name the same way flowcrew does:
#   1. --campaign flag (n/a at this stage)
#   2. config/defaults.yaml::campaign
#   3. slug(basename(projectDir))
CAMPAIGN_NAME=$(grep -E "^campaign:" "$PWD/config/defaults.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')
if [ -z "$CAMPAIGN_NAME" ]; then
  CAMPAIGN_NAME=$(basename "$PWD" | tr 'A-Z_ ' 'a-z--' | sed 's/--*/-/g; s/^-//; s/-$//')
fi
CAMPAIGN_FILE="$HOME/.fc/campaigns/${CAMPAIGN_NAME}.jsonl"
SUGGEST_RESET=false
TOTAL=0
RECENT_TERMINAL=0
if [ -f "$CAMPAIGN_FILE" ]; then
  TOTAL=$(wc -l < "$CAMPAIGN_FILE")
  RECENT_TERMINAL=$(tail -10 "$CAMPAIGN_FILE" | grep -ciE 'fail.closed|halt|no.implementation|ceiling|escalation' || echo 0)
  if [ "$RECENT_TERMINAL" -ge 3 ]; then SUGGEST_RESET=true; fi
fi
```

If `SUGGEST_RESET=true`, include this line in your confirm message:
> ⚠️ Campaign `<slug>` has `<N>` total phases; `<RECENT_TERMINAL>/10` recent entries look terminal (fail-closed/halt/ceiling). This brief looks like a different direction. Will add `--no-inherit-campaign` so the planner gets a clean prompt. (Opt out by saying "keep campaign context".)

Default to adding `--no-inherit-campaign` when the heuristic triggers; let user override.

## 3. Confirm with User (REQUIRED — do NOT skip)

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
[Campaign hygiene note from step 2, if triggered]

Shall I proceed? You can edit the brief or adjust settings.
```

Wait for explicit approval. "Looks good", "yes", "ship it" = confirmed.
If user edits → incorporate changes and re-confirm.

## 4. Write and Execute

Once confirmed:
1. Write the brief to `docs/task_brief.md` (see "Terminal-state frontmatter" below for research-style briefs).
2. Run:
```bash
flowcrew quick --task "$(cat docs/task_brief.md)" --project . --max-iterations <N> --timeout <MS> [--no-inherit-campaign]
```

Add `--no-inherit-campaign` if step 2's hygiene check triggered (or the user requested fresh-campaign context).

### Terminal-state frontmatter (for research-exploration briefs)

For tasks where a negative outcome ("ceiling hit", "blocked, need user input") is a LEGITIMATE completion (not a failure to retry), declare terminal states in `---` YAML frontmatter at the top of the brief. The scheduler will terminate the run cleanly when one of these files appears, instead of looping forever waiting for the metric to be met.

```yaml
---
terminal_states:
  shipped:
    paths: [docs/<task>_research/ship_report.md]
  ceiling_hit:
    paths: [docs/<task>_research/ceiling_report.md]
    floor:
      min_attempted_stages: 4       # require 4+ stage_N_verdict.md files in the same dir
      min_wall_minutes: 60          # require 60+ minutes of wall time
  escalated:
    paths: [docs/<task>_research/escalation_note.md]
---
# Task: ...
```

How it interacts with the agent:
- `shipped` / `escalated` → low floor, terminate as soon as the file exists. Trust agent's positive outcome / clear blocker statement.
- `ceiling_hit` → **gated**. The floor is the anti-premature-quit mechanism. If agent writes ceiling_report.md before satisfying the floor, scheduler ignores it, appends a hint to supervisor_guidance.md telling the agent to keep working OR write escalation_note.md with a real blocker, and continues the loop.

Without this frontmatter, the brief behaves exactly as before (no terminal-state handling). Only add it when a negative outcome is a valid completion.

The adapter (claude/codex) is auto-detected. Override with `--adapter claude` or `--adapter codex` if needed.

If `flowcrew` is not found, try: `npx flowcrew quick ...`

## 5. Report Back

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
- `/ship --no-inherit-campaign` — skip injecting prior-phase campaign context into planner prompts (use when task pivots from prior campaign direction)
- `/ship --keep-campaign-context` — force-keep prior context even if hygiene heuristic would suggest dropping it
