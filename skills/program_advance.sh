#!/usr/bin/env bash
#
# FlowCrew default post_terminate_hook for multi-phase research programs.
#
# Invoked by the scheduler after a phase_complete terminal state is committed.
# The scheduler has already:
#   - Persisted run.json with status=phase_complete
#   - Appended a structural row to findings_ledger.json (phase, run_id, wall_hours, etc.)
#   - Written campaign entry + run_completed event
#
# This script's job:
#   1. Parse the just-written verdict.md to extract phase outcome + next-phase decision
#   2. Enrich the ledger row with the parsed verdict (verdict, result, next_phase_decision)
#   3. Apply program-level kill criteria (the brief's safeguards were checked at run START;
#      here we make the next-phase decision based on what the agent wrote)
#   4. Either:
#       (a) Generate the next phase's brief from the ROADMAP and verdict context (via codex)
#       (b) Spawn the next FlowCrew run via systemd-run
#       (c) Write a program-level terminal report (ship / ceiling / stopped) and exit
#
# Failure is best-effort: a non-zero exit here is logged by the scheduler but the
# parent run still terminates cleanly. Logs go to post_terminate_hook.log.
#
# Env vars provided by scheduler:
#   FC_PHASE            terminal status name (always "phase_complete" here)
#   FC_VERDICT_FILE     absolute path to the verdict .md that triggered termination
#   FC_RUN_DIR          absolute path to this run's ~/.fc/runs/<runId>/ directory
#   FC_PROJECT_DIR      absolute path to the project directory
#   FC_RUN_ID           runId string
#   FC_PROGRAM_NAME     program.name from brief frontmatter
#   FC_PROGRAM_PHASE    program.phase from brief frontmatter (e.g. "A")
#   FC_PROGRAM_ROADMAP  absolute path to ROADMAP.md (if program.roadmap set)
#   FC_PROGRAM_LEDGER   absolute path to findings_ledger.json (if program.ledger set)
#
# Customization: copy this script into your project's `scripts/` dir and edit. The
# brief's `post_terminate_hook.command` field can point at any script.

set -euo pipefail

# ---- 0. Sanity checks ----------------------------------------------------

: "${FC_PROGRAM_NAME:?FC_PROGRAM_NAME not set — is this a program run?}"
: "${FC_PROGRAM_PHASE:?FC_PROGRAM_PHASE not set}"
: "${FC_VERDICT_FILE:?FC_VERDICT_FILE not set}"
: "${FC_PROJECT_DIR:?FC_PROJECT_DIR not set}"

cd "$FC_PROJECT_DIR"

if [ ! -f "$FC_VERDICT_FILE" ]; then
  echo "ERROR: verdict file not found: $FC_VERDICT_FILE" >&2
  exit 1
fi

# ---- 1. Parse verdict.md -------------------------------------------------
#
# Convention: the agent's verdict.md should contain a fenced block:
#   ```yaml
#   verdict: continue
#   next_phase_decision: B_hourly
#   result_2024_2025_funding_adj_from_100: 185.4
#   ```
# Falls back to grep-based extraction if the fenced block isn't present.

VERDICT_YAML="$(awk '/^```yaml$/{f=1;next} /^```$/{f=0} f' "$FC_VERDICT_FILE" | head -100)"

extract_field() {
  local key="$1"
  if [ -n "$VERDICT_YAML" ]; then
    echo "$VERDICT_YAML" | grep -E "^${key}:" | head -1 | sed -E "s/^${key}:\s*//" | tr -d '"' | tr -d "'"
  else
    grep -E "^[-*]?\s*${key}:" "$FC_VERDICT_FILE" | head -1 | sed -E "s/^[-*]?\s*${key}:\s*//" | tr -d '"' | tr -d "'"
  fi
}

VERDICT=$(extract_field "verdict")
NEXT_PHASE_DECISION=$(extract_field "next_phase_decision")
RESULT_VALUE=$(extract_field "result_2024_2025_funding_adj_from_100")

echo "[program_advance] phase=$FC_PROGRAM_PHASE verdict=$VERDICT next_decision=$NEXT_PHASE_DECISION result=$RESULT_VALUE"

# ---- 2. Enrich ledger row -----------------------------------------------
#
# Scheduler wrote the structural row; we patch in the parsed fields.

if [ -n "${FC_PROGRAM_LEDGER:-}" ] && [ -f "$FC_PROGRAM_LEDGER" ]; then
  python3 - <<PYEOF
import json, sys
path = "$FC_PROGRAM_LEDGER"
with open(path) as f:
    data = json.load(f)
if not data.get('phases'):
    sys.exit(0)
last = data['phases'][-1]
last.setdefault('phase', "$FC_PROGRAM_PHASE")
v = "$VERDICT"
n = "$NEXT_PHASE_DECISION"
r = "$RESULT_VALUE"
if v: last['verdict'] = v
if n: last['next_phase_decision'] = n
if r:
    try: last['result'] = float(r)
    except: last['result'] = r
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
fi

# ---- 3. Check program-level stop conditions ------------------------------
#
# These mirror the brief's safeguards but are re-checked here because the
# agent's next_phase_decision may indicate STOP-ship or STOP-ceiling.

PROGRAM_DIR="$(dirname "$FC_VERDICT_FILE")"
mkdir -p "$PROGRAM_DIR"

case "$NEXT_PHASE_DECISION" in
  STOP_ship|stop_ship|SHIP)
    SHIP_REPORT="$PROGRAM_DIR/program_ship_report.md"
    cat > "$SHIP_REPORT" <<EOF
# Program Ship Report

Program: $FC_PROGRAM_NAME
Final phase: $FC_PROGRAM_PHASE
Final result: $RESULT_VALUE
Verdict: $VERDICT

The model-alpha breakthrough was reached at phase $FC_PROGRAM_PHASE. Follow the
agent's verdict file at $FC_VERDICT_FILE for full context and recommended
live/paths.py update.
EOF
    echo "[program_advance] Wrote program_ship_report. Stopping program."
    exit 0
    ;;
  STOP_ceiling|stop_ceiling|CEILING)
    CEILING_REPORT="$PROGRAM_DIR/program_ceiling_report.md"
    cat > "$CEILING_REPORT" <<EOF
# Program Ceiling Report

Program: $FC_PROGRAM_NAME
Final phase attempted: $FC_PROGRAM_PHASE
Final result: $RESULT_VALUE
Verdict: $VERDICT

The model-alpha ceiling was reached. See findings_ledger.json for all phases
attempted and what was learned. Recommended next direction: execution alpha
(Track 2) and / or accept current production baseline.
EOF
    echo "[program_advance] Wrote program_ceiling_report. Stopping program."
    exit 0
    ;;
esac

# ---- 4. Generate next phase's brief --------------------------------------
#
# The default implementation calls codex to draft the next brief from the
# ROADMAP + ledger context. Customize this section for your program's
# specific brief generation logic.

# Extract a single leading phase letter generically. Accepts forms like
# "K", "k", "C_daily", "B_hourly" → first character upper-cased. This avoids
# the bug #9 cap where a hardcoded B-H case statement could not advance to
# I/J/K/... and falsely escalated.
NEXT_PHASE_LETTER=""
FIRST_CHAR="${NEXT_PHASE_DECISION:0:1}"
case "$FIRST_CHAR" in
  [A-Za-z]) NEXT_PHASE_LETTER="$(printf '%s' "$FIRST_CHAR" | tr '[:lower:]' '[:upper:]')" ;;
esac
# STOP_* / ship / ceiling decisions were already handled earlier; if somehow a
# STOP value reaches here, treat it as no-next (escalate) rather than launching
# a bogus "S" phase.
case "$NEXT_PHASE_DECISION" in
  STOP_*|stop_*|SHIP|ship|CEILING|ceiling) NEXT_PHASE_LETTER="" ;;
esac

if [ -z "$NEXT_PHASE_LETTER" ]; then
  echo "[program_advance] No recognizable next_phase_decision ('$NEXT_PHASE_DECISION'). Writing escalation."
  cat > "$PROGRAM_DIR/escalation_note.md" <<EOF
# Program Escalation

Phase $FC_PROGRAM_PHASE finished with an unrecognized next_phase_decision:
'$NEXT_PHASE_DECISION'.

The orchestrator could not determine which phase to launch next. A human
should review $FC_VERDICT_FILE and either edit findings_ledger.json or
manually launch the next phase.
EOF
  exit 0
fi

NEW_BRIEF="$FC_PROJECT_DIR/docs/task_brief.md"

# Build a generation prompt for codex; if codex isn't available, leave a
# template for human completion.
GEN_PROMPT="$(cat <<EOF
You are generating the next phase's task brief for a multi-phase research
program. Read these files for context:

  - ROADMAP: ${FC_PROGRAM_ROADMAP:-N/A}
  - Prior verdict: $FC_VERDICT_FILE
  - Findings ledger: ${FC_PROGRAM_LEDGER:-N/A}

Write the next brief to $NEW_BRIEF. The brief MUST:

  1. Start with a \`---\` YAML frontmatter block containing the same
     program: structure as the prior brief, but with phase: $NEXT_PHASE_LETTER
  2. Include terminal_states.phase_complete pointing at
     docs/master_research/phase_${NEXT_PHASE_LETTER}_verdict.md with the same
     floor (min_attempted_stages: 3, min_wall_minutes: 60)
  3. Re-use the same post_terminate_hook (this script)
  4. Describe Phase $NEXT_PHASE_LETTER's actual work based on the ROADMAP and
     informed by the prior phase's verdict ($VERDICT, decision: $NEXT_PHASE_DECISION)
  5. Do NOT embed shell commands for auto-orchestration — the framework
     handles that via the hook.

Output ONLY the brief content (which will be written to disk verbatim).
EOF
)"

if command -v codex >/dev/null 2>&1; then
  echo "[program_advance] Generating Phase $NEXT_PHASE_LETTER brief via codex..."
  codex exec --dangerously-bypass-approvals-and-sandbox -- "$GEN_PROMPT" > /tmp/program_advance_codex.log 2>&1 || {
    echo "[program_advance] codex invocation failed; see /tmp/program_advance_codex.log"
    echo "[program_advance] Skipping auto-launch. Next phase brief was NOT generated."
    exit 1
  }
  # Codex writes the file itself per the prompt. Verify it exists.
  if [ ! -f "$NEW_BRIEF" ]; then
    echo "[program_advance] codex finished but $NEW_BRIEF was not written. Skipping auto-launch."
    exit 1
  fi
else
  echo "[program_advance] codex CLI not found. Cannot auto-generate next brief."
  echo "[program_advance] Manually write $NEW_BRIEF and relaunch."
  exit 1
fi

# ---- 5. Spawn next phase as a new FlowCrew run --------------------------

UNIT_NAME="$(echo "${FC_PROGRAM_NAME}-phase${NEXT_PHASE_LETTER}" | tr 'A-Z_' 'a-z--')"

# Reset any failed/stale unit with the same name (so re-launch after a prior
# failed phase doesn't get blocked by leftover state).
systemctl --user reset-failed "${UNIT_NAME}.service" 2>/dev/null || true

CLEAN_PATH="/home/$(whoami)/.nvm/versions/node/v22.22.2/bin:/home/$(whoami)/.local/bin:/home/$(whoami)/anaconda3/envs/py312/bin:/home/$(whoami)/anaconda3/condabin:/usr/local/cuda-12.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Build the inline command. We don't depend on a wrapper file existing on disk.
NEXT_LAUNCH_CMD="cd '$FC_PROJECT_DIR' && /home/$(whoami)/.nvm/versions/node/v22.22.2/bin/node /mnt/d/Work/Code/Python/tb/flow-crew/dist/cli.js quick - --project '$FC_PROJECT_DIR' --campaign ${FC_PROGRAM_NAME} --max-iterations 100 --timeout 14400000 --supervise --adapter codex --no-inherit-campaign < '$NEW_BRIEF'"

systemd-run --user --unit="$UNIT_NAME" \
  --description="Program $FC_PROGRAM_NAME — Phase $NEXT_PHASE_LETTER (auto-launched by phase $FC_PROGRAM_PHASE)" \
  --setenv=PATH="$CLEAN_PATH" \
  --setenv=HOME="/home/$(whoami)" \
  bash -c "$NEXT_LAUNCH_CMD"

sleep 3
if systemctl --user is-active "$UNIT_NAME.service" >/dev/null 2>&1; then
  echo "[program_advance] Phase $NEXT_PHASE_LETTER launched as $UNIT_NAME.service"
else
  echo "[program_advance] WARNING: $UNIT_NAME.service is not active after launch. Check journalctl."
  exit 1
fi
