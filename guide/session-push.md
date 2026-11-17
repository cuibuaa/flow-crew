# Optional session integration

For operators distinguishing persistent run status from frontend notification.
Status remains available through [the CLI](cli.md#status-output) without a bound session.

## Status and session binding

Start accepts optional `--requester <session>`. The canonical Claude hook associates
`claude:<session-id>` with that calling session. Its explicit configuration supplies
absolute `storeRoots` and `tasksRoot`. It reads canonical `runs/<run-id>/status.json`
views, projects its own checklist entries and reports attention transitions. It does
not invoke the CLI, read SQLite, scan other session histories or control a run.

Checklist completion is a display of terminal engine state, not human acceptance.
Missing, invalid or unreadable snapshots stay unavailable. A bound requester and
`notification.session: bound` establish identity only; `transport: unobserved` is not
a delivery receipt. Inspect the actual terminal evidence before accepting results.

## Installation boundary

The skill installer bundles linked guides into each skill's `references/` directory
and registers the packaged `dist-rewrite/flowcrew-session.mjs` hook for Claude.
The selected Claude configuration directory owns `flowcrew-session.json` beside
`settings.json`. The registration passes that file's absolute path to the hook;
it declares `storeRoots` and `tasksRoot` and survives builds and npm upgrades.
Reinstallation preserves operator edits. Removal unregisters the hook and status
line while retaining that configuration for a later installation. Each Claude
configuration directory owns its own store/task selection, so separate clients do
not share mutable configuration inside the installed package.

Installation and removal retire the exact command formats written by the earlier
shared-shim and packaged-hook installers. Other hooks and user status lines remain.
The installer check verifies registration and file presence without starting a CLI
or provider. Installing skills does not prove live frontend delivery. Use explicit
`flowcrew status <run-id>` for inspection. `flowcrew doctor` tests the real host
sandbox; it does not verify frontend authentication.

Sources: [installer](../skills/install.sh), [registration](../skills/session-integration.mjs),
[canonical hook](../integrations/claude/flowcrew-session.mjs),
[wire decoder](../rewrite-src/contract/status.mjs).

When cutting over from the shared-hook installer, registration removal uses the exact
command recorded in `hooks/flowcrew-session.json`, including its original Node path.
That receipt stays through reinstalls so uninstall can restore its saved user status
line. A status line edited by the user after installation is preserved. Uninstall
consumes the receipt after publishing settings. Installs without a receipt use only
the closed historical command list; similar user commands are preserved.
