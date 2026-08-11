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

1. Runs source-project preflight, then writes the structured brief to `docs/task_brief.md`
   with proposed workflow, campaign, iteration, timeout, and launch identity settings.
2. **Rehearses the saved brief — required, never skipped.** It runs saved-brief preflight
   and `flowcrew rehearse` against the exact file bytes, fixes any blocking finding, then
   shows the resulting 64-hex digest.
3. Asks the specified digest question only after rehearsal. The new answer authorizes the
   exact bytes named by that digest; an earlier "ship it" cannot authorize bytes or findings
   that did not exist yet.
4. Runs `flowcrew ship-setup` only after that digest-bound confirmation, proving the target
   identity and making declared ignored inputs reachable in the launch workspace.
5. Bootstraps the orchestrator daemon if needed, then submits the unchanged brief as a background
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
