# Examples

For a new user: which complete example can I run without a model?
Run from the repository root after the [local build](../guide/getting-started.md#install-in-a-development-checkout).

## Rehearse a research contract

```bash
node dist/cli.js rehearse examples/hello-research.brief.md
```

The [brief](hello-research.brief.md) declares a versioned frozen project instrument,
its candidate roots, argv/environment, author instruction and finite round budget.
Rehearsal inspects the declaration and capabilities. It calls no model or instrument
and fabricates no author/review result. Real execution tests belong to the project
instrument and the engine's controlled protocol fixture.
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

The [instrument example](research-instrument.brief.md) uses the same protocol.
Initialize, evaluate and finalize execute the retained program with a read-only JSON
request. A failed executable is an execution error, never a project reject.
