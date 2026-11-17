# CLI reference

For operators choosing a command. Use `flowcrew` from an installed package, or
`node dist-rewrite/cli.js` after a local build. `flowcrew --help` prints the public
syntax. Angle-bracket values below are placeholders. Detailed lifecycle and authority
belong to [operations](operations.md).

## Setup and start

| Command | Behavior |
|---|---|
| `flowcrew setup <brief> [--project <dir>]` | Parse the saved brief and test real host sandbox readiness |
| `flowcrew start <brief> [--project <dir>] [--backend codex\|claude] [--config <file>] [--requester <session>]` | Pin the runtime, prepare isolated work and launch; print `run` and `operation` |
| `flowcrew doctor` | Perform a benign real sandbox launch and print diagnosis and host fix |

The project defaults to cwd. Start's backend defaults to the first configured role;
configuration defaults to the installed package's `config/runtime.json`. `--config`
selects a runtime JSON file for the new run. `--requester` is optional frontend
identity, not a launch prerequisite. Brief input is a file path, not stdin.

Setup prints JSON with `brief`, `project`, `readiness`, declared command IDs in
`commands`, and `detail`. It prints no digest. It neither runs brief commands nor
prepares exact input/output grants. Start checks grants and input/output dispositions;
command feasibility is established at runtime. Setup success proves neither that a
required command can run nor that implementation or validation passed.

## Read and steer

| Command | Behavior |
|---|---|
| `flowcrew status [<run-id>]` | Inspect one run, or list all run directories in the selected store |
| `flowcrew guide <run-id> <text> [--plan <file>]` | Queue author context without interrupting; optionally propose a replacement plan |
| `flowcrew cancel <run-id>` | Record cancellation and interrupt the recorded process group; safe to repeat |
| `flowcrew resume <run-id>` | Continue parked work using the original runtime pin; already active is a no-op |
| `flowcrew land <run-id> [--reclaim]` | Preserve outputs; optionally reclaim workspace, pin and raw evidence |

There is no project filter for status. Controls take the exact `run` id printed by
start. Text guidance reaches the next author-side invocation in commit order, once;
independent reviewers never receive it. `--plan` reads a JSON plan and requires no
open attempt; see [protocol](agent-protocol.md#scope-and-plan-revisions).
Terminal or cancelled runs refuse guide and resume. After restart use the resume
command printed in status. [Preservation](operations.md#preserve-and-reclaim) explains
land's effects; land without reclaim is not a read-only audit.

## Status output

An explicit id emits the status object. With no id, stdout is a JSON array of Result
objects (`{ok: true, value: ...}` or `{ok: false, kind, detail}`), one per run directory,
sorted by directory name. Inspect failures in that array; an empty array means no run
directories were found in this store.

| Field | Meaning |
|---|---|
| `run`, `identity`, `journalCursor`, `statusSince` | Run/pin authority and committed event positions; statusSince is a cursor, not a timestamp |
| `status`, `currentStage`, `stopReason`, `attention` | Lifecycle, active stage and why operator attention is needed |
| `backstop` | C2 rule, gate/failure suffixes, best pass count and continuation segment |
| `step` | Current start time and elapsed milliseconds, nullable when unavailable |
| `usage` | Known/partial/unknown usage, invocation count, active duration, available token/cost facts and raw references |
| `host`, `authority` | Readiness and interpreted resource grants/settings when recorded |
| `notification`, optional `requester` | Session binding; transport is unobserved, not proof of delivery |
| optional `interruption` | `interrupted by restart` with the exact manual resume command |
| optional `reclaimed` | Reclamation time and retained delivery location |

Status is an inspection operation; it refreshes the derived `status.json` view without
advancing execution. It exits zero for valid inspection of failed/cancelled runs.
Unknown or partial usage must remain visibly unknown or partial.

## Exits and storage

Successful operations normally emit JSON; doctor prints text. Exit 0 means the
operation succeeded, not that the deliverable passed. Exit 1 is conflict/refusal or a
reported unsuccessful operation; 2 is invalid input; 3 is unavailable, unknown or
`not_confirmed_closed` or in-progress. Inspect stdout/stderr and current status before retrying an uncertain
operation. Unit entry returns a parked conclusion with exit 3 when no closure/claim obligation
is open, including accounting-only attention; an open closure/claim obligation on
non-final work is a refusal (1). Final entry returns the retained
conclusion even with cleanup attention: completed work exits 0, failed or cancelled
work exits 1. A top-level unexpected CLI exception exits 2. Repeated cancel of ended work,
resume of active work, and successful reclaim reruns are idempotent successes.

[Configuration](configuration.md#storage-and-runtime) owns storage defaults and overrides.
Sources: [public parser](../rewrite-src/ops/main.ts), [entry](../rewrite-src/cli.ts),
[status decoder](../rewrite-src/contract/status.mjs).
