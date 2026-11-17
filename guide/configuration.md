# Effective configuration

For operators choosing runtime roles, physical resources and storage. New runs use the
installed package's `config/runtime.json` unless start selects `--config <file>`.
Start authenticates a run-local runtime copy and records its effective configuration;
resume uses that original pin. Public setup checks brief grammar and host readiness,
not runtime settings or exact grants. Project-local defaults do not select configuration.

| Field | Declaration |
|---|---|
| `roles` | Nonempty list of `{id, description, prompt, backend, model, effort}` |
| `sharedCaches` | Literal paths granted shared writes |
| `devices` | Literal device paths, such as `/dev/null` |
| `providerHomes` | `{codex: [...], claude: [...]}` provider-specific literal paths |

All fields are required. Role IDs, shared cache paths and device paths must be unique.
Backend is `codex` or `claude`. Prompt, model and effort are nonempty strings. Unknown
configuration and role fields are refused.

## Precedence and adapters

Start selects `--backend codex|claude` or the first configured role's backend for the
run. There is no automatic installed-provider chooser. Live work needs that provider
installed and authenticated. A role's explicit model and effort take precedence. The value `default` selects native
settings and then built-in defaults; start records each selected value and its source.
Provider homes belong only to the selected provider's invocation. Declared commands
receive neither provider's writable home grant.

For old configurations, `bounds` and `adapterInputLimitChars` are accepted and ignored
regardless of their values. Configuration parsing emits one advisory per supplied key; their values
are absent from admitted records, status and invocation input. They have no execution
consumer.

The only run backstop is the [C2 holding pattern](brief-contract.md): three gate rejections
without a new best, or four failures, pause and ask while retaining work. Provider context
exhaustion is reported by the provider. A command's optional `durationMs` belongs to that
command's declaration.

## Storage and runtime

The default state directory is `$XDG_STATE_HOME/flowcrew`, otherwise
`$HOME/.local/state/flowcrew`. It contains `state.sqlite` and the default `store/`.
`FC_HOME` overrides the database directory and its default store; an explicit
`FLOWCREW_STORE_ROOT` independently overrides the store. Use a local filesystem with
SQLite WAL support. `FLOWCREW_RUNTIME_ROOT` overrides the installed package used for
new runs; it does not redirect existing pins.

Under the store, `runs/<run-id>/` holds raw evidence and `status.json`,
`pins/<run-id>/` holds the runtime copy, and `work/<run-id>/` holds isolated work.
After explicit reclaim, relative deliveries remain at `deliveries/<run-id>/`;
external outputs stay in place. SQLite history/status remain. Reclaim is manual;
see [operations](operations.md#preserve-and-reclaim).

Sources: [entry defaults](../rewrite-src/cli.ts), [public options](../rewrite-src/ops/main.ts),
[runtime grammar](../rewrite-src/contract/runtime.ts),
[prepared authority and settings](../rewrite-src/exec/policy.ts),
[shipped configuration](../config/runtime.json).
