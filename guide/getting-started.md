# Getting started

For a new user: how do I install FlowCrew and check a brief before live work?

## Install in a development checkout

Node.js 22.5 or newer is required. The package uses Node's built-in `node:sqlite`. Git is needed for
the worktree setup procedure. Process supervision supports Linux with or without a systemd
user session and macOS; see [architecture](architecture.md) for identity limits.

Run these installation commands from a checkout you own:

```bash
git clone https://github.com/cuibuaa/flow-crew.git
cd flow-crew
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix ui
npm run build
node dist/cli.js --help
```

The combined build produces the engine and dashboard. These commands use the local CLI;
[contributing](../CONTRIBUTING.md) explains private build destinations for a checkout serving
other work. The package's ordinary postinstall also installs UI dependencies and builds, so
using `--ignore-scripts` above makes those steps explicit.

If you want `flowcrew` on your shell path, `npm link` changes the global command link. Check
which checkout that link selects with `which flowcrew` before using it. `npm unlink -g flowcrew` removes that global
link; it does not remove copied skills. Neither operation is necessary for the local commands
above.

## First safe result

Use the exact recipe in [examples](../examples/README.md#rehearse-a-research-contract).
Rehearsal launches no model. It parses the brief and exercises scripted research settlement;
engineering briefs receive static checks without that research simulation. A ready verdict
checks wiring, not research quality or a live agent's ability to complete the task.

Rehearsal executes a declared confirmation command in a disposable project. Review shell text
in an unfamiliar brief, or select `--static-only` as documented in [CLI](cli.md#inspection-and-setup).
The disposable project and state are removed unless `--keep` is selected; the diagnostics
path printed by the command is retained for inspection.

## Prepare live work

An authenticated Codex CLI or Claude Code is needed for live runs. FlowCrew's adapter resolver
checks executable presence; presence alone does not establish authentication. `node dist/cli.js
doctor` checks configuration, builds, skills, agent availability and authentication diagnostics.
It can inspect local agent authentication state and query the dashboard port. Review warnings;
exit zero can include warnings. Engine defaults, roles and workflows come from the installed
FlowCrew package; project configuration files do not replace them.

Install the shipped conversation integrations when you want them:

```bash
./skills/install.sh
```

The installer skips absent agent executables. Selectors are `--claude`, `--codex`, `--global`
and `--project`; the default is global and considers both agents. Claude copies go to the
user's `.claude/skills` directory; Codex copies go to the user's `.agents/skills` directory.
Each skill contains `SKILL.md` and linked guides copied into `references/`; checkout-only
links become plain text. Verified Claude bundles replace the old command files.
Project mode uses those directory names in the current project. Copies are byte-checked;
Codex installation additionally asks its app server to enumerate the skills. Invoke `/ship`
in Claude Code or `$ship` in Codex; the installer also supports `fc-status`.

Read [the ship procedure](../skills/ship.md) before handing off. It separates fact gathering,
brief authoring, exact-byte rehearsal and approval, target setup, and launch. For a brief you
already have, use [the CLI reference](cli.md#launch) and [brief contract](brief-contract.md).
Monitor and stop it through [operations](operations.md); do not edit its project concurrently.

Sources: [package](../package.json), [build](../scripts/build.ts),
[installer](../skills/install.sh), [doctor](../src/cli.ts), [rehearsal](../src/rehearse.ts).
