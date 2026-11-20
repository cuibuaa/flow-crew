# Getting started

For new users installing FlowCrew and checking a brief before live work.

## Install in a development checkout

Use Node.js 22.22.2 or newer, Git, Python 3 and rsync. The system rsync on macOS
is supported; GNU rsync is not required.
Read [platform boundaries](operations.md#platform-boundaries) for macOS, Ubuntu and containers.

```bash
git clone https://github.com/cuibuaa/flow-crew.git
cd flow-crew
npm ci --ignore-scripts
npm run build
node dist-rewrite/cli.js --help
```

The build produces the rewritten CLI, monitor and standalone session hook. Local CLI
commands need no global link. If desired, `npm link` installs a command link; check
`which flowcrew` before use. `npm unlink -g flowcrew` removes that link.

## Check a brief

Write a self-contained brief using the [contract](brief-contract.md), or copy the
minimal declaration in [examples](../examples/README.md#check-a-brief). From the project:

```bash
node dist-rewrite/cli.js setup docs/task_brief.md
```

Setup checks declarations, input/output facts and effective runtime settings without
calling a model, provider or declared command. It prints the exact brief digest, command
IDs and host-rights execution boundary. Use the same `--config` for setup and start;
setup establishes no command feasibility or validation result. Pass setup the same `--backend`
as start: the role lines it prints then show the backend the run will use.

## Start live work

Live work needs an installed, authenticated Codex CLI or Claude Code. Runtime
[configuration](configuration.md) chooses roles and provider settings. Read the brief,
setup result and [execution boundary](operations.md#platform-boundaries) before starting:

```bash
node dist-rewrite/cli.js start docs/task_brief.md
node dist-rewrite/cli.js status
```

`start --backend codex|claude` chooses the provider for the run; without it the run uses the
first configured role's backend (Codex in the shipped configuration).

All authors, providers and commands run with host-account rights, using a per-run project
copy as the default workspace. Start prints a run id. Use it with status and the [controls](cli.md#read-and-steer).
A successful launch is not acceptance. Recovery after host restart requires explicit
resume; upgrading the installation does not change an existing run's pinned runtime.

## Inspect runs and storage

With `npm link`, use `flowcrew --help` for the installed syntax; check `which flowcrew`
to confirm the checkout selected. Without a global link, replace `flowcrew` below with
`node dist-rewrite/cli.js`.

```bash
flowcrew monitor
flowcrew status <run-id>
```

Monitor prints its URL, by default `http://127.0.0.1:8795`. It reads the CLI's selected
store and serves GET only. Use `--port N`, `--host H` or repeated `--store-root DIR`
to select another listener or stores. Expand run details to inspect tries, checkpoints
and stop reasons; act in the owning coding-agent session. See [operations](operations.md#inspect-guide-and-stop).

Use `flowcrew guide <run-id> "guidance text"`, `flowcrew cancel <run-id>` and
`flowcrew resume <run-id>` for explicit controls. After reviewing the work,
`flowcrew land <run-id>` preserves the declared outputs and then deletes the run's project
copy, runtime pin, work root and raw evidence; it is not a read-only audit. Run it only on
an ended run (cancel a running or parked one first). Outputs are archived under
`store/deliveries/<run-id>/`, external outputs also stay in place, and SQLite history and
status remain; nothing is deleted unless preservation succeeds. Until a run is landed,
status (`heldBytes`) and the dashboard show the space it still holds.

Storage defaults to `$XDG_STATE_HOME/flowcrew` (or `$HOME/.local/state/flowcrew`),
containing `state.sqlite` and `store/`. `FC_HOME` overrides the database directory and
its default store; `FLOWCREW_STORE_ROOT` overrides the store independently.
`FLOWCREW_RUNTIME_ROOT` selects the installed package for new runs; existing runs retain
independent runtime copies. [Configuration](configuration.md#storage-and-runtime) lists the layout.

## Coding-agent skills

```bash
./skills/install.sh
```

Selectors are `--claude`, `--codex`, `--global` and `--project`; default scope is global
and absent agent executables are skipped. `--uninstall` reverses the install (changed skill
files are preserved) and `-h`/`--help` prints usage. Claude skills go under `.claude/skills`,
Codex skills under `.agents/skills`. Each has `SKILL.md` and linked guide files copied
into `references/`; checkout-only links become plain text. Project mode uses these
directories under the selected project. For Claude Code the installer also registers the session hook (Codex gets none), and
`--uninstall` removes that registration; see the current
[integration limitation](session-push.md#installation-boundary).

Invoke `/ship` in Claude Code or `$ship` in Codex. The [ship procedure](../skills/ship.md)
writes the brief with you, runs setup, shows both, waits for new explicit confirmation,
then starts unchanged bytes. `/fc-status` or `$fc-status` displays store/run status.

Sources: [package](../package.json), [build](../scripts/build.ts), [installer](../skills/install.sh).
