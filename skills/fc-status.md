---
name: fc-status
description: Show FlowCrew run status from the selected store, inspect an explicit run id, or open the read-only dashboard.
---
<!-- flowcrew-skill-revision: 7 -->

# Show run status

Run `flowcrew status <run-id>` when the user supplied a run id. Otherwise run:

```bash
flowcrew status
```

Show the output as produced. With no id it returns an array of per-run Result objects
for all run directories in the selected store, including other projects; it does not
select the latest project run. An explicit id returns one status object. There are no
`--project` or `--all` status selectors. Use the user's selected storage environment.

The view includes the brief digest and source project, lifecycle, stage, stop reason, attention, C2 counters, elapsed step
time, usage completeness and optional landing (`reclaimed`), held-space (`heldBytes`, set for an ended run that has not been landed) and interruption facts. Unknown usage
is not zero. Inspection exits zero even for a failed or cancelled run; read the status.
Use `flowcrew status <run-id> --brief` to read the stored brief before land removes it.
An interrupted run shows the exact manual resume command. See
[status fields](../guide/cli.md#status-output) and
[storage defaults](../guide/configuration.md#storage-and-runtime).

## Open the dashboard

When the user asks for the dashboard, reuse the one this session already started for the
selected store if it still answers. Otherwise start `flowcrew monitor` in the background
with its output in a log file, read the `FlowCrew monitor: <url>` line from the log, and
give the user that URL. If the default port is taken, start it again with `--port 0`; a
listener you did not start may serve a different store, so do not present it as this one.
Pass `--store-root DIR` only when the user selected a store explicitly. Leave the server
running; it is read-only and `GET` only.

Never start, resume, cancel or land work from this skill. To steer, stop or keep the
results of a run, tell the user to ask the session that launched it.
