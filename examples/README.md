# Examples

For brief authors checking the current grammar without a model. Build the
[local CLI](../guide/getting-started.md#install-in-a-development-checkout) first.

## Check a brief

Save this minimal current declaration as `brief.md` in your selected project:

```yaml
---
criteria:
  - {id: report, text: Produce a report answering the goal with original evidence.}
inputs: []
outputs:
  - {path: report.md, kind: file, existing: create}
commands:
  - id: reportExists
    argv: [/usr/bin/test, -s, report.md]
    env: {}
    inputs: []
    required: true
    dependsOn: [report.md]
results: []
allowBlocked: false
---
Describe a concrete goal and what evidence the report must show before live use.
```

Then check it from the repository root (or use an installed `flowcrew`):

```bash
node dist-rewrite/cli.js setup brief.md --config config/runtime.json
```

Setup checks declarations, input/output facts and effective settings using the selected
configuration. It prints the brief digest, command IDs and host-rights execution boundary,
calls no model or provider and executes no declared command. Start rechecks mutable
content facts on its per-run project copy; execution establishes command feasibility.
All authors, providers and commands run with the OS account's ordinary rights. Declared
paths define evidence and products; they do not prevent writes to other host paths.
Read the [full execution boundary](../guide/operations.md#platform-boundaries).
The minimal declaration is a grammar example: add actual task inputs, validation
commands and outcome criteria before starting live work. See the [brief contract](../guide/brief-contract.md).

## Inspect runs

```bash
node dist-rewrite/cli.js status
```

This lists all run directories in the selected store. To avoid reading normal history,
select a disposable empty state directory through `FC_HOME` and ensure no independent
`FLOWCREW_STORE_ROOT` override selects another store. See [storage](../guide/configuration.md#storage-and-runtime).

## Research briefs

Research is an ordinary brief. A declared evaluator command measures; criteria and
result labels say what counts; independent review judges the evidence. Two small
examples share one shape. Each brief sits beside a project directory of the same name,
which is the `--project` to select:

| Brief | Project | What it shows |
|---|---|---|
| [research-instrument.brief.md](research-instrument.brief.md) | `research-instrument/` | Positive case: a cheaper valid candidate exists. The honest result is `improved`. |
| [research-ceiling.brief.md](research-ceiling.brief.md) | `research-ceiling/` | Negative control: every item is required, so no valid candidate beats the baseline. The honest result is `no_improvement`, accepted with evidence. |

In both, `evaluate.sh` and its data files are `frozen: true` inputs, `candidate.txt` is the
author's output, and the evaluator runs as the `required: true` command `evaluate`. It
uses only shell built-ins: it finishes in well under a second with no network, GPU or
model. The criteria require the report to state the measured baseline, the candidate
measurement and the evaluator receipt. The `results` labels name the allowed outcomes;
`allowBlocked: true` in the positive example also lets a run end as blocked when the
evaluator cannot run. The negative control sets `allowBlocked: false`, so the only way to
finish is a measured result.

Check both without a model, from the repository root:

```bash
export FC_HOME="$(mktemp -d)"   # disposable state; unset FLOWCREW_STORE_ROOT
node dist-rewrite/cli.js setup examples/research-instrument.brief.md --project examples/research-instrument
node dist-rewrite/cli.js setup examples/research-ceiling.brief.md --project examples/research-ceiling
```

Setup prints the brief digest and the command ID `evaluate`; it runs no command and calls
no model. To run an example for real (this starts a live Claude Code author and gate, and
uses your account), start it against the same disposable `FC_HOME`, then follow it:

```bash
node dist-rewrite/cli.js setup examples/research-instrument.brief.md --project examples/research-instrument --backend claude
node dist-rewrite/cli.js start <run-id>
node dist-rewrite/cli.js status <run-id>
```

`start` prints the run id. The run works on a per-run copy, so the files under
`examples/` stay unchanged. Expected outcomes: the positive example ends accepted with
result `improved` (the best valid candidate keeps only `item-a`, cost 1 against a baseline
of 7). The negative control ends accepted with `no_improvement`, with the unchanged
baseline of 7 and the reason in the report. After reviewing, `land <run-id>` preserves
`candidate.txt` and `report.md` under `deliveries/<run-id>/project/` in the store and then deletes the
run's project copy, runtime pin, work root and raw evidence. The delivery root also contains
`manifest.json` and `changes.patch`; absolute outputs use `external/<n>` slots listed in the manifest.
Until cleanup completes, status shows `heldBytes` or `heldSpacePending` with an incomplete held total.
Cancel and land refuse unconfirmed controller exit after a 30,758-ms observation window,
retaining work and giving repeat-cancel/land advice. Remove the disposable directory when done.

A spec checks every `examples/*.brief.md` against its project directory, so a brief the
current grammar refuses fails the portable suite.
