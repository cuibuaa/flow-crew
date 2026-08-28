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
characters cannot add rows or terminal escapes. The total row count is bounded by `LINES`; when
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
| `payload_not_object` | A supplied payload is not a JSON object. |
| `session_absent` | No explicit, payload, or observed environment selector exists. |
| `session_key_absent` | The selected payload key is absent. |
| `session_invalid` | A selector is empty or unsafe as one path segment. |
| `store_unreadable` | The session directory cannot be scanned or contains a non-file JSON entry. |
| `scan_limit_exceeded` | The bounded JSON-file scan would be exceeded. |
| `entry_not_json` | An entry cannot be parsed as JSON. |
| `entry_invalid` | An entry does not satisfy the legacy field types or status vocabulary. |
| `duplicate_id` | Two files claim the same entry id. |
| `graph_invalid` | A dependency edge is self-referential or names no entry. |
| `resolver_unavailable` | A linked entry exists but the explicit engine registry cannot be read safely. |
| `internal_error` | An unexpected renderer error was contained. |

If valid and corrupt files coexist, valid counts and task rows remain visible alongside a warning.
Invalid command-line syntax is also non-blank, but exits non-zero because it is a usage error rather
than a renderer state.

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
replacement bound that authority. A refusal still leaves every JSON file unchanged, and `create`
does not receive this exception.

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

Validation happens before publication. The engine writes and flushes a uniquely named temporary
file in the session directory. `create` publishes it with create-only semantics; `update` atomically
renames it over exactly the selected entry. A validation or publication failure removes the
temporary file. Failed create publishes no entry, and failed update leaves the prior entry bytes
unchanged. Temporary files do not use the `.json` suffix and therefore cannot masquerade as ledger
entries after an interrupted process.

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
