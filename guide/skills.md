# Agent Skills

FlowCrew ships agent skills so you can hand off work from an active Claude Code or Codex conversation.

## Install

```bash
./skills/install.sh
./skills/install.sh --claude
./skills/install.sh --codex
./skills/install.sh --project
```

With no agent selector, the installer considers both CLIs. It uses `command -v` and installs
only agents that are present; each absent CLI is explicitly skipped with its real install
command (`npm i -g @openai/codex` or `npm i -g @anthropic-ai/claude-code`). A successful
Claude copy is byte-verified. A successful Codex copy is additionally enumerated through
Codex's no-token `skills/list` API.

Global targets are `~/.claude/commands/{ship,fc-status}.md` for Claude Code and
`~/.agents/skills/{ship,fc-status}/SKILL.md` for Codex. `--project` uses the corresponding
`.claude/commands/` and `.agents/skills/` folders in the current project. Run
`flowcrew doctor` to detect a missing, locally changed, or older installed copy and get a
pasteable repair command.

## `ship`: `/ship` in Claude Code, `$ship` in Codex

Invoke `/ship` in Claude Code. In Codex, invoke `$ship` or select `ship` from `/skills`.
The same skill then turns the current conversation into a FlowCrew task:

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

In Codex, replace the last line with `$ship`.

With the default config, FlowCrew executes through Codex unless the brief, flags, or role config override the adapter.

## `fc-status`: `/fc-status` in Claude Code, `$fc-status` in Codex

The status skill runs `flowcrew status`. Invoke `/fc-status` in Claude Code or `$fc-status`
in Codex (it is also selectable from Codex's `/skills` list).
