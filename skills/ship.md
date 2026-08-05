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

For frontmatter and agent↔engine files, read and follow the repository's
[canonical brief and file contract](https://github.com/cuibuaa/flow-crew/blob/main/guide/brief-contract.md).
That guide is the single source of truth for `terminal_states`, `research`,
`program`, dispatch, round results, approvals, Reality-Gate checks, guidance,
verdicts, and terminal artifacts. Do not invent or maintain a second schema in
this skill.

Self-contained test: Could a developer who has never seen this conversation read the brief and know EXACTLY what to do? If not, add more detail.

### 1.1 Write criteria the gate cannot misread

The QA gate mechanizes your brief into assertions. It cannot tell a **property you
want proven** from an **example you used to explain it** — so an unmarked example
becomes a hard requirement, and a better implementation that satisfies the property
by other means gets rejected on the letter.

Observed: a brief said a probe "must contain" a specific import, meaning "use a realistic
load". The executor built something more faithful by other means and the gate failed it on
the missing literal — one gate round plus one repair round, for a wording slip.

- **State the property to prove, not the instrument to use.** "Prove the failure reproduces
  at production scale" — not "call `<specific function>`".
- **Mark examples as examples.** One line at the end —
  `> Everything in parentheses is illustrative, not a criterion` — prevents the whole failure mode.
- **If an exact means really is required, say so explicitly** ("this precise path is itself
  the criterion; alternatives are not accepted"). Then the gate is right to enforce it.
- **Watch for these shapes**: "must contain `<identifier>`", "must call `<API>`", "the source
  must have". `flowcrew rehearse` lints for them — treat its criterion warnings as blocking.

### 1.2 Put the boundaries in the brief, not in later guidance

A brief that omits its boundaries gets them added by `flowcrew guide` after a stage is
already running — late, and against a time budget the planner sized for the smaller job it
was shown. Observed: four requirements added to a running stage sized for fifteen minutes;
it timed out twice and consumed its retry budget without producing anything.

- Boundaries, counter-examples and "explicitly not acceptable" items belong **in the brief**.
- `flowcrew guide` is right for facts the executor cannot obtain, and for correcting your
  own error. Both are legitimate.
- **Research loops are different.** Steering on intermediate results is the point of a
  research campaign, not a symptom of a bad brief. This item is about engineering tasks
  whose scope should have been knowable up front.
- Rule of thumb for engineering tasks: a third guidance message to the same stage means the
  brief was incomplete. Consider stopping and re-shipping rather than continuing to steer.

### 1.3 Demand pre-fix evidence for stateful defects

**Applies to bug-fix tasks only** — a new feature has no "before" to demonstrate.
For scheduling, timing, concurrency, or state-machine bugs, a passing test after the fix
proves little — it may have passed before. Require both halves:

> Construct the failure on the **unfixed** code and show it fails; then show the fix makes
> it pass.

If the defect is deterministic, say so — it removes the excuse that reproduction is
impractical. If it is probabilistic, ask for a failure *rate* before and after instead of a
single pass/fail.

The same applies to mutation testing you ask for: a test going red is not sufficient
evidence that a guard is load-bearing. It may be red on a message-string assertion while
a second guard silently covers the behaviour. Ask for the isolating scenario —
"is there a case where **only** this guard protects us?" — and require it to be run.


### 1.4 Declare `terminal_states` only on files the LAST stage writes

`terminal_states` is not documentation — it is the condition on which the engine stops.
When a declared path appears with a fresh timestamp, the run reaches that terminal status
and **every stage still pending is skipped**.

So a path written by a mid-pipeline stage ends the run early. The failure mode is quiet and
expensive: the work gets done, the verification stage never runs, and the run reports a
terminal status nobody audited.

> Real case: a brief declared `complete: [docs/task_summary.md, docs/ui_selfcheck.md]` to
> silence a rehearsal reminder. The integration stage wrote both files, the run terminated
> 116 seconds later, and the QA gate plus its repair loop were skipped — on a 43-file,
> +1741-line change.

Before declaring one, ask **which stage writes this path**. If the answer is not the final
stage, prefer a different artifact. A `floor` is the fallback, and its two knobs are not
interchangeable:

- **`min_wall_minutes` alone is a hard gate** — the run cannot reach that terminal status
  before the elapsed time. This is the one that works for an engineering pipeline.
- **`min_attempted_stages` counts fresh files matching `stage_glob`** — inferred as
  `<dir of the first declared path>/stage_*_verdict.md` when you do not set it. **Nothing in
  the engine writes those files.** They exist only when the brief itself tells a stage to
  write them. Declare this floor without also requiring the files and the count stays at
  zero forever, so the run can never reach that status at all. If you use it, name the files
  in the brief and set `stage_glob` explicitly rather than relying on the inferred pattern.
- Setting both **demotes wall time to advisory**: once the stage count is met the floor
  passes regardless of elapsed time.

Measured: the last three engineering runs in this repository produced zero
`stage_*_verdict.md` files, and `flowcrew rehearse` still reports
`✓ terminal complete: … floor(stages≥3)` and `✅ Contract ready` — that ✓ proves the floor
**parsed**, not that it is **satisfiable**. Trading "terminates too early" for "can never
terminate" is not an improvement; it costs the whole budget and mislabels the terminal.

Silencing a rehearsal warning is not a reason to declare a terminal contract. A brief with
no `terminal_states` is a warning; a brief with the wrong one is a skipped gate — or a run
that cannot finish.

### 1.5 Do not let a task rewrite a shared accumulating record

If several tasks append to one file — a summary log, a changelog, a results table — say
explicitly that the task **appends** and must not restructure or truncate it, and require
the line count to be non-decreasing.

> Real case: a task rewrote a 2,547-line `docs/task_summary.md` down to 220 lines, keeping
> only its own section and dropping every prior task's recorded evidence. Two unrelated
> contract tests caught it precisely because they asserted that measurements recorded in
> that document stay present.

Where you control the layout, prefer one file per task over one shared file. A shared
append-only prose document is a single point of failure that every task can destroy, and
guarding it costs a test per fact you care about.

**Say "do not remove or restructure other records" — not "never edit a line".** The
stricter wording turns a protection into a prohibition on fixing your own mistakes.

> Real case: a task recorded a 40-character SHA that was not a Git object. Because the
> brief said the file was append-only and its line count must not decrease, the repair
> appended an erratum eighty lines later instead of correcting the claim where it was made.
> That was the honest response to the constraint as written — and a reader of that section
> still got the wrong hash.

Correcting a factual error in your own entry, in place, with a visible trace of what
changed, is what an audit trail is for. Quoting a known-bad value to explain a correction
is not a violation either — write the check as "no line presents a nonexistent commit as
real", not "this string must not appear".

### 1.6 If you ask for a census, say how the count will be used

A survey task returns a number: nine occurrences, eighteen files, three call sites. That
number is a measurement. It is not a plan, and it does not say which way it cuts.

A census counts one of two things, and only the author can say which:

- **Entries that *are* the gap.** Each one is separately visible to someone using the
  project, so the count *is* the todo list and driving it to zero is the goal.
- **Entries that are drift.** The shape is inconsistent but nothing observable fails, so the
  count is a *trigger*: keep the detector, and fix a family when it actually blocks a change
  or breaks something.

Ask of every entry: **if this stays, what does someone using the project see?** "Nothing,
today" is a legitimate answer, and it means the entry is drift.

> Real case: a systemic review sorted 33 defects into 7 mechanisms and gave each a
> re-runnable census. One mechanism measured 9 families at HEAD, so the follow-up generated
> 9 tasks and 25 hours, ordered `9 → 8 → … → 0`. Per-family checking found 2 live defects;
> the other 7 had no observable failure — and the same review had already measured that
> mechanism's historical rate at 9% and its stock as *net shrinking*. Across all 26
> generated tasks the budget was 74 hours, and roughly 31 of those bought nothing a user
> could see.

`N → 0` is measurable and "would anyone notice" is not, so ordering drifts to the measurable
side on its own. It has to be asked for.

**Do not invert this into "internal consistency does not matter."** Tested against those
same seven mechanisms, the rule "a census is a trigger, not a todo list" gives the *wrong*
answer for four of them — including the two highest-priority ones. Whether the project's own
defect record is auditable from a clone reads as internal bookkeeping, yet every untracked
entry is a reference a reader cannot open. A check that cannot prove the property it asserts
reads as tidiness, yet this project's entire claim is that it catches its own failures. **The
question decides each entry; the disposition does not carry over between mechanisms.**

**In the brief:** when the deliverable is a survey, require every item to state its
user-visible consequence, and require items with none to be listed as drift with a reason
they are or are not still worth fixing. Asked for, it gets answered; not asked for, the
output comes back ordered by mechanism completeness. The two review briefs here asked for
stock numbers and never once for consequence — the classification had to be added by hand
afterward.

### 1.7 Ask for the things the planner will not infer

The planner reads the brief and nothing else. Three separate defects this project paid for
turned out to be the same shape: something obvious to the author was never asked for, so it
never appeared. Two of them cost about ninety minutes per run until the brief said them out
loud, and the fix was a paragraph, not an engine change.

**Declare writable paths for every stage, including `plan` and every gate.** A verification
stage has to write probes to verify anything. Left unsaid, the planner gives gates a scope of
zero — six consecutive observations, no exceptions — and enforcement then rejects every write
the stage makes while the negotiation channel it could have used is not offered. The stage is
neither allowed to write nor told it may ask.

> Measured on three runs of comparable size. The first two said nothing about stage scope:
> 131 minutes, with the gate's first attempt discarded after 23.6 minutes on scope
> violations; then 93 minutes, with the gate violating on its second attempt and the run
> re-planning. The third asked for per-stage writable paths, the planner gave the gate
> thirteen: **37.6 minutes, one iteration, gate passed first time, repair stage skipped.**

Name what each stage needs — a verification stage usually needs `spec/<task>-*.test.ts` and
`tests/<task>-*.test.ts`. Those are examples; the property is that **no stage has to leave its
boundary to finish its own work.**

**Judge each task by its own result, never by a shared running total.** A criterion phrased as
a movement of a shared census — "the total goes from 3 to 2" — silently couples every task
that touches the same census into a strict chain, and it fails a task for something a sibling
did or did not do.

> Measured: seven tasks were generated with three of them asserting `3 → 2`, `2 → 1` and
> `1 → 0`. Launched alphabetically, the one expecting the total to already sit at 2 started
> while it was still 3. Its work could have been entirely correct and its stated criterion
> still unreachable. Rewritten as "my own family reaches zero, and the total is recorded for
> information", the seven became order-independent — which is what they always were in
> substance, since they touch different mechanisms.

**Require the full suite, not the targeted one.** Two tasks on the same day each reported
their targeted suites green — one of them four groups and fifty-odd assertions — while nine
tracked tests were red. Neither gate ran the whole suite, so neither could see it. Ask for
`npm run build`, the full `spec/` run, the UI build and lint, with exit codes and totals
pasted. And when reading an exit code, do not take `$?` after a pipe: that is the last
command in the pipeline, not the one you care about.

**The pattern behind all three:** the planner, the gate and a review task each answer what
they were asked and nothing more. §1.6 says the same thing about a survey that was never
asked for user-visible consequence. When something feels too obvious to write down, that is
exactly the thing that will not appear in the output.

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

## 2.5 Research-mode Detection (BEFORE confirming)

FlowCrew has two loop modes. Detect which fits and PROPOSE it (don't silently pick — the modes behave very differently):

- **`engineering`** (default): convergent. plan → execute → gate(pass/fail) → retry until green. For: build X, fix Y, implement Z.
- **`research`**: divergent. propose → implement → measure(vs baseline) → keep/drop + continue/stop. "Ceiling" (failing to beat target) is a VALID terminal. For: exploration, finding alpha, testing many directions, cumulative stacking, "until exhausted".

Heuristic — if the conversation has signals like: "explore / research program / find alpha / test directions / multi-stage / cumulative / stack / until regression / self-evolve / 直到用尽 / 多阶段" → flag as **likely research**.
(The non-English signals are deliberate: they match what a user actually types. They are input patterns, not user-facing text — do not "clean" them.)

If likely-research, in the confirm message propose:
> This looks like a research exploration (divergent — accepts "ceiling" as a valid outcome). Use `--workflow research`? It computes keep/drop + continue/ship/ceiling from a policy, so you don't hand-write decision tables. (Or `engineering` for convergent retry-to-pass.)

If the user picks research, the brief MUST include a `research:` frontmatter block that follows the canonical contract linked in step 1. If unsure, ASK — don't guess.

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
- Workflow: default | research (from step 2.5)
[Campaign hygiene note from step 2, if triggered]
[Research-mode note from step 2.5, if triggered]

Shall I proceed? You can edit the brief or adjust settings.
```

Wait for explicit approval. "Looks good", "yes", "ship it" = confirmed.
If user edits → incorporate changes and re-confirm.

## 4. Write and Execute

Once confirmed:
1. Write the brief to `docs/task_brief.md`. Use the canonical contract linked in
step 1 for every frontmatter field and runtime file instruction.

2. **Rehearse the brief BEFORE launching — REQUIRED, never skip.** Seconds, zero tokens; it runs the brief through the real scheduler against a scripted fake agent in an isolated temp project, so contract mistakes surface now instead of after hours of real agent time:

```bash
flowcrew rehearse docs/task_brief.md
```

The public [rehearsal reference](https://github.com/cuibuaa/flow-crew/blob/main/guide/rehearse.md)
defines what this proves and what it does not prove.

Rules:
- **Exit 0 (`✅ Contract ready`)** → proceed to launch.
- **Any `✗`** → FIX THE BRIEF AND RE-REHEARSE. Do not launch a brief with a failing contract; the run will burn real tokens and end in a mislabeled or unusable terminal.
- **Criterion-wording `⚠` lines** → FIX THE BRIEF AND RE-REHEARSE. `/ship` applies a stricter authoring policy than the transport layer: turn the requested instrument into the observable property, or explicitly say the exact means itself is the criterion.
- **Other `⚠` lines** → judgement call. Read each one; some are intentional (an engineering brief has no `research:` block; a pure-exploration brief may intentionally omit `stop.beat`). Say in the launch message which warnings you accepted and why.
- Engineering briefs are supported: static contract checks run, the research-loop simulation is skipped.
- Show the complete rehearsal report and its exact digest to the user. The approval in Step 3 happened before these findings existed and is not consent to ignore them.

3. **Obtain post-rehearsal consent when the report requires it.** If the report says
`Brief admission: explicit acknowledgement required`, name every intentionally retained
finding and its risk, then ask a new question:

> Rehearsal reported the findings above. Start this exact brief digest
> `<digest>` despite those findings?

Wait for a new explicit answer. Do not treat Step 3's “ship it” as this answer. If the user
edits anything, update `docs/task_brief.md`, return to rehearsal, and ask again for the new
digest. Only the answer after the final report authorizes the digest-valued launch flag.
When the report says no explicit acknowledgement is required, show that result and proceed
without manufacturing consent.

4. Ensure the orchestrator daemon is running, then submit as a background task:
```bash
# Bootstrap daemon if not already running. Idempotent (no-op if running).
flowcrew daemon status >/dev/null 2>&1 || flowcrew daemon start

# Submit as background — returns immediately with Task #<id>, daemon owns lifecycle.
# DEFAULT: --no-inherit-campaign keeps task IN a campaign (so dashboard + KG can track it)
#          but skips injecting stale prior-phase context into planner prompts.
flowcrew quick --background \
  [--acknowledge-brief-warnings=<CONFIRMED_DIGEST>] \
  --project . \
  --max-iterations <N> --timeout <MS> \
  --supervise \
  --no-inherit-campaign \
  [--campaign <name>] [--workflow research] \
  - < docs/task_brief.md
```

Omit the acknowledgement flag when the final rehearsal said it was not required. Include
it only after the distinct post-report answer above. Reading the file through stdin is
intentional: shell command substitution removes trailing newlines and would change the
exact digest that the user reviewed. `quick` independently inspects and prints the brief
again; a changed digest stops before registration or launch.

**Campaign behavior — read carefully**:
- DEFAULT (auto-attached): task joins `defaults.yaml::campaign` or `slug(basename(projectDir))` campaign. `--no-inherit-campaign` keeps the attachment but skips stale phase context. **Use this for almost all real work**.
- `--campaign <name>` to explicitly attach to a specific campaign (e.g. `--campaign ai-dialy-v7` for the v7 follow-up family).
- `--no-campaign` to FULLY DETACH (truly ad-hoc one-shot, NO campaign tracking, NO KG aggregation). Only use when the task is completely unrelated to any prior campaign work. Most tasks ARE related — default to attached.

Add `--workflow research` if step 2.5 selected research mode (and the brief has a `research:` block).

Capture the task id from the output line `Task #<id> registered. Unit: flowcrew-task-<id>.service`. Use it in step 5's report.

**Background semantics**: chat returns immediately. Daemon polls run lifecycle, restarts on crash (up to max_retries), updates task registry, writes tick log. No external monitor needed.

**Foreground fallback**: if user explicitly passes `--foreground` to `/ship`, or daemon fails to bootstrap, drop `--background` and run the blocking `flowcrew quick` variant.

### Apply the canonical contract

Use the [brief and file contract](https://github.com/cuibuaa/flow-crew/blob/main/guide/brief-contract.md)
when the brief needs any of these mechanisms:

- a research loop, target, stop policy, integrity rule, or independent confirm;
- an honest terminal artifact such as ship, ceiling, escalation, or phase completion;
- a multi-phase program and its safeguards;
- deterministic `## Reality checks`; or
- an approval-gated consequential action.

Do not encode those settings as prose or as a second schema in this skill. For
a consequential action, tell the operator in the launch message that the run
may park and can be resolved with `flowcrew inbox`,
`flowcrew inbox approve <id>`, or `flowcrew inbox deny <id>`.

The adapter (claude/codex) is auto-detected. Override with `--adapter claude` or `--adapter codex` if needed.

If `flowcrew` is not found, try: `npx flowcrew quick ...`

## 5. Report Back

Tell the user (substitute real task id captured from step 4):
```
Task shipped to FlowCrew daemon as Task #<id>.
- Check progress:    /fc-status            (or `flowcrew task list`)
- Inspect this task: flowcrew task show <id>
- Cancel if needed:  flowcrew task cancel <id>
- Dashboard:         http://localhost:3000
```

Workflow + adapter + supervise settings used in step 4 should be mentioned. Chat session is now FREE — daemon owns the run, no further blocking. User can close session and check later via `/fc-status`.

## 6. When it lands — accepting the run

The run's terminal status is **not** the acceptance verdict. Two independent things can
disagree, and both have been observed:

### 6.1 A failed terminal status can be a false negative

Read `<run dir>/.reality-gate.json` **first** — note the leading dot; `ls` will not show it.
`run.json` and the systemd journal only say *that* the gate blocked, not *which check* or
*why*. The dotfile carries every check with its `pass`/`advisory` flag and the failing
entry's `stdout`/`stderr` tails (ANSI-escaped — strip before reading).

Then **re-run the failing check's script yourself**, verbatim. Do not accept either side's
summary. Observed: a reality gate failed because two Vitest workers timed out spawning
under load — 110 files and 793 tests had passed, and an independent re-run was fully green.
The deliverable was sound; the gate was not.

If your re-run is green, the terminal status is a false negative: accept the work, but
record the false-negative mechanism and fold it into the next brief so it stops recurring.

**A green re-run does not by itself say which side flaked.** An environment flake (workers
starved of CPU, a port still in TIME_WAIT) and a nondeterministic deliverable both look like
"failed once, green on re-run". Before accepting, name the mechanism: if you cannot say *why*
the first run failed, you have not distinguished them.

> Real case: a negotiation test failed the gate and passed on re-run. The cause was not the
> harness — the code under test used a 60 ms budget with jitter of the same order, so the
> outcome was a coin flip. Accepting on the green re-run would have shipped a genuinely flaky
> test; the fix was to scale the constants tenfold so the assertion had headroom.

Cheap discriminator: re-run the failing check several times, not once. A deliverable that is
green 3/3 under the same load that failed it is an environment flake; one that is green 2/3
is telling you about itself.

**A stage can also fail without ever running.** Observed twice, both on the re-verification
that follows a repair stage: the attempt died in under two seconds with zero tokens and
`thread/resume failed: no rollout found for thread id …` — the adapter could not resume the
earlier session. The adapter's diagnosis table covers model and effort misconfiguration
only, so there is no fresh-session retry. Check the attempt's duration and token counters
before reading a failure as a verdict: ~2 s and no tokens is infrastructure, not judgement.

### 6.1b Check the instrument before believing the reading

When a probe is wrong you do not get an error — you get **a number that looks like a
finding**. Every one of these produced a confident, wrong conclusion that was acted on:

| What was written | What it actually returned |
|---|---|
| `cmd \| head -12` then reading the result | the verdict line was below the cut |
| `cmd \| head; echo $?` | `head`'s exit code, not the command's |
| `n=$(grep -c PAT f \|\| echo 0)` | `"0\n0"` when there are no matches — never equal to `"0"` |
| `pgrep -f "some string"` | the grep's own command line, so "still running" is always true |
| `s.get('gate')` on a record whose field is `is_gate` | `None`, indistinguishable from "no gate" |
| counting rows in an append-only registry | every historical row, not the current state |

The shape is always the same: **the failure mode of the measurement is silence, not an
error.** So before reporting a number that changes a decision, ask what this probe returns
when it is broken — and if that answer is "something plausible", verify it a second way.

Prefer a language with real data structures over a shell pipeline for anything whose
output you will reason about. Assert on the *rendered* or *served* artifact rather than
the source you believe feeds it: a screenshot review that inspected the fixture directory
instead of the screenshot missed real project names printed on the page.

### 6.2 A passing gate is not a substitute for reading the output

Gates check code and tests. When the deliverable is something a person will **read** — a
UI, a generated report, a document, CLI output — pull the actual text and read it, the way
you would review a document. Metric assertions (`errors: 0`, `focusable: 61`) cannot see
that the same sentence appears eleven times, that one list row is a 1,500-character essay,
or that a failed item with no artifacts is labelled "latest delivery".

If the deliverable is a UI, exercise it the way its users reach it. A headless run against
`localhost` is a different environment and its conclusions do not transfer — one page
measured 5.5 s cold-load headless and 371 ms over the real network path.

### 6.3 Read the deciding code before theorising about data

When a number looks wrong, find the function that computes it before forming a hypothesis.
Observed: three consecutive wrong guesses about why half of a project's runs reported
incomplete cost, all abandoned once the actual predicate was read — it required *every
attempt* to carry both token fields, not the stage-level totals that were being inspected.

Related: when an experiment returns a clean result, verify the instrument implemented the
variable you asked for. A probe that spawned bare `node -e "process.exit(0)"` processes
produced three green rounds for a hypothesis about jsdom initialisation it never tested.

## Operating constraints worth knowing

- **There is no task-level parallelism.** One run per project directory; the daemon defers
  the second with `defer_reason: project busy` and retries it automatically — do not
  re-ship. Parallelism exists only *within* a run, across stages with disjoint scopes.
- **Do not edit files in the project directory while a run is active** — including
  ignored directories like `docs/`. The engine attributes files changed inside the run
  window to the running stage, so your notes become that stage's "artifacts" — **and
  scope enforcement may restore them to their preimage.** Attribution comes from a
  snapshot diff, which cannot tell your edit from the stage's, so an edit outside the
  stage's declared scope is rolled back and nothing tells you it happened. Draft in a
  scratch directory and sync after the run terminates. Read-only inspection is fine.
- **Verification harnesses are not deliverables.** Probes that need environment variables, a
  browser, or the network tend to get left in the project's test tree, where they break the
  suite for everyone else. Say in the brief where such harnesses belong — the run directory
  is a good default — and check the working tree before accepting.
- **Long-lived processes hold old code.** `flowcrew daemon status` and
  `flowcrew dashboard status` report FRESH/STALE against the on-disk build and exit non-zero
  when stale. Rebuild and restart before shipping; a stale daemon silently runs yesterday's fixes.

## Variants

- `/ship --foreground` — bypass daemon, run blocking (legacy behavior; use only if daemon unavailable)
- `/ship --workflow engineering` — use the engineering workflow (includes QA gate + retry)
- `/ship --adapter claude` — force Claude adapter
- `/ship --adapter codex` — force Codex adapter
- `/ship --no-supervise` — disable supervisor brain (default is enabled)
- `/ship --no-inherit-campaign` — skip injecting prior-phase campaign context into planner prompts (use when task pivots from prior campaign direction)
- `/ship --keep-campaign-context` — force-keep prior context even if hygiene heuristic would suggest dropping it
