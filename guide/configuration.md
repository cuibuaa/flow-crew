# Effective configuration

For operators choosing runtime roles and storage. Setup selects the installed package's
`config/runtime.json` unless `--config <file>` selects another file. It checks declarations,
input/output facts and effective settings, then records the configuration and pins the
runtime. Start launches that record; resume uses its original pin. Project-local defaults
do not select configuration.

| Field | Declaration |
|---|---|
| `roles` | Required nonempty list of `{id, description, backend, model, effort, prompt?}` |

Role IDs must be unique. Backend is `codex` or `claude`. Model and effort are nonempty
strings; `description` is a string; `prompt` is optional (default empty) and is appended to
the shipped instruction for the stage purpose in `config/roles/<purpose>.md` (`plan`, `work`
or `gate`). Unrelated unknown configuration and role fields are refused.

The retired runtime keys `sharedCaches`, `devices` and `providerHomes` are accepted and
ignored; omit them. Setup prints an advisory on stderr. Retired brief keys are listed in
the [brief contract](brief-contract.md#inputs-outputs-and-validation).

## Precedence and adapters

Setup's `--backend codex|claude` replaces the backend of every role; without it, the run uses
the first configured role's backend. Setup records the settings start will use. Give all roles of a
configuration the same backend; a role whose backend differs from the run's is refused when it is first invoked.
There is no automatic installed-provider chooser. Live work needs that provider
installed and authenticated. A role's explicit model and effort take precedence. The value `default` selects native
settings and then built-in defaults; setup records each selected value and its source.
Provider invocations retain caller context and selected native settings. Command environment defaults and overrides are in the
[brief contract](brief-contract.md#inputs-outputs-and-validation).
All programs retain the OS account's ordinary filesystem permissions.

The old configuration keys `bounds` and `adapterInputLimitChars` are also accepted and
ignored, with an advisory; omit them.

The only run backstop is the [C2 holding pattern](operations.md#inspect-guide-and-stop): three consecutive gate
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
`pins/<run-id>/`, `work/<run-id>/` and the raw evidence in `runs/<run-id>/`; `status.json`
and the controller lock with its SQLite sidecars remain.
Relative outputs are under `project/<path>`, absolute outputs under `external/<n>` listed
in `manifest.json`, which lists every output, and `changes.patch` is always at the delivery root
for admitted runs (empty without relative outputs, explicit comment if the base is unknown). External outputs also stay
in place. SQLite history/status remain. Landing is manual; use repeatable
`--accept-unmet 'C3=reason'` to record human acceptance of unmet criteria in the delivery
manifest. See [operations](operations.md#preserve-and-reclaim).
Until cleanup completes, status reports a retained measurement as `heldBytes` or
`heldSpacePending: true` when unmeasured; the dashboard marks the held total incomplete.
Status reads never measure or rewrite the published file. Cancel and land use a fixed
30,758-ms controller observation window and retain work on refusal; it is not configurable.
