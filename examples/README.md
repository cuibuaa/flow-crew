# FlowCrew examples

These examples provide two token-free ways to inspect FlowCrew before allowing
a real agent to run, plus a campaign configuration that is safe to validate in
dry-run mode.

| File | Purpose | Safe first command |
|---|---|---|
| `hello-research.brief.md` | Minimal research contract with a metric, stop policy, confirmation command, and terminal paths | `flowcrew rehearse examples/hello-research.brief.md` |
| `example_campaign.yaml` | Minimal campaign schema wired to the research brief | `flowcrew campaign run examples/example_campaign.yaml --dry-run` |
| `mock-fixtures/` | Deterministic `plan` and `single` stage responses for the mock adapter | See the isolated mock loop below |

## Rehearse the research brief

From the repository root:

```bash
flowcrew rehearse examples/hello-research.brief.md
```

Rehearsal uses the real scheduler with an in-process scripted adapter in
temporary directories. It launches no agent process or model, consumes no
tokens, and removes its temporary state when finished. The command should exit
0 and its rehearsal report should include:

```text
✅ Contract ready
```

This verdict means the brief parsed and the scheduler exercised its research
round, result schema, stop decision, confirmation gate, and terminal artifact
path. It does not validate a real research conclusion. The scripted rehearsal
deliberately presents a false ship candidate in an empty temporary repository;
the confirmation command rejects it, proving that the loop continues to an
honest terminal result.

## Inspect the campaign plan

```bash
flowcrew campaign run examples/example_campaign.yaml --dry-run
```

Expected output starts with `Campaign dry run:`, shows the resolved paths and
one-run budget, and ends with:

```text
Campaign hello-research-example: dry_run
```

`--dry-run` does not start a campaign or an agent. The example's
`launch.systemdUnit` and `launch.launchScript` are placeholders; replace both
with values for your own launcher before attempting a live campaign.

## Run a complete mock loop

The mock adapter reads `<stage-id>.json` from `MOCK_FIXTURE_DIR`. The supplied
`plan.json` writes a one-stage dispatch, and `single.json` completes that stage.
Run it against temporary project and state directories so even the normal
`quick` brief write stays outside your clone:

```bash
demo_root="$(mktemp -d)"
mkdir -p "$demo_root/project"

FC_HOME="$demo_root/fc-home" \
MOCK_FIXTURE_DIR="$PWD/examples/mock-fixtures" \
flowcrew quick "show the zero-token execution loop" \
  --adapter mock \
  --project "$demo_root/project" \
  --max-iterations 1 \
  --no-supervise \
  --no-campaign \
  --acknowledge-brief-warnings
```

This one-line task string has no structured brief contract, so the brief preflight
that every launch path runs (see [Zero-token rehearsal](../guide/rehearse.md)) flags it
and pauses before creating a run. `--acknowledge-brief-warnings` is the explicit,
scriptable way past that pause — it is not bypassing a check, it is answering the
question the check raised. Omit it and the command prints the same preflight report
a real launch would, then stops.

The run should exit 0, identify `Adapter: mock`, and finish with
`Workflow "default" complete`; both `plan` and `single` should be marked
complete. The fixtures report zero input and output tokens and cannot invoke a
model. Demo artifacts, including the normal `docs/task_brief.md` write, remain
under the path stored in `demo_root`.

Only `rehearse` is the no-agent contract preflight. A normal `quick` command
with the `codex` or `claude` adapter grants that unattended agent shell access
and can run for hours.
