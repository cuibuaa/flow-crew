# Effective configuration

For operators choosing runtime roles and storage. Setup and start select the installed
package's `config/runtime.json` unless `--config <file>` selects another file. Both
use the same preparation owner to check declarations, input/output facts and effective
runtime settings. Start authenticates a run-local runtime copy and records its effective
configuration; resume uses that original pin. Project-local defaults do not select configuration.

| Field | Declaration |
|---|---|
| `roles` | Required nonempty list of `{id, description, backend, model, effort, prompt?}` |

Role IDs must be unique. Backend is `codex` or `claude`. Model and effort are nonempty
strings; `description` is a string; `prompt` is optional (default empty) and is appended to
the shipped instruction for the stage purpose in `config/roles/<purpose>.md` (`plan`, `work`
or `gate`). Unrelated unknown configuration and role fields are refused.

The retired runtime keys `sharedCaches`, `devices` and `providerHomes` are accepted
and ignored regardless of value. At the existing parse boundary, one visible advisory
explains that all authors, providers and commands run with host-account rights and
these keys constrain nothing. They are omitted from new templates and admitted settings.
The retired brief key `commands[].unconfined` has the same advisory and no execution effect;
see the [brief contract](brief-contract.md#inputs-outputs-and-validation).

## Precedence and adapters

Setup and start select `--backend codex|claude`, which replaces the backend of every role, or else the
first configured role's backend; setup's preview shows the backend start would run. Give all roles of a
configuration the same backend; a role whose backend differs from the run's is refused when it is first invoked.
There is no automatic installed-provider chooser. Live work needs that provider
installed and authenticated. A role's explicit model and effort take precedence. The value `default` selects native
settings and then built-in defaults; start records each selected value and its source.
Provider invocations retain caller context and selected native settings. Declared commands
use their exact declared environment, with invocation scratch as TMPDIR only when absent.
All programs retain the OS account's ordinary filesystem permissions.

For old configurations, `bounds` and `adapterInputLimitChars` are accepted and ignored
regardless of their values. Configuration parsing emits one advisory naming every supplied retired key; their values
are absent from admitted records, status and invocation input. They have no execution
consumer.

The only run backstop is the [C2 holding pattern](brief-contract.md): three consecutive gate
rejections (counting the one that last set the best pass count), or four failures without a
completion, pause and ask while retaining work. Provider context
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
`flowcrew land <run-id>` copies the declared outputs to `deliveries/<run-id>/` and then deletes
`pins/<run-id>/`, `work/<run-id>/` and everything in `runs/<run-id>/` except `status.json`;
external outputs also stay in place. SQLite history/status remain. Landing is manual and takes
no options; see [operations](operations.md#preserve-and-reclaim).
Until then, status reports the space an ended run holds as `heldBytes`.

Sources: [entry defaults](../rewrite-src/cli.ts), [public options](../rewrite-src/ops/main.ts),
[runtime grammar](../rewrite-src/contract/runtime.ts),
[prepared output facts and settings](../rewrite-src/exec/policy.ts),
[shipped configuration](../config/runtime.json).
