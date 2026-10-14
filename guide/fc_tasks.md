# Optional conversation ledger

For an operator using conversation tasks: how do I preserve human intent and bind it to engine work?

`fc_tasks` owns a validating read/write interface to the legacy one-directory-per-session
ledger. It does not install or edit frontend configuration. Run/task lifecycle authority
and ledger wrap-up authority are different; a terminal run does not automatically mean the
human has accepted the result or completed a ledger entry.

## Selection and commands

Synopses below use placeholders, not actual session/run identities.

| Command | Purpose and options |
|---|---|
| `fc_tasks render` | Width-bounded text; common selectors plus `--columns`, `--lines` |
| `fc_tasks list [--json]` | Validated full fields and run links as JSON |
| `fc_tasks reconcile [--json]` | Read-only disagreement/action projection |
| `fc_tasks create` | Full entry from `--entry <json>` or stdin; optional `--flowcrew-task-id` |
| `fc_tasks update <entry-id>` | Partial patch from `--entry` or stdin; optional `--flowcrew-task-id`, `--clear-flowcrew-task-link`, `--expected-run-id` |

Common value options are `--session`, `--session-key`, `--payload-arg`, `--store-root`,
`--engine-root`, `--max-entries`; separate/equals syntax is accepted. Unknown/duplicate
options refuse. Render/list/reconcile errors degrade visibly rather than pretending an empty
ledger is healthy; create/update refuse invalid writes. Consult the command's diagnosis and
exit code together.

Store precedence is `--store-root`, `FC_TASKS_ROOT`, then the user's `.claude/tasks` root.
Engine evidence root can be selected with `--engine-root`; otherwise it uses FlowCrew state.
Session precedence is explicit `--session`, then supplied JSON payload through `--session-key`
(default `session_id`), then `CODEX_THREAD_ID` only when no payload was supplied. A malformed
or keyless supplied payload cannot fall through to the environment. Rendering reads stdin
when no explicit selector/payload argument is present. Entry writes consume entry JSON instead.

Sources: [CLI grammar](../src/cli-fc-tasks.ts), [selection/store](../src/fc-tasks.ts).

## Entry contract and reconciliation

Create requires the seven fields `id`, `subject`, `description`, `activeForm`, `status`,
`blocks`, `blockedBy`. Text fields are strings; IDs are safe single path segments.
Status is pending/in_progress/completed. Dependency lists contain unique safe IDs and must
form a valid ledger graph. Optional `flowcrewTaskId` is a positive safe integer, not a fuzzy
project-name match. Update merges a validated partial patch under the ledger lock and
writes atomically. Creation never overwrites an existing entry. Clearing a link is explicit.

The engine registry compatibility reader bounds each `tasks.jsonl` row to 4 MiB (4,194,304 bytes);
an oversized row cannot supply verified linkage. A directory-persistence failure after publication
can be outcome-ambiguous: inspect the actual store before retrying, rather than assuming every
refusal left every JSON file unchanged.

A linked task/run is checked against exact engine registry/run evidence, including brief
binding. Missing/stale/unavailable evidence remains uncomparable, not an inferred result.
Reconcile can show wrap-up required after terminal engine work, a closed ledger with active
engine work, or missing links needing repair. It writes neither account. `--expected-run-id`
guards an intentional update against changed binding; successful lifecycle alone does not
issue that update. [Landing](operations.md#preserve-and-reclaim) has an optional guarded
closure transaction after safe worktree removal.

Source: [validation/writers/reconciliation](../src/fc-tasks.ts).

## Frontend integration boundary

An operator-owned frontend hook can invoke the renderer with an explicit session or payload.
For a payload whose key is `thread-id`, select `--session-key thread-id` and pass its JSON
through `--payload-arg`. A supplied payload shape must be verified for that frontend; FlowCrew
code does not establish another product's callback cadence or footer capabilities.

The renderer uses terminal dimensions and Unicode display width to bound rows. It keeps
ledger intent and verified run links distinct. FlowCrew supplies no native task-tool alias
and no installed `fc_tasks` skill. The shipped [status skill](../skills/fc-status.md) uses
project run status; any ledger skill, notification shim or frontend settings are operator tooling.

Sources: [renderer](../src/fc-tasks.ts), [CLI payload handling](../src/cli-fc-tasks.ts),
[shipped installer](../skills/install.sh).
