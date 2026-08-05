# Approval inbox

The approval inbox turns “ask before doing this” into an engine-enforced pause.
A stage requests authorization through a file, the scheduler persists it and
parks the run, and an operator resolves it from the CLI or dashboard.

## Request contract

Each stage receives the exact path of its own request slot in the run directory:

```text
stages/<stageId>/approval_request.json
```

The stage must write one JSON object and stop before performing the action:

```json
{
  "id": "publish-release",
  "action": "publish",
  "target": "release-channel",
  "risk": "external",
  "title": "Publish the verified release",
  "body": "The build and checks passed; publishing makes the release externally visible."
}
```

| Field | Required | Contract |
|---|---:|---|
| `id` | Yes | Stable idempotency key within the run. It must match `[A-Za-z0-9._-]{1,64}`. `requestId` is accepted as an alias. |
| `action` | Yes | Non-empty action name, such as `publish`, `deploy`, or `send`. |
| `target` | No | Exact object affected by the action. It is mandatory for a standing rule. |
| `risk` | No | `external`, `exec`, or `write`; missing or unknown values become `unknown`. |
| `title` | No | Operator-facing summary. The engine derives one from action and target when omitted. |
| `body` | No | Explanation, evidence, and blast radius. |

The stage-specific slot prevents parallel stages from overwriting each other.
The root `approval_request.json` and named root variants remain readable for
compatibility, but new work should use the injected stage path.

After ingestion, the engine moves the original request to
`approvals/<id>.request.json` and appends a durable record to `approvals.jsonl`.
On resolution it writes `approvals/<id>.decision.json`; a resumed stage must
read that file before acting. An approval permits the requested action. A denial
forbids it, so the stage should continue with unaffected work or produce an
honest terminal artifact explaining the block.

## Park and resume semantics

If no standing rule matches, the scheduler:

1. records every request emitted by the completed stage batch;
2. chooses the oldest unresolved request;
3. changes the run to `parked` without setting `completedAt`;
4. persists the current DAG and iteration, releases the process and project
   lock, and exits cleanly;
5. waits for an operator decision.

`parked` is not terminal and has no live run process. Approve and deny both
resume the same run ID, DAG, and iteration by default. Pass `--no-resume` when
you need to record a CLI decision without immediately relaunching it.

Requests are idempotent by `(runId, id)`: the first request with that key is the
durable one. Resolutions are append-only and first-responder-wins. If the CLI,
dashboard, or two operators race, the first appended resolution is authoritative
and later attempts report the winner instead of changing the decision.

## CLI

```bash
# Pending requests by default
flowcrew inbox list
flowcrew inbox list --state pending|resolved|all
flowcrew inbox list --run <runId>

flowcrew inbox show <requestId>
flowcrew inbox show <requestId> --run <runId>

# Both decisions resume a parked run unless --no-resume is present
flowcrew inbox approve <requestId> [--reason "..."] [--no-resume]
flowcrew inbox deny <requestId> [--reason "..."] [--no-resume]

# Grant, inspect, and revoke a bounded standing rule
flowcrew inbox approve <requestId> --always
flowcrew inbox rules
flowcrew inbox revoke <action> <target> [--project <dir>]
```

Use `--run <runId>` with `show`, `approve`, or `deny` when the request ID alone
is ambiguous across runs.

## Dashboard

Run `flowcrew start`, then open `/inbox`. The page polls pending requests across
campaigns, shows their risk, action, target, explanation, run, and waiting time,
and offers approve, deny, and eligible standing-rule actions. Dashboard
resolutions use the same first-wins store and resume a parked run after the
winning decision is persisted.

## Standing rules

“Always allow” is intentionally narrow. A request is eligible only when:

- `risk` is exactly `external`; and
- `target` is present and exact.

The stored match also binds the project directory, action, and target. A rule
therefore authorizes one named external action against one target in one
project. `exec`, `write`, `unknown`, and untargeted requests must be decided
every time. Only an approval can create a standing rule; denial never does.
