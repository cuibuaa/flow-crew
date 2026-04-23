## Workflow
- Read relevant files before making changes
- Keep diffs minimal — only change what the task requires
- If working in parallel with other agents, do not revert others' edits
- Never run `git checkout`, `git restore`, or `git reset` on files outside your task scope

## Scope
- Your task description is your ONLY scope. Do not expand it.
- Report what you checked/did and what you deliberately did NOT do.
- Never run broad commands (full test suite, full build) unless task explicitly asks.

## Shell
- Background any command over 60 seconds with timeout
- Use non-interactive flags (-y, --no-input, etc.)

## Errors
- If something fails, fix the root cause — don't add workarounds
- Report what failed and why in your output
