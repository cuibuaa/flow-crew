# CLI reference

For operators choosing a command. Use `flowcrew` from an installed package, or
`node dist-rewrite/cli.js` after a local build. `flowcrew --help` prints the public
syntax. Angle-bracket values below are placeholders. Detailed lifecycle and execution boundaries
belong to [operations](operations.md).

## Setup and start

| Command | Behavior |
|---|---|
| `flowcrew setup <brief> [--project <dir>] [--backend codex\|claude] [--config <file>]` | Inspect declarations, input/output facts and effective settings without launching programs |
| `flowcrew start <brief> [--project <dir>] [--backend codex\|claude] [--config <file>] [--requester <session>]` | Pin the runtime, prepare a per-run project copy and launch; print `run` and `operation` |

The project defaults to cwd. `--backend codex|claude` chooses the backend for every role of the
run; without it, the run's backend is the first configured role's. Configuration defaults to the installed
package's `config/runtime.json`. `--project`, `--backend` and `--config` mean the same for setup and start,
so setup previews the run the same arguments would start. `--config` selects a runtime JSON file for setup
admission or the new run. `--requester` is optional frontend
identity, not a launch prerequisite. Brief input is a file path, not stdin.

Setup reports the brief path and exact `briefDigest`, selected project, declared command
IDs, the `interpretation` lines (the run-limit rule, a `Role <id>: backend=..., model=..., effort=...`
line per role with where each value came from, and a deferred note per command) and the
host-rights execution boundary. It checks input and output facts and refuses on mismatch,
but prints no content measurements.

Setup takes the same `--backend` as start, so its role preview shows the backend, model and effort
the run will use (the model and effort that `default` resolves to depend on the backend). Use one backend
for all roles of a configuration: a role configured with a different backend from the run's is refused
when that role is first invoked.
Setup and start use the same preparation owner with the same selected configuration.
Retired declaration keys produce the [parse advisory](configuration.md); original brief
bytes and digest remain unchanged. Setup creates no run or runtime pin and runs no
provider or declared command. Execution establishes command feasibility. Setup success
proves neither that a required command can run nor that implementation or validation passed.
The former sandbox diagnostic command has been removed; setup owns declaration inspection
and actual launches report process errors.

## Read and steer

| Command | Behavior |
|---|---|
| `flowcrew monitor [--port N] [--host H] [--store-root DIR ...]` | Serve the GET-only dashboard; print its URL (default `http://127.0.0.1:8795`) |
| `flowcrew status [<run-id>]` | Inspect one run, or list all run directories in the selected store |
| `flowcrew guide <run-id> <text> [--plan <file>]` | Queue author context without interrupting; optionally propose a replacement plan |
| `flowcrew cancel <run-id>` | Record cancellation and close everything the run started (a cgroup scope on Linux with a systemd user session, otherwise the process group plus an invocation-marker scan; see [platform boundaries](operations.md#platform-boundaries)); safe to repeat |
| `flowcrew resume <run-id>` | Continue parked work using the original runtime pin; already active is a no-op |
| `flowcrew land <run-id>` | Preserve the declared outputs (reviewed or unreviewed, including cancelled work), then delete the project copy, runtime pin, work root and raw evidence. Takes no options; needs an ended run |

Monitor uses the same default store as the CLI. Repeat `--store-root DIR` to read
multiple stores; supplying roots replaces the default. Stop the foreground server with
Ctrl-C. The dashboard is read-only; act in the owning Claude Code or Codex session.

There is no project filter for status. Controls take the exact `run` id printed by
start. Accepted text guidance is offered to a running Claude author through its native
stream-json input on the existing five-second observation cadence; the Codex adapter refuses
mid-turn steering, so a Codex author receives it at its next invocation. Refused or ended steering stays pending for the
next author input. A guide shows `pending` until the invocation that received it ends and
`delivered` after that; a Claude author can have read it hours earlier. If only review
remains, the affected author continues before a fresh review can establish delivery.
Independent reviewers never receive guidance. `--plan` reads a JSON plan and requires no
open attempt; see [protocol](agent-protocol.md#scope-and-plan-revisions).
Terminal or cancelled runs refuse guide and resume. After restart use the resume
command printed in status.

Land is not a read-only audit: it preserves the declared outputs and then deletes the project
copy, runtime pin, work root and raw evidence. It refuses a run that has not ended; a pending,
running or parked run (including one marked interrupted) must be cancelled first. Its
result reports `state` (`reclaimed`, `partial` or `unknown`), the `outputs` receipt and `delivery`;
`partial` means preservation failed and nothing was deleted (exit 1); `unknown` exits 3. Repeating land after
an interruption finishes the deletions. [Preservation](operations.md#preserve-and-reclaim)
explains the details.

## Status output

An explicit id emits the status object. With no id, stdout is a JSON array of Result
objects (`{ok: true, value: ...}` or `{ok: false, kind, detail}`), one per run directory,
sorted by directory name. Inspect failures in that array; an empty array means no run
directories were found in this store.

| Field | Meaning |
|---|---|
| `run`, `identity`, `journalCursor`, `statusSince` | Run/pin authority and committed event positions; statusSince is a cursor, not a timestamp |
| `status`, `currentStage`, `stopReason`, `attention` | Current availability, active stage and why operator attention is needed |
| `journalStatus` | The committed workflow lifecycle, separate from current controller availability |
| `focus` | The stage to look at, decided from journal facts: the running stage, the stage a parked run stopped at, or a stage needing correction; `null` when none. It can be set when `currentStage` is `null` |
| `gates` | Recorded gate verdicts: `stage`, `attempt`, `scope` (`progress` or `delivery`), `outcome`, the answer reference, its journal `cursor` and the optional `result` label |
| `backstop` | C2 rule, gate/failure suffixes, best pass count and continuation segment; optional v4 `pausedAt` retains the recorded backstop park time |
| optional `checkpoints` (v4) | Count of safe saved checkpoint records and latest save time (`latestAt`); a run starts at count 0 with null time; projections older than this field omit it |
| optional `attention.cause` (v4) | `resume_refused` recorded by the activation parking owner when resume preparation fails before workflow entry; never inferred from detail text |
| `step` | Declared command ID or author/plan/gate attempt in `label`, start time and elapsed milliseconds; nullable when unavailable |
| `usage` | Known/partial/unknown usage, invocation count, active duration, available token/cost facts and raw references |
| `host`, `authority` | Observed host availability, execution boundary, declared content facts and effective settings when recorded |
| `notification`, optional `requester` | Session binding; transport is unobserved, not proof of delivery |
| optional `interruption` | `interrupted` or `interrupted by restart` with the exact manual resume command |
| optional `reclaimed` | Reclamation time (`at`) and retained delivery location (`delivery`), present once land has deleted the run's bytes |
| optional `heldBytes` (v4) | Bytes an ended run that has not been landed still holds: the sum of file sizes (not disk blocks, hard-linked files once) of the project copy, runtime pin, work root and raw evidence, which is exactly what land deletes. Measured when the end is first published, then carried unchanged. Absent while the run has not ended and after land. The dashboard shows it per run and as a total |
| optional `title` (v4) | Declared brief frontmatter `title`, otherwise its first `# ` heading; absent when neither exists. The dashboard falls back to the first 16 characters of the run ID. |
| optional `stages` | Current-plan stage definitions in order, then replaced definitions. Each includes purpose, role, dependencies, goal, full instruction, commands, revision, execution state, engine-attempt count, last ending, verdict and nullable recorded start/settlement times. `replacedBy` marks a historical definition without erasing its execution. |
| optional `stages[].segments` | Recorded invocation and pause intervals: `kind`, nullable `startedAt` and `endedAt`; attempt intervals also carry engine `attempt`, `invocation` and recorded `ending` when settled. Historical aggregate intervals may carry `elapsedMs` from the measured step, so reading later does not extend recorded time. Continuations share an attempt ID; `attempts` counts distinct engine attempts. `startedAt: null` means an older projection did not retain the try time; an `ending` still records its outcome. |
| optional `stages[].summary` | The stage's own work summary or review reason, verbatim; no run-level summary substitution. |
| optional `stages[].commandProgress` | For a running gate, its declared command IDs with addressed reservation/receipt states: `passed`, `running`, `not_started`, `failed` or `unfinished`. Satisfied results retain this field after settlement, with `source` naming stage, attempt, invocation and result tree. Earlier invocations also have `reused: "reused from <stage/attempt>"` as a display label. A command whose latest receipt exited non-zero also carries `basis`: `pre-existing` when the same command also fails on the run's unmodified base (it does not block acceptance), otherwise `introduced`; see the [brief contract](brief-contract.md#required-commands-that-already-fail-on-the-base). |
| optional `guidance` (v4) | Each accepted guide's `guide` ID and `state` (`pending` or `delivered`); delivered entries identify the author `invocation` (`run`, `stage`, `attempt`, invocation number). Delivery is confirmed by the receiving invocation's recorded receipt, whether sent in initial input or through native steering, and the receipt is written when that invocation ends: a guide stays `pending` until then even if Claude echoed it earlier. If the invocation dies before its receipt, the guide stays pending and is sent again. Delivery does not prove the requested change was made. |
| optional `activity` (v4) | The latest execution `invocation` per author or gate stage or declared command: `source` (`author`, `gate` or `command`), `stage`, optional declared `command` ID, `state` (`current` or `ended`), nullable `lastEventAt`, `lastTool`, `summary`, and `toolRunning`. `observation` is `unknown`, `observing`, `progress` or `quiet`. Only recorded tool events or command stream modification times set `lastEventAt`; provider chatter and controller polls never do. Ended records retain observations; they do not claim current progress. |
| optional `activity[].notice` (v4) | One advisory `cursor` and `message` per quiet episode. This cursor identifies a row in the activity table, independently of `journalCursor`. A relevant event clears it; a later quiet episode has a new cursor. A current quiet record reaches the dashboard's attention display and the session notice projection. Lifecycle `attention`, `stopReason` and execution policy stay unchanged. |
| optional `commandActivity` | Compatibility view of open engine-command observations; historical journal rows retain their quiet notices. New advisory notices appear only in `activity`, so older readers never confuse their IDs with journal cursors. New consumers read `activity` for author, gate and command facts together. Activity uses an advisory SQLite table outside the decision journal; a failed activity write is logged and ignored. |
| optional `plan` | Current `revision` and `pending` plan definitions, suitable for guidance; attempted definitions cannot be changed by human guidance. |
| optional `startedAt`, `lastActivityAt`, `endedAt` | Recorded run start, latest committed fact time and lifecycle end. Publication/poll time does not advance activity. No age implies a stuck verdict. |

New status snapshots use `status.json` v4. The file decoder also reads historical
v2/v3 displayed snapshots under their original contract. An absent focus uses their recorded `currentStage`; an explicit focus (including `null`) is preserved. Aggregate stage start/settlement times, or the running step start and measured elapsed time, become stage intervals in this one decoder; no per-attempt times are invented. The publisher
alone writes journal facts to this file. CLI status/list republishes those facts from
the journal, then applies a read-only availability overlay to stdout. The monitor and
session hook read v4 files and apply the same overlay without writing it back.
Historical v2 retains recorded availability; v3 still observes the controller, but
its already-displayed stage values are read directly, without a second stage overlay.
Journal-only v3 files written by development builds are not supported; no released engine wrote them.
A static file is a timestamped publication, not continuous liveness proof.

Controller availability and recorded-group closure are separate: a dead controller can
leave a live owned group. `host.activation` carries the controller identity and its
active/inactive/unknown observation with `checkedAt`. For v3/v4, public readers show a dead
controller as `interrupted` and unavailable observation as `unknown`; the producer file
can still say `running`. Historical v2 files keep their recorded availability; a changed
recorded boot exposes `interrupted by restart` when continuation is eligible.
`journalStatus` retains the committed lifecycle; `statusSince` is its journal cursor.
Displayed stage states belong to public output and historical v2/v3 files; v4 files
carry journal stage dispositions. New output for a run that is not running has no
current stage or step. Historical files may retain a parked current stage. Continuation is
manual. Status exits zero for valid inspection of failed/cancelled runs.
Unknown or partial usage must remain visibly unknown or partial.

## Exits and storage

Successful operations normally emit JSON. Exit 0 means the
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
