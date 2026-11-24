# Getting started

For new users installing FlowCrew and preparing a run before live work.

## Install in a development checkout

Use Node.js 22.22.2 or newer, Git, Python 3 and rsync. The system rsync on macOS
is supported; GNU rsync is not required.
Read [platform boundaries](operations.md#platform-boundaries) for macOS, Ubuntu and containers.

```bash
git clone https://github.com/cuibuaa/flow-crew.git
cd flow-crew
npm ci --ignore-scripts
npm run build
npm link
flowcrew --help
```

The build produces the CLI, monitor and standalone session hook. Check `which flowcrew`
to confirm the checkout selected. `npm unlink -g flowcrew` removes the command link.

## Prepare a run

Write a self-contained brief using the [contract](brief-contract.md). Save it outside the
project in a separate folder per task, for example `<briefs-dir>/<task>/brief.md`, and use
a new filename for each revision. Setup copies the entire project except `.git`, including
ignored files, so keeping briefs outside it avoids copying unrelated tasks into every run.
From your project directory:

```bash
flowcrew setup <brief>
```

Here `<brief>` is the path to that saved file. Setup admits a run and prints its `run` id,
brief digest, project, command IDs and effective settings. It creates the runtime pin and
project copy without calling a model, provider or declared command. Optional `--project`,
`--backend` and `--config` select the project and runtime at this point
([CLI](cli.md#setup-and-start)); setup success proves no validation result.

## Start live work

Live work needs an installed, authenticated Codex CLI or Claude Code. Runtime
[configuration](configuration.md) chooses roles and provider settings. Read the brief,
setup result and [execution boundary](operations.md#platform-boundaries) before starting:

```bash
flowcrew start <run-id>
flowcrew status <run-id>
```

Replace `<run-id>` with setup's returned `run`. Start launches that saved record; editing
the original brief or configuration does not change it. Status shows its brief digest;
`flowcrew status <run-id> --brief` prints the stored brief before land. To discard an
unstarted run, cancel it and land it. A successful launch is not acceptance.

## Inspect runs and storage

```bash
flowcrew monitor
flowcrew status <run-id>
```

Monitor prints its URL, by default `http://127.0.0.1:8795`. It reads the CLI's selected
store and serves GET only. Use `--port N`, `--host H` or repeated `--store-root DIR`
to select another listener or stores. Expand run details to inspect tries, checkpoints
and stop reasons; act in the owning coding-agent session. See [operations](operations.md#inspect-guide-and-stop).

Use the [controls](cli.md#read-and-steer) to guide, cancel or resume a run; recovery after
host restart needs explicit resume. After review, `flowcrew land <run-id>` preserves its
outputs and patch, then deletes its project copy, runtime pin and raw evidence, including
the stored brief. See [preservation](operations.md#preserve-and-reclaim) for the archive
layout and applying changes. [Configuration](configuration.md#storage-and-runtime) owns
storage locations and overrides.

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
then starts the admitted run id. `/fc-status` or `$fc-status` displays store/run status.
