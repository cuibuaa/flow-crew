## Workflow
- Before running any build, test, or lint command, discover the project's toolchain by reading its config files (package.json, Makefile, Cargo.toml, pyproject.toml, etc.). Never assume which commands are available.
- When exploring code, prefer semantic tools (symbol search, go-to-definition, find-references) over text search. Use grep only for literal strings, config values, or non-code patterns.
- Read relevant files before making changes
- If a tech_solution.md exists in your run directory, read it first — it contains the planner's analysis and approach
- Keep diffs minimal — only change what the task requires
- If working in parallel with other agents, do not revert others' edits
- If a file edit fails because the content changed since you last read it (e.g. a parallel agent modified it), re-read the file and retry your edit against the current content
- Never run `git checkout`, `git restore`, `git reset`, `git clean`, or `git stash` on files outside your task scope
- Never use `git add .` or `git commit -a` — stage only the specific files you changed to avoid committing parallel agents' work
- Do not rely on `git diff` or `git status` to determine which files were changed by your task — other agents may have uncommitted changes to unrelated files. Use the stage artifacts list or your own knowledge of what you modified.

## Scope
- Your task description is your ONLY scope. Do not expand it.
- Report what you checked/did and what you deliberately did NOT do.
- Never run broad commands (full test suite, full build) unless task explicitly asks. A targeted compile/build check to verify your changes is always acceptable.

## Shell (applies only to agents with shell access)
- Set an explicit timeout on any command that might take over 60 seconds or hang (e.g. `timeout 60 <cmd>`)
- Use non-interactive flags (-y, --no-input, etc.)
- Never run commands that block waiting for user input (e.g. interactive installers, editors, REPLs without -e)
- Never start long-running background processes (servers, watchers, daemons) — they outlive your stage and leak resources
- Never use sudo or elevated privileges
- Do not install new dependencies (npm install, pip install, etc.) unless the task explicitly requires it. Adding packages changes lock files and can break parallel agents' work.
- When a command may produce very large output, redirect it to a file and read only the relevant parts (e.g. `cmd > /tmp/out.log 2>&1; tail -100 /tmp/out.log`). Unbounded output can exhaust your context window.

## Errors
- If something fails, fix the root cause — don't add workarounds
- If an approach has failed twice, step back and try a fundamentally different approach instead of making incremental patches
- Report what failed and why in your output

## Output
- Keep your output concise — downstream agents only see ~8000 characters of your output as context (beginning + end preserved, middle truncated). Put the most important information (decisions, file paths, warnings) early, and write a clear handoff note at the end.
- When reading upstream stage results, read the verdict file first (small, structured) before reading the full stage output (may be very large). Verdict files follow the pattern `{run_dir}/verdict_<gate_id>.json`. The verdict file contains the actionable summary.
- If your prompt starts with "RETRY (attempt N):", a previous attempt timed out. Read the partial output at the path given and continue from where it left off — do not start over. If the previous output is empty or contains only an error message, treat it as a fresh start.
- If your prompt starts with "RETRY FIX (attempt N):", a previous fix attempt did not resolve all gate failures. Read the gate verdict and QA output referenced in the prefix BEFORE reading your own previous output. Focus on what's still failing, not what was already fixed.
- On the first execution of a validation/gate stage, audit as exhaustively as you can across every dimension you can identify, including risks the brief did not anticipate. End the output with your own validator-owned Coverage Map: each aspect examined, its reproducible evidence/command, its conclusion, and anything you could not examine with the reason. This map is your audit product, not a checklist supplied by the planner.
- If your prompt starts with "RE-EVALUATION (round N):", continue the same gate after a repair. Reproduce every rejected item, run all task/project mechanical regression suites, and re-run every prior Coverage Map check touched by the complete round diff. Do not rely on the repair summary or a prior passing conclusion as evidence, and do not expand into unrelated audit dimensions during re-evaluation.
- When reading large source files, read only the relevant sections (specific line ranges or functions) rather than the entire file. Use symbol search or document symbols to locate the code you need first.

## Verification
- After making changes, verify they work (compile, lint, or run relevant tests) before finishing
- If verification fails, fix the issue — do not leave broken code
- If a build or compile error occurs in a file you did NOT modify, it may be caused by a parallel agent's in-progress work. Report the error in your handoff note but do NOT modify files outside your task scope to fix it. Only fix errors in files you changed.
- Clean up any temporary test files or scripts you created during verification

## Research test stability
- A research test must never load, assert the existence of, or pin a label in the campaign's mutable latest-round result or its no-candidate sidecar. Those shared slots legitimately change every round. Use the scheduler-resolved immutable round evidence or the framework-owned run manifest supplied in the stage prompt instead. This rule applies to every role that writes tests, not only the planner.

## Safety
- Never modify files outside the project directory except at explicitly authorized task-local run paths and the operating system temporary root for ephemeral evidence. All other external paths remain read-only unless the task explicitly grants a narrower write target.
- Never read or expose secrets (.env, credentials, API keys) in output
- Run-directory mutation is always confined to this task: never write, move, delete, or otherwise modify any run directory other than this task's own run directory. This prohibition is absolute; read authorization never grants mutation authority.
- By default, do not read, browse, or list other `.fc/runs/` directories. If the task brief explicitly authorizes a bounded set of other runs as read-only evidence, that task-specific authorization governs all default read, browse, and list restrictions elsewhere in this agent prompt for that evidence only. It grants no permission to write, move, delete, or modify those runs.

## Project-Agnostic Rules
- Never hardcode file paths, directory names, or tool commands that are specific to one project
- Use the project's own build, test, and lint commands — discover them from config files (package.json, Makefile, Cargo.toml, pyproject.toml, etc.)
- Refer to directories by their purpose ("the project's test directory", "the source directory") not by assumed names
- Do not assume a specific language, framework, or toolchain unless you have confirmed it by reading the project
