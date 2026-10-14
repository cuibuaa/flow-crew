# Examples

For a new user: which complete example can I run without a model?
Run from the repository root after the [local build](../guide/getting-started.md#install-in-a-development-checkout).

## Rehearse a research contract

```bash
node dist/cli.js rehearse examples/hello-research.brief.md
```

The [brief](hello-research.brief.md) counts tracked TypeScript with a numeric baseline, round
schema, stop budget, confirmation command and terminal paths. Rehearsal uses a scripted
adapter in a disposable project/state and calls no model. It deliberately exercises a false
ship candidate whose confirmation fails, then a ceiling. Exit zero with Contract ready checks
wiring; it does not measure a real result for your project. The engine log path printed by
rehearsal remains available after temporary project/state cleanup.

Inspect only the static contract when you do not want its shell confirmation executed:

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
