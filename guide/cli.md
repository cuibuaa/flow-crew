# CLI reference

For operators choosing a command. `flowcrew --help` prints the public syntax.
Install the command with the [getting started](getting-started.md) instructions.
Angle-bracket values below are placeholders. Detailed lifecycle and execution boundaries
belong to [operations](operations.md).

## Setup and start

| Command | Behavior |
|---|---|
| `flowcrew setup <brief> [--project <dir>] [--backend codex\|claude] [--config <file>] [--requester <session>]` | Admit a run, pin its runtime and prepare its project copy; print `run` without launching work |
| `flowcrew start <run-id>` | Launch exactly the record returned by setup; print `run` and `operation` |

The project defaults to cwd. `--backend codex|claude` chooses the backend for every role;
without it, the run uses the first configured role's backend. Configuration defaults to the
installed package's `config/runtime.json`; `--config` selects another runtime JSON file.
`--requester` is optional frontend identity, not a launch prerequisite.
Brief input is a file path, not stdin. All options above belong to setup; start takes only
the returned run id and never rereads the brief file.

Setup reports `run`, the brief path and SHA-256 `briefDigest`, selected project, declared
command IDs, effective role settings and the host-rights execution boundary. It executes
no provider or declared command and establishes no validation result. Review this result
before starting. To change the brief, project or options, cancel and land the prepared run,
then run setup again. A prepared but unstarted run can be cancelled and landed.
Setup failures that created a record report its run id for inspection and cleanup.
If creation cannot be confirmed, setup reports the attempted id as unconfirmed, retains
its directory and exits 3. Inspect status when the store is readable; cancel and land a
confirmed record. Do not retry creation into that address or delete it as an empty attempt.
Setup preserves the failure class: invalid input exits 2, conflict exits 1, and
unavailable or unknown exits 3, including failures after creation.
Retired declaration keys produce an advisory on stderr ([configuration](configuration.md)).
Use one backend for all roles of a configuration: a role configured with a different backend
from the run's is refused when that role is first invoked.

## Read and steer

| Command | Behavior |
|---|---|
| `flowcrew monitor [--port N] [--host H] [--store-root DIR ...]` | Serve the GET-only dashboard; print its URL (default `http://127.0.0.1:8795`) |
| `flowcrew status [<run-id> [--brief]]` | Inspect one run, print its stored brief with `--brief`, or list runs across projects in the selected store |
| `flowcrew guide <run-id> <text> [--plan <file>]` | Queue author context without interrupting; optionally propose a replacement plan |
| `flowcrew cancel <run-id>` | Record cancellation, request cooperative controller exit and reconcile after acquiring its lifetime lock; safe to repeat ([wait/refusal](operations.md#runtime-pin-and-restart)) |
| `flowcrew resume <run-id>` | Continue parked work using the original runtime pin |
| `flowcrew land <run-id> [--accept-unmet C3=reason ...]` | Record human acceptance of unmet criteria, preserve the declared outputs, then delete the run's bytes; see [Preservation](operations.md#preserve-and-reclaim) |

Repeat `--accept-unmet 'C3=reason'` for each criterion the human accepts as unmet. Land
copies its latest gate status and evidence into the delivery's `manifest.json`, with the
reason and time; without a gate judgment it records `not_assessed` and `not assessed`.
The JSON result includes these entries as `acceptedUnmet`. Unknown frozen criterion ids
and criteria passed by the latest gate are invalid (exit 2), before preservation or deletion.
Acceptance does not change the frozen brief, gate verdict or run status. Supply it on the
first land: once the delivery is published, land with acceptance records refuses (exit 1).
Repeating land without records can finish cleanup even if the delivery directory was moved
or removed; its `acceptedUnmet` result is empty. Read stored acceptance in the delivery manifest.

```text
flowcrew land <run-id> --accept-unmet 'C3=Accept plateau at 0.842'
```

Monitor uses the same default store as the CLI. Repeat `--store-root DIR` to read
multiple stores; supplying roots replaces the default. Stop the foreground server with
Ctrl-C. The dashboard is read-only; act in the owning Claude Code or Codex session.

Guidance delivery, its `pending` and `delivered` states, which runs refuse guide and resume, and
replacement plans (`--plan`) are described in [operations](operations.md#inspect-guide-and-stop);
see also [protocol](agent-protocol.md#scope-and-plan-revisions).

## Status output

An explicit id emits the status object, including `briefDigest` and `sourceProject`.
`flowcrew status <run-id> --brief` prints the stored brief bytes until land removes them.
With no id, stdout is a JSON array of Result
objects (`{ok: true, value: ...}` or `{ok: false, kind, detail, run}`), one per recorded run
in the selected store, sorted by run name. Inspect failures in that array; an empty array can
mean the selected store has no recorded runs or its database is unavailable.

| Field | Meaning |
|---|---|
| `briefDigest`, `sourceProject`, optional `preparationReason` | Brief identity, original project and any setup refusal reason; the digest remains after land |
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
| optional `heldBytes` (v4) | Retained file sizes, hard links counted once, over the project copy, runtime pin, work root and raw evidence, excluding the controller lock. The finishing writer measures after capture; external cancel measures under control/reconciliation after controller exit. The result stays unchanged until land completes cleanup. Status only reads |
| optional `heldSpacePending` (v4) | True for an ended, unlanded run whose retained-byte measurement is pending or failed, including old stores. `heldBytes` is absent and the dashboard's held total is incomplete; repeat cancel or land to measure |
| optional `title` (v4) | Declared brief frontmatter `title`, otherwise its first `# ` heading; absent when neither exists. The dashboard falls back to the first 16 characters of the run ID. |
| optional `stages` | Current-plan stage definitions in order, then replaced definitions. Each includes purpose, role, dependencies, goal, full instruction, commands, revision, execution state, engine-attempt count, last ending, verdict and nullable recorded start/settlement times. `replacedBy` marks a historical definition without erasing its execution. |
| optional `stages[].segments` | Recorded invocation and pause intervals: `kind`, nullable `startedAt` and `endedAt`; attempt intervals also carry engine `attempt`, `invocation` and recorded `ending` when settled. Historical aggregate intervals may carry `elapsedMs` from the measured step, so reading later does not extend recorded time. Continuations share an attempt ID; `attempts` counts distinct engine attempts. `startedAt: null` means an older projection did not retain the try time; an `ending` still records its outcome. |
| optional `stages[].summary` | The stage's own work summary or review reason, verbatim; no run-level summary substitution. |
| optional `stages[].commandProgress` | For a running gate, its declared command IDs with addressed reservation/receipt states: `passed`, `running`, `not_started`, `failed` or `unfinished`. Satisfied results retain this field after settlement, with `source` naming stage, attempt, invocation and result tree. Earlier invocations also have `reused: "reused from <stage/attempt>"` as a display label. A command whose latest receipt exited non-zero also carries `basis` (`pre-existing` or `introduced`; see the [brief contract](brief-contract.md#required-commands-that-already-fail-on-the-base)). |
| optional `guidance` (v4) | Each accepted guide's `guide` ID and `state` (`pending` or `delivered`, defined in [operations](operations.md#inspect-guide-and-stop)); delivered entries identify the author `invocation` (`run`, `stage`, `attempt`, invocation number). |
| optional `activity` (v4) | The latest execution `invocation` per author or gate stage or declared command: `source` (`author`, `gate` or `command`), `stage`, optional declared `command` ID, `state` (`current` or `ended`), nullable `lastEventAt`, `lastTool`, `summary`, and `toolRunning`. `observation` is `unknown`, `observing`, `progress` or `quiet`. Only recorded tool events or command stream modification times set `lastEventAt`; provider chatter and controller polls never do. Ended records retain observations; they do not claim current progress. |
| optional `activity[].notice` (v4) | One advisory `cursor` and `message` per quiet episode. This cursor identifies a row in the activity table, independently of `journalCursor`. A later quiet episode has a new cursor. A current quiet record reaches the dashboard's attention display and the session notice projection. Lifecycle `attention`, `stopReason` and execution policy stay unchanged. |
| optional `commandActivity` | Compatibility view of open engine-command observations; historical journal rows retain their quiet notices. New advisory notices appear only in `activity`, so older readers never confuse their IDs with journal cursors. New consumers read `activity` for author, gate and command facts together. Activity uses an advisory SQLite table outside the decision journal; a failed activity write is logged and ignored. |
| optional `plan` | Current `revision` and `pending` plan definitions, suitable for guidance; attempted definitions cannot be changed by human guidance. |
| optional `startedAt`, `lastActivityAt`, `endedAt` | Recorded run start, latest committed fact time and lifecycle end. Publication/poll time does not advance activity. No age implies a stuck verdict. |

New status snapshots use `status.json` v4. The file decoder also reads historical
v2/v3 displayed snapshots under their original contract. An absent focus uses their recorded `currentStage`; an explicit focus (including `null`) is preserved. Aggregate stage start/settlement times, or the running step start and measured elapsed time, become stage intervals in this one decoder; no per-attempt times are invented. The publisher
alone publishes journal facts to this file. CLI status/list reads those facts from
the journal and applies a read-only availability overlay to stdout without rewriting `status.json`. The monitor and
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

Cancel and land wait up to one 30,758-ms controller observation window before refusing
unconfirmed exit with retained-work and repeat-cancel/land advice; see [operations](operations.md#runtime-pin-and-restart).

## Exits and storage

Successful operations normally emit JSON. Exit 0 means the
operation succeeded, not that the deliverable passed. Exit 1 is conflict/refusal or a
reported unsuccessful operation (for land, `state: partial`); 2 is invalid input, including a
required run id that is omitted or an id that names no run; 3 is unavailable, unknown or
`not_confirmed_closed` or in-progress. Inspect stdout/stderr and current status before retrying an uncertain
operation. Unit entry returns a parked conclusion with exit 3 when no closure/claim obligation
is open, including accounting-only attention; an open closure/claim obligation on
non-final work is a refusal (1). Final entry returns the retained
conclusion even with cleanup attention: completed work exits 0, failed or cancelled
work exits 1. An unexpected exception during an operation is an unknown outcome (3); one that escapes the CLI entry exits 2. Repeated cancel of ended work,
resume of active work, and successful reclaim reruns are idempotent successes.

[Configuration](configuration.md#storage-and-runtime) owns storage defaults and overrides.
