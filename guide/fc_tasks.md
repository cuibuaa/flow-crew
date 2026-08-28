# `fc_tasks`

`flowcrew fc_tasks` is the engine-owned interface to the conversational task ledger. It reads the
existing one-directory-per-session store, renders it for a front end, and provides the only
supported validating write path. It does not install or edit either front end's configuration.

## Commands

```bash
# Render. With no --session, JSON may arrive on stdin.
flowcrew fc_tasks render --session <session-id>
flowcrew fc_tasks render --store-root <directory> --engine-root <directory> --session <session-id>

# Show every validated field rather than the width-bounded status surface.
flowcrew fc_tasks list --json --session <session-id>

# Entry JSON may be supplied on stdin or with --entry.
flowcrew fc_tasks create --session <session-id> < entry.json
flowcrew fc_tasks update <id> --session <session-id> < entry.json

# Link an entry to the exact engine task visible as "Task #123".
flowcrew fc_tasks create --session <session-id> --flowcrew-task-id 123 < entry.json
```

The store root resolves in this order: `--store-root`, `FC_TASKS_ROOT`, then the legacy
`~/.claude/tasks` root. The default deliberately keeps existing hand-written and tool-written data
live; there is no migration. A session is selected in this order:

1. `--session`;
2. a JSON payload from stdin or `--payload-arg`, read through `--session-key` (default
   `session_id`);
3. only when no payload was supplied, the observed `CODEX_THREAD_ID` environment value.

A malformed or keyless supplied payload never falls through to the environment selector. Session
values and entry ids must be safe, single path segments.

Engine state resolves independently in this order: `--engine-root`, `FC_HOME`, then `~/.fc`.
`--engine-root` is an explicit adapter input so tests and alternate installations can point both the
task registry and run archive at a sandbox. It does not change the conversational ledger root.

## What the renderer prints

For a healthy ledger, the first row is a count header. Each open task then gets one row, sorted by
id: an in-progress row uses `activeForm`, and a pending row uses `subject`. Completed entries remain
in the header count. When no task is open, the header says `idle`; when the session directory does
not exist, it instead says `no ledger`. Those states are intentionally different.

Every emitted row is clipped to the terminal display width from `COLUMNS`. Clipping uses terminal
column width, including double-width CJK text, rather than JavaScript string length. Control
characters, including Unicode bidirectional overrides and isolates, cannot add rows, terminal
escapes, or visually reorder a task row. The total row count is bounded by `LINES`; when
rows do not fit, the last available row reports how many were omitted. With only one available row,
that overflow notice is appended to the header because a separate overflow row cannot fit. If the
front end supplies neither variable, the renderer uses conservative defaults.

An entry with a verified engine link prefixes its row with `run:<status>` when a run exists, or
`task:<status>` while the engine task has not acquired a run. A legacy entry with no link renders
normally with no live-state prefix. If a previously verified task or run mapping disappears or no
longer matches, the row instead carries `stale:#<task-number>` and the header counts stale rows.
Stale is an entry state, not a renderer failure: the task row stays visible and the renderer still
reports an active or idle ledger. A resolver I/O or registry-integrity failure is different and
uses the nonblank `resolver_unavailable` degradation described below.

The compact surface omits descriptions, dependency edges (`blocks` and `blockedBy`), completed-task
subjects, source filenames, full run ids, target directories, and brief digests. Run
`flowcrew fc_tasks list --json` to retrieve every validated entry and its `runLinks` resolution,
including the reason a mapping is stale or unavailable.

## Degraded output is still output

`render` exits zero and prints a newline-terminated diagnostic for every renderer failure, because
an empty status surface is indistinguishable from a broken hook. Its explicit degradation codes
are:

| Code | Meaning |
|---|---|
| `invalid_dimensions` | `COLUMNS` or `LINES` is not a positive bounded integer. |
| `payload_not_json` | A supplied front-end payload is not JSON. |
| `payload_too_large` | A supplied front-end payload exceeds the bounded parse limit. |
| `payload_not_object` | A supplied payload is not a JSON object. |
| `session_absent` | No explicit, payload, or observed environment selector exists. |
| `session_key_absent` | The selected payload key is absent. |
| `session_invalid` | A selector is empty or unsafe as one path segment. |
| `store_unreadable` | The session directory cannot be scanned or contains a non-file JSON entry. |
| `scan_limit_exceeded` | A JSON-file, directory-entry, or total-byte scan bound would be exceeded. |
| `entry_not_json` | An entry cannot be parsed as JSON. |
| `entry_invalid` | An entry does not satisfy the legacy field types or status vocabulary. |
| `duplicate_id` | Two files claim the same entry id. |
| `graph_invalid` | A dependency edge is self-referential or names no entry. |
| `resolver_unavailable` | A linked entry exists but the explicit engine registry cannot be read safely. |
| `internal_error` | An unexpected renderer error was contained. |

If valid and corrupt files coexist, valid counts and task rows remain visible alongside a warning.
Invalid command-line syntax is also non-blank, but exits non-zero because it is a usage error rather
than a renderer state.

## Resource bounds and existing-ledger migration

All byte limits are measured on UTF-8 input. Command input from stdin, `--entry`, or
`--payload-arg`, and a direct renderer front-end payload, is limited to 1,048,576 bytes before
JSON parsing. Each of `subject`, `description`, and `activeForm`
is limited to 262,144 bytes, and each of `blocks` and `blockedBy` is limited to 1,000 ids. A stored
entry file is limited to 1,048,576 bytes; one session is limited to 16,777,216 entry bytes,
4,096 directory entries of all names, and the selected JSON-entry count (1,000 by default).
Linked `run.json` and reservation records are each limited to 1,048,576 bytes. Reads use the limit
plus a sentinel byte, so a file that grows during the read is still refused rather than allocated
without bound. The engine root and `tasks.jsonl` registry must be real, stable, non-symbolic
objects. The configured run archive, a linked run directory, and each child component must be
real directories; symlinks are never followed to an outside task or run record. Selected
engine-task rows are limited to 16,777,216 bytes in aggregate; task/run
statuses are limited to 4,096 bytes and engine project paths to 65,536 bytes before rendering. A
resolver invocation inspects at most the newest 16,777,216 bytes of `tasks.jsonl`, so an old link
outside that bounded tail becomes unavailable instead of forcing an unbounded registry scan.
A `tasks.jsonl` registry row is limited to 4,194,304 bytes (4 MiB). To migrate an existing
oversized row, compact its optional payload and append a fresh authoritative row under that limit;
if another oversized row still lies in the required tail, re-emit the currently linked task rows
after it or repair the registry from a backup. The conversational ledger itself needs no rewrite.

These are validation restrictions, not a JSON format migration. Existing ordinary seven-field and
linked entries keep the same shape and location. An existing hand-written ledger or engine record
over a limit becomes explicitly degraded, unavailable, or stale until an operator shortens the
offending fields/file or removes unrelated directory debris; FlowCrew never truncates or rewrites
it automatically. Use `list --json` and the named degraded issue to locate the affected session,
then make a backup and repair the source file with an external editor before retrying a validating
write. For a linked task older than the registry tail budget, append a fresh authoritative task row
through the engine or clear and re-establish the ledger link; the JSON ledger itself needs no rewrite.

## Validated and atomic writes

New entries and complete-record updates use the established fields:

```json
{
  "id": "work-item",
  "subject": "Short title",
  "description": "Full detail",
  "activeForm": "Doing the work",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": []
}
```

The allowed statuses are `pending`, `in_progress`, and `completed`. A create or complete-record
update is refused for missing or unexpected fields. Every write is refused for supplied values of
the wrong type, an unsafe id, duplicate relationship ids, a duplicate task id (even under another
filename), a self-reference, or a missing dependency target. `create` remains fail-closed when any
existing entry is malformed. `update` requires exactly one existing positional id, and a supplied
JSON `id` must match it.

An update may instead send a shallow replacement patch, for example
`--entry '{"status":"completed"}'`. Any of the seven legacy fields or optional `flowcrewTaskId`
may be omitted; an omitted field keeps its stored value, and an omitted `id` means the positional
id. A field that is present is validated by the same rules as a complete entry. In particular,
explicit `null` is not deletion and is refused by the field's type rule. Supplying `blocks` or
`blockedBy` replaces that whole array; the writer does not append, union, or merge array elements.
Unknown patch fields are refused so misspellings cannot persist silently.

This omission rule deliberately gives up one check that complete-record validation provided: the
writer can no longer tell whether a caller meant to send a complete snapshot but accidentally left
out a field, nor whether the caller's omitted view of that field was stale. Callers that require
that completeness guarantee can continue to send all seven fields, which follows the established
complete-entry validation and publication path.

### Repair boundary and remaining refusals

`update` has one narrow exception to the clean-ledger prerequisite: it may replace a damaged entry
when exactly one parseable JSON object has a raw `id` equal to the safe positional id and the
in-memory replacement makes the entire ledger valid. The patch itself accepts only supported
fields, all supported fields in the merged target are validated, and then the writer reruns entry,
duplicate-id, and dependency-graph validation over the virtual post-update ledger before touching
the file. There is no ignore-validation or repair-mode flag.

For example, a hand-written target whose `activeForm` is `null` can now be repaired with
`--entry '{"activeForm":"Repairing the ledger"}'`. Updating a healthy peer while that target
remains malformed is refused. Updating another field on the damaged target is also refused when
`activeForm` would remain invalid. Stored forward-compatible fields survive a valid partial repair,
but an unknown field supplied by the caller is still rejected.

The faults that continue to block publication are explicit:

- An unreadable or non-directory store, a non-file JSON entry, or a scan-limit overflow prevents
  the writer from establishing the complete set safely.
- Invalid JSON, a missing or unusable raw id, or no raw id matching the positional id leaves no
  unambiguous file-to-id repair target.
- More than one raw target claim, or any duplicate id in the virtual post-state, makes replacement
  identity ambiguous.
- Any invalid non-target entry, or any supported target field still invalid after merging, means
  the proposed ledger remains damaged; this prevents a caller from laundering corruption through
  a nominal repair.
- Any self-reference or missing `blocks` or `blockedBy` target in the virtual post-state is refused
  because those relationships can be checked only against the complete id set.
- A stale, missing, mismatched, or unreadable FlowCrew task link remains unverifiable and cannot be
  published.
- Failure to flush the temporary file or atomically publish it cannot meet the durability and
  unchanged-on-failure guarantees.

This does widen `update`'s blast radius: it may now overwrite one source file after observing that
the pre-state is invalid, where it previously refused before target selection. Exact raw-id
selection, strict candidate validation, full post-state validation, link verification, and atomic
replacement bound that authority. A refusal before atomic replacement leaves every JSON file
unchanged, and `create` does not receive this repair exception. A persistence refusal after
replacement has the explicitly outcome-ambiguous semantics described below.

The seven fields above remain the complete legacy shape. A validating write may add one optional
FlowCrew-owned field:

```json
{ "flowcrewTaskId": 123 }
```

The ordinary way to populate it is `--flowcrew-task-id 123`; a JSON entry may also carry it
directly. In either case the writer resolves the number against the configured engine registry and
refuses a missing, invalid, mismatched, or unreadable link before publishing any file. An update
preserves an existing link unless a replacement number is supplied or
`--clear-flowcrew-task-link` explicitly removes it. The field is optional: old seven-field entries
remain readable and writable, and creating an intentionally unlinked entry is valid.

The registry task number is the stable identity because it is monotonic engine state rather than a
run or worktree attribute. A retry, cancellation/relaunch, or new run id updates the same registry
task, so the next render follows the new exact `run_id`. Reclaiming and recreating a worktree at the
same path cannot capture the link because path text is not the key. Finished runs remain resolvable
from the task's recorded run id in the archive. The resolver also cross-checks the run id, target
directory, and brief digest when those records provide them; a mismatch becomes stale rather than
silently joining a different run.

Per render, the resolver reverse-scans the append-only tail of `tasks.jsonl` at most once and stops
as soon as it has the latest row for every linked ledger entry. It caches those rows for the invocation
and opens only each linked `run.json` (or its pre-launch reservation) by its recorded id. It does not
scan the archive top level and does not signal scheduler pids. Resolver overhead must still be
benchmarked separately from the unlinked render baseline because registry history and linked-entry
count affect it.

Validation and publication form one session-scoped transaction. A cross-process lock covers the
fresh authoritative read, entry-count admission, full proposed-ledger validation, temporary-file
flush, create-only hard link or atomic update rename, and session-directory flush. A create at the
configured maximum is refused before publication, and two acknowledged updates cannot silently
erase one another's patches. Creating a session also flushes the parent directory that acquired
its name. The same captured directory identity is rechecked around temporary creation,
publication, and persistence, so a replaced or symlinked session fails closed. A successful return
therefore follows every supported persistence step; real I/O errors
such as `EIO` and `ENOSPC` are never treated as an unsupported directory-sync operation.

Temporary basenames use random fixed-size identities rather than the task id, so the documented
240-byte id boundary still fits filesystems with a 255-byte component limit. Temporary files do
not use the `.json` suffix and therefore cannot masquerade as ledger entries after an interrupted
process. A failure before link/rename removes the temporary and leaves create unpublished or update
unchanged. A directory-persistence failure after link/rename is necessarily outcome-ambiguous: the
command refuses and tells the caller to reread the ledger, because claiming rollback would be
false.

Lock metadata lives in an ephemeral `.fc-tasks-lock-<session-hash>` directory at the store root,
never in a `.json` ledger entry. A lock whose recorded process is definitely gone is recovered;
PID reuse, unreadable/partial ownership metadata, and permission failures remain fail-safe and
refuse the writer. If a crash leaves such an indeterminate lock, verify that no writer process owns
the session before removing that one lock directory and retrying. A time threshold alone never
steals a live writer's lock.

The reader requires no field beyond the seven-field legacy shape and renders existing files in
place. It tolerates unknown extra fields while reading for forward compatibility and recognizes and
validates `flowcrewTaskId` when present. A partial update preserves stored forward-compatible fields
that its caller did not mention, while still refusing any unknown field supplied by the patch. A
create or complete-record update rejects unknown input fields as before.

## Claude Code surface

What was read: the installed Claude Code status-line documentation says a configured command
receives a JSON object on stdin. Its documented payload includes `session_id`, `cwd`, `workspace`,
`model`, and `context_window`, plus other product metadata. The installed changelog records both
multi-row handling and `COLUMNS`/`LINES` delivery. It also documents an optional `refreshInterval`
setting that reruns the command every configured number of seconds.

What was observed: Claude Code 2.1.233 is installed, and the operator-owned user settings currently
select a command status line. That configuration has no `refreshInterval`, so it establishes an
event-driven persistent surface but no configured periodic interval. The exact default event
cadence was not documented or instrumented and remains unknown.

Claude Code can invoke the engine directly because its session key already has the default name:

```json
{
  "statusLine": {
    "type": "command",
    "command": "flowcrew fc_tasks render"
  }
}
```

This snippet is plumbing for the operator to place in `~/.claude/settings.json`; FlowCrew does not
own or install that file. The command receives the payload on stdin and the terminal dimensions in
its environment.

## Codex surface

What was read: the current Codex manual documents a persistent TUI footer configured by
`tui.status_line`, but its values are an ordered list of built-in item identifiers selected by
`/statusline`. It documents no arbitrary footer command. The same manual documents the separate
`notify` hook: Codex invokes an external program once for each `agent-turn-complete` event and passes
one JSON argument containing fields including `thread-id`, `turn-id`, and `cwd`.

What was observed: Codex CLI 0.146.1 is installed. The current agent process exposes a
`CODEX_THREAD_ID` value, while the inspected user configuration has neither a custom status-line
list nor a `notify` command. The environment key is an observation, not a promise in the manual.

What remains unknown: the manual specifies no extensible persistent footer and therefore no custom
command refresh cadence or stdin payload to discover. It also does not promise `CODEX_THREAD_ID` to
all Codex surfaces. FlowCrew does not pretend those surfaces exist.

Codex therefore has two honest integration choices:

- An operator-owned `$fc_tasks` skill or an ordinary on-demand shell invocation can run
  `flowcrew fc_tasks render --session <id>`. In this observed CLI environment it may use the
  environment fallback, which degrades visibly if the key is absent.
- An optional operator-owned notification shim can pass Codex's single JSON argument as
  `flowcrew fc_tasks render --payload-arg "$1" --session-key thread-id`, then forward the returned
  rows to the operator's chosen notification sink. This runs once per completed turn; it does not
  turn the built-in footer into a live ledger.

The operator owns `~/.codex/config.toml`, any notification shim, and any
`~/.agents/skills/fc_tasks/SKILL.md`. FlowCrew owns the command, payload adapters, schema, renderer,
and atomic writer.

## Names and collision boundary

The introduced public namespace is `flowcrew fc_tasks`; its nested subcommands are `render`, `list`,
`create`, and `update`. The optional Codex skill is `$fc_tasks`, and an operator may call its optional
notification shim `fc_tasks_notify`. The link field is `flowcrewTaskId`, its writer options are
`--flowcrew-task-id` and `--clear-flowcrew-task-link`, and the detail collection is `runLinks`.
None uses or shadows either front end's native `Task*`, `/status`, `/statusline`, `/goal`, or other
task-tool namespace. The engine deliberately provides no `task` alias.
