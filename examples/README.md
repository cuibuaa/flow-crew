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
commands: []
results: []
allowBlocked: false
---
Describe a concrete goal and what evidence the report must show before live use.
```

Then check it from the repository root (or use an installed `flowcrew`):

```bash
node dist-rewrite/cli.js setup brief.md
```

Setup parses the brief and tests real sandbox readiness. It calls no model and executes
no declared command. It prints no digest; exact resource preparation happens at start.
The minimal declaration is a grammar example: add actual task inputs, validation
commands and outcome criteria before starting live work. See the [brief contract](../guide/brief-contract.md).

## Inspect runs

```bash
node dist-rewrite/cli.js status
```

This lists all run directories in the selected store. To avoid reading normal history,
select a disposable empty state directory through `FC_HOME` and ensure no independent
`FLOWCREW_STORE_ROOT` override selects another store. See [storage](../guide/configuration.md#storage-and-runtime).

## Historical fixtures

[hello-research.brief.md](hello-research.brief.md) and
[research-instrument.brief.md](research-instrument.brief.md) use the retired research
frontmatter. They are historical fixtures, not accepted current brief examples.
The current grammar refuses their `research` key and lacks required fields; this page
does not provide a runnable launch recipe for them. Mock fixture files under
`mock-fixtures/` likewise belong to the former adapter protocol, not a supported backend.
Their migration or removal requires a separate change to the example artifacts.
