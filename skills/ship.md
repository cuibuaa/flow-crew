---
name: ship
description: Turn the current conversation into a self-contained FlowCrew brief, check it with setup, get explicit confirmation, and start the run. Use when the user asks to hand off or ship work to FlowCrew.
---
<!-- flowcrew-skill-revision: 69 -->

# Ship a conversation to FlowCrew

Use `/ship` in Claude Code or `$ship` in Codex. This procedure instructs the coding
agent; it is not an engine promise of model obedience. The run never sees this
conversation. Detailed facts live in the bundled [brief contract](../guide/brief-contract.md),
[CLI](../guide/cli.md) and [operations](../guide/operations.md).

## Author with the user

Inspect the selected project and original evidence. Use `flowcrew status` to inspect
existing work before proposing another run; it lists all runs in the selected store,
not just this project. Inspect an identified run with `flowcrew status <run-id>`.
Carry useful prior evidence into declared inputs and explain unknown state.

Write a self-contained brief at `docs/task_brief.md` with the user. Include the goal,
evidence paths, real constraints, outcome criteria, required products and what the
report must show. Leave approach and decomposition to the run; label illustrative
mechanisms as examples. Use the required frontmatter fields `criteria`, `inputs`,
`outputs`, `commands`, `results` and `allowBlocked`. Prose paths do not declare resources.
Declare gitignored inputs and intentional reuse of existing outputs. Freeze supplied
evaluators and evidence that must stay unchanged with structured `frozen: true` inputs.
Inputs otherwise require explicit `frozen: false`.

For research, state the baseline, measurement policy, evidence gaps and allowed
stopping results. Declare finite `results` labels when needed and decide whether
`allowBlocked` is permitted; a supported ceiling is not a metric win. Do not invent
missing author-owned facts. For engineering, require complete validation after the
last relevant write, with direct exits and totals in the report. Keep operator numeric
expectations separate from measurements. Apply the [evidence policy](../guide/brief-contract.md#evidence-authoring-policy)
and [verification principles](../guide/brief-contract.md#authoring-and-verification-principles).

## Check, show and confirm

Run against the saved brief from the selected project:

```bash
flowcrew setup docs/task_brief.md
```

Use `--project <dir>` if the source project differs from the current directory.
Correct refusals and review the complete result. Setup checks grammar and real host
readiness; it runs no declared command, prepares no exact resource grants and proves
no validation baseline or command feasibility. Those checks happen during start and
execution. Setup currently prints no brief digest; do not invent one or describe its
result as digest-bound approval.

Show the user the exact complete saved brief, setup's complete result and direct exit,
the source project, and any intended start options (`--backend`, `--config`, optional
`--requester`). Explain unattended shell access and the [platform limits](../guide/operations.md#platform-boundaries).
Ask for a **new explicit confirmation to start those exact saved bytes with those options**.
The original ship request or earlier approval of unseen text is insufficient. If brief
bytes, source or options change, repeat setup, display and confirmation. Wait for the
answer before starting.

## Start and follow the run

After confirmation, start the unchanged file with the displayed options:

```bash
flowcrew start docs/task_brief.md
```

Report the returned `run` id and operation result. A successful start is not task
acceptance. On an unknown outcome inspect status before retrying. Keep the run id;
status has no project selector. Optional `--requester <session>` binds frontend identity;
it is not required for launch and does not prove delivery. See [session integration](../guide/session-push.md).

Use `flowcrew status <run-id>` to inspect. Text `flowcrew guide <run-id> "text"` queues
context for the next author-side invocation without interrupting; reviewers never
receive it. `flowcrew cancel <run-id>` interrupts. `flowcrew resume <run-id>` continues
parked work using its original runtime pin; active resume is a no-op, terminal and
cancelled runs refuse. After a host restart continuation is manual. Follow
[operations](../guide/operations.md#inspect-guide-and-stop) for replacement plans and recovery.

## Verify and preserve

Read the terminal report, rejected reviews, command evidence and actual deliverables.
Assess every criterion and limitation independently; a status label, model summary or
zero CLI exit alone does not establish acceptance. Inspect the deciding code, query,
formula or instrument when results could look plausible while wrong. Reproduce defects
and characterize recurrence. Preserve failed or invalid evidence and unique work.

Once the result is independently accepted, `flowcrew land <run-id>` preserves declared
outputs; it is an operation, not a read-only audit. Inspect its result and preserve any
other unique files and raw evidence yourself before authorized
`flowcrew land <run-id> --reclaim`. Reclaim deletes workspace, scratch, runtime pin and
raw evidence after preservation succeeds; SQLite history and status remain. Terminal
status alone does not authorize deletion. [Preservation](../guide/operations.md#preserve-and-reclaim)
owns the full boundary.
