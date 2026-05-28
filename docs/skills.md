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

1. Summarizes the discussion into a structured brief.
2. Proposes settings such as workflow, campaign, iteration limit, and timeout.
3. Asks for confirmation.
4. Writes the task brief.
5. Launches `flowcrew quick`.
6. Reports the run id and status.

Recommended usage:

```text
Discuss the implementation plan in Claude Code.
Confirm constraints and acceptance criteria.
/ship
```

With the default config, FlowCrew executes through Codex unless the brief, flags, or role config override the adapter.

## `/fc-status`

`/fc-status` checks the latest FlowCrew run and summarizes progress, stage status, and next actions.
