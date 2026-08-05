# Agent Skills

FlowCrew ships agent skills so you can hand off work from an active Claude Code or Codex conversation.

## Install

```bash
./skills/install.sh
./skills/install.sh --claude
./skills/install.sh --codex
./skills/install.sh --project
```

`--project` installs into the current project's `.claude/commands/` and `.codex/commands/` folders.

## `/ship`

`/ship` turns the current conversation into a FlowCrew task:

1. Summarizes the discussion into a structured brief and proposes settings such as
   workflow, campaign, iteration limit, and timeout.
2. Asks for confirmation, then writes the brief to `docs/task_brief.md`.
3. **Rehearses the brief — required, never skipped.** `flowcrew rehearse` runs it
   through the real scheduler for free before anything is launched. A failing contract
   or a criterion-wording warning sends the skill back to fix the brief and rehearse
   again; it does not launch a brief rehearsal flagged as broken.
4. If rehearsal reports a consequential finding the brief still carries, asks a second,
   separate confirmation naming that finding — the earlier "ship it" is not treated as
   consent to findings that did not exist yet when it was given.
5. Bootstraps the orchestrator daemon if needed, then submits the run as a background
   task with `flowcrew quick --background`. The daemon owns the run from there; the
   skill does not block on it.
6. Reports the task and run id, and how to watch or steer it.

The skill follows the public [brief and file contract](brief-contract.md) for
frontmatter, approvals, Reality-Gate checks, and runtime artifacts; that guide
is the single source of truth for the schema.

Recommended usage:

```text
Discuss the implementation plan in Claude Code.
Confirm constraints and acceptance criteria.
/ship
```

With the default config, FlowCrew executes through Codex unless the brief, flags, or role config override the adapter.

## `/fc-status`

`/fc-status` checks the latest FlowCrew run and summarizes progress, stage status, and next actions.
