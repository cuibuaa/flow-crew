---
name: fc-status
description: Show FlowCrew run status from the selected store or inspect an explicit run id.
---
<!-- flowcrew-skill-revision: 5 -->

# Show run status

Run `flowcrew status <run-id>` when the user supplied a run id. Otherwise run:

```bash
flowcrew status
```

Show the output as produced. With no id it returns an array of per-run Result objects
for all run directories in the selected store, including other projects; it does not
select the latest project run. An explicit id returns one status object. There are no
`--project` or `--all` status selectors. Use the user's selected storage environment.

The view includes lifecycle, stage, stop reason, attention, C2 counters, elapsed step
time, usage completeness and optional reclamation/interruption facts. Unknown usage
is not zero. Inspection exits zero even for a failed or cancelled run; read the status.
An interrupted run shows the exact manual resume command. Do not start, resume, cancel
or reclaim work as part of this read-only skill. See [status fields](../guide/cli.md#status-output)
and [storage defaults](../guide/configuration.md#storage-and-runtime).
