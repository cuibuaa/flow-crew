# Getting started

For new users installing FlowCrew and checking a brief before live work.

## Install in a development checkout

Use Node.js 22.22.2 or newer and Git. Linux also needs bubblewrap, socat and ripgrep.
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

Setup checks syntax and actual sandbox readiness without calling a model or running
declared commands. It prints command IDs and explicitly defers execution. It does
not output a digest or prove command feasibility. `node dist-rewrite/cli.js doctor`
prints the sandbox diagnosis and any host administrator step; it does not apply that step.

## Start live work

Live work needs an installed, authenticated Codex CLI or Claude Code. Runtime
[configuration](configuration.md) chooses roles and provider settings. Read the brief,
setup result and [authority boundary](operations.md#platform-boundaries) before starting:

```bash
node dist-rewrite/cli.js start docs/task_brief.md
node dist-rewrite/cli.js status
```

Start prints a run id. Use it with status and the [controls](cli.md#read-and-steer).
A successful launch is not acceptance. Recovery after host restart requires explicit
resume; upgrading the installation does not change an existing run's pinned runtime.

## Coding-agent skills

```bash
./skills/install.sh
```

Selectors are `--claude`, `--codex`, `--global` and `--project`; default scope is global
and absent agent executables are skipped. Claude skills go under `.claude/skills`,
Codex skills under `.agents/skills`. Each has `SKILL.md` and linked guide files copied
into `references/`; checkout-only links become plain text. Project mode uses these
directories under the selected project. The installer also writes session hooks;
see the current [integration limitation](session-push.md#installation-boundary).

Invoke `/ship` in Claude Code or `$ship` in Codex. The [ship procedure](../skills/ship.md)
writes the brief with you, runs setup, shows both, waits for new explicit confirmation,
then starts unchanged bytes. `/fc-status` or `$fc-status` displays store/run status.

Sources: [package](../package.json), [build](../scripts/build.ts), [installer](../skills/install.sh).
