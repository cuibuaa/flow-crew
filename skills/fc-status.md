---
name: fc-status
description: Show the current project's latest FlowCrew run with the project-scoped CLI. Use when the user asks for FlowCrew status or invokes the fc-status workflow.
---
<!-- flowcrew-skill-revision: 2 -->

# fc-status — Check FlowCrew run progress

Show the current status of the latest FlowCrew run for the current project. The command is
project-scoped by default, so it will not surface a newer run from another workspace.

## Steps

Run this single command:
```bash
flowcrew status
```

That's it. Show the output to the user. Do NOT run additional commands or attempt to summarize — the output is already formatted.

For an explicitly cross-project operator query, the CLI also supports `flowcrew status --all`
and `flowcrew status --project <path>`; this skill's normal invocation remains project-local.
