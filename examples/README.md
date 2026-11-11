# Examples

For a new user: which complete example can I run without a model?
Run from the repository root after the [local build](../guide/getting-started.md#install-in-a-development-checkout).

## Rehearse a research contract

```bash
node dist/cli.js rehearse examples/hello-research.brief.md
```

The [brief](hello-research.brief.md) declares frozen evaluator inputs, baseline replicates,
structured guards, held-out allowance and a submission budget. Rehearsal constructs and
admits the same producer and independent candidate-property reviewer as a real run, then
dispatches them through the scheduler with labelled scripted results in private temporary
project/state directories. It calls no model or declared instrument. A ready verdict proves
dispatch wiring, not an improvement or working instrument. The printed diagnostic log remains
available after temporary project/state cleanup.

For static input checks only:

```bash
node dist/cli.js rehearse examples/hello-research.brief.md --static-only
```

## Inspect an isolated run archive

With `FC_HOME` set by you to a disposable empty state directory, this reads the selected
project and reports no runs:

```bash
node dist/cli.js status --project "$PWD"
```

Without that environment choice it reads normal operator history. Read [configuration](../guide/configuration.md#runtime-environment)
and [operations](../guide/operations.md) before using live controls.

## Mock fixtures

[plan.json](mock-fixtures/plan.json) and [single.json](mock-fixtures/single.json) are deterministic
adapter fixtures. `MOCK_FIXTURE_DIR` selects per-stage JSON; the mock adapter can write fixture
files under the run root and returns typed records without calling a model. The shipped
one-author plan lacks a downstream independent gate. It is not a current complete quick-launch
example, and a one-line task with no criteria cannot be admitted by acknowledgment alone.
Use rehearsal above for the supported first result; no live quick recipe is implied by these
fixtures.

Sources: [mock](../src/adapters/mock.ts), [scripted results](../src/adapters/scripted.ts),
[rehearsal](../src/rehearse.ts), [launch admission](../src/cli.ts).

The [instrument example](research-instrument.brief.md) declares four baseline replicates,
a structured guard and two held-out uses. Both shipped research briefs use the measurement
contract. Real runs fail closed at calibration before dispatch if their instrument is unavailable.
