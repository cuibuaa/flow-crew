---
name: fc-status
description: Show the current project's latest FlowCrew run with the project-scoped CLI. Use when the user asks for FlowCrew status or invokes the fc-status workflow.
---
<!-- flowcrew-skill-revision: 4 -->

# Show project run status

Run from the user's selected project:

```bash
flowcrew status
```

Show the output as produced. Do not summarize or launch more commands for the normal skill.
The command selects the latest run for that project. For an explicitly cross-project request,
use the `--all` or `--project` selectors in the bundled
[CLI reference](../guide/cli.md#read-and-steer).
