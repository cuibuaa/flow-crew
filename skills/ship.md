---
name: ship
description: Turn the current conversation into a self-contained FlowCrew brief, prepare a run, get explicit confirmation, and start that run. Use when the user asks to hand off or ship work to FlowCrew.
---
<!-- flowcrew-skill-revision: 75 -->

# Ship a conversation to FlowCrew

Use `/ship` in Claude Code or `$ship` in Codex. The run never sees this conversation, only
the saved brief. Detailed facts live in the bundled [brief contract](../guide/brief-contract.md),
[CLI](../guide/cli.md) and [operations](../guide/operations.md).
`flowcrew` must be installed ([getting started](../guide/getting-started.md)); installing
skills alone does not install the command.

## Author with the user

Inspect the selected project and original evidence. `flowcrew status` lists runs across
projects in the selected store ([storage](../guide/configuration.md#storage-and-runtime)).
Use `flowcrew status <run-id>` to identify prior work by source project and brief digest,
and `flowcrew status <run-id> --brief` to read its stored brief before land.
Carry useful prior evidence into declared inputs: project files are under the store's
`work/<run-id>/project/` before land, then declared outputs under
`deliveries/<run-id>/project/`. Explain unknown state.

Save the brief outside the project in its own task folder, for example
`<briefs-dir>/<task>/brief.md`. Use the user's existing brief location when known; otherwise
ask where they keep briefs. Keep revisions under new filenames in the same folder.
Setup copies everything except `.git`, including ignored files, so an in-project brief
would be visible alongside other tasks' briefs and could be published if tracked.
Use the [brief contract](../guide/brief-contract.md), including its authoring principles,
research guidance when applicable, and evidence policy.

## Prepare, show and confirm

From the project directory, prepare the saved brief:

```bash
flowcrew setup <brief>
```

`<brief>` is the saved file's path. Optional `--project <dir>`, `--backend codex|claude`,
`--config <file>` and `--requester <session>` belong to setup
([defaults](../guide/cli.md#setup-and-start)). Setup admits a run and prints `run`; it
creates a runtime pin and project copy but runs no provider or declared command.
Correct refusals and show any retired-key advisory from stderr. Setup success does not
establish command feasibility or validation success.

Show the user the exact saved brief, setup's complete result and direct exit code, and
`flowcrew start <run-id>` using the returned `run`. Explain the host rights and process
closure described by the boundary text in setup's result.
Ask for a **new explicit confirmation of that run, brief digest, source and recorded options**.
The original ship request or approval of unseen text is insufficient. Wait for the answer.
If the brief, source or options need changing, cancel and land the unstarted record, then
repeat setup, display and confirmation for a new run.

## Start and follow the run

After confirmation, launch exactly the admitted record:

```bash
flowcrew start <run-id>
```

`<run-id>` is setup's returned `run`; start takes no brief file or setup options.
Report the operation result and retain the run id beside the brief. On an unknown outcome
follow the [exit-code rules](../guide/cli.md#exits-and-storage).
For requester binding see [session integration](../guide/session-push.md).

[CLI controls](../guide/cli.md#read-and-steer) cover status, guidance, cancel and resume;
[operations](../guide/operations.md#inspect-guide-and-stop) covers guidance delivery,
replacement plans and recovery after restart.

## Human wrap-up

Judge each criterion and limitation against the deliverables, command evidence and rejected
reviews (`flowcrew status <run-id>`, including `stages[].summary`). A status label, model
summary or zero CLI exit alone does not establish acceptance.

If the user accepts a criterion as unmet, cancel the run instead of sending guidance:
guidance cannot change frozen criteria. On the first land, record each accepted unmet
criterion and the user's reason, for example
`flowcrew land <run-id> --accept-unmet 'C3=Accept plateau at 0.842'` (repeat the option for
more criteria). The delivery keeps the latest gate evidence and the human's decision;
the run status stays as recorded. Acceptance records cannot be added after delivery.

Land deletes raw evidence, including stored brief bytes, so preserve anything still needed
beyond declared outputs first. Once the result is independently accepted and deletion is
authorized (terminal status alone does not authorize it), run `flowcrew land <run-id>`.
[Preservation](../guide/operations.md#preserve-and-reclaim) describes the archive and
`changes.patch`: apply it from the source project with `git apply`, and use the full archive
for changes Git cannot represent. Land does not merge into the source project.
