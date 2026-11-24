# Contributing

For a contributor: how do I make and validate a repository change?

Read [AGENTS.md](AGENTS.md) first; it takes precedence over this guide. Prefer removing or
restructuring a mechanism over adding a parallel exception. Explain any new mechanism's
cost and verify the behavior it changes. [Architecture](guide/architecture.md) names the
boundaries; [agent protocol](guide/agent-protocol.md) describes submitted results.

## Build and validate

Node.js 22.22.2 or newer, Git, Python 3 and rsync are required (`engines` in
[package.json](package.json); the system rsync on macOS is enough). In a development checkout,
install the lockfile dependencies, then build:

```bash
npm ci --ignore-scripts
npm run build
```

The build compiles `rewrite-src/` to `dist-rewrite/`, `rewrite-monitor/` to `dist-monitor/` and
bundles the session hook. Tests need that output: the test runner's global setup stops with
"Build is missing or stale" if any source is newer than `dist-rewrite/.built`, so rebuild after
every source change. `npm run build:clean` deletes both output directories first.

The test commands, all from [package.json](package.json):

| Command | What it runs |
|---|---|
| `npm run lint` | ESLint over `rewrite-src/`, `rewrite-monitor/`, the Claude hook, the hook spec, `scripts/package-install.mjs` and two native test files |
| `npm run typecheck` | `tsc --noEmit` for `tsconfig.rewrite.json` and `rewrite-monitor/tsconfig.json` |
| `npm run test:portable` | The `portable` Vitest project: every `spec/**/*.test.ts` except `spec/native/`, `spec/private/` and `spec/benchmark/`. No network, no agent CLIs, synthetic fixtures |
| `npm run test:native` | The `native` project: `spec/native/**/*.test.ts`, which start real child processes, Git, rsync and Unix sockets |
| `npm test` | `test:portable`, then `test:native` |
| `npm run test:isolation` | The portable suite in a `node:22.22.2-bookworm` container with no network, a clean home and no agent CLIs (needs Docker; fetches the image if absent) |
| `npm run test:package` | Exports the Git index (stage new files first), builds it, installs the packed tarball and the source tree into private prefixes and runs the public CLI against both (uses the public npm registry) |
| `npm run test:private` | The `private` project, `spec/private/`: fixtures supplied through `FLOWCREW_PRIVATE_FIXTURES`, read-only; for maintainers |
| `npm run test:benchmark` | The content-measurement baseline in `spec/benchmark/` (no provider or network); takes an optional absolute directory for its evidence files |

Before sending a change run at least `npm run build`, `npm run lint`, `npm run typecheck` and
`npm run test:portable`. Run `npm run test:native` too when you touch process handling, records,
the CLI or the monitor; it is much slower than the portable suite.

### Short temporary directory

Native tests bind Unix domain sockets under `$TMPDIR`. A socket path is limited to 108 bytes on
Linux and 104 on macOS, and the test setup adds its own directory below `$TMPDIR`, so a long
`TMPDIR` (such as a deep per-user directory) makes the bind fail. Run the
tests with a short one:

```bash
TMPDIR=/tmp npm run test:native
```

### What CI runs

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push, pull request and manual
dispatch, using Node.js 22.22.2 and `npm ci --ignore-scripts`:

- **portable** (Linux): `npm run build`, `npm run lint`, `npm run typecheck`, then
  `npm run test:isolation` (the portable suite inside the container above).
- **native-linux** and **native-macos** (`macos-15`): `npm run build`, then `npm run test:native`.
- **package-install** (Linux and macOS): `npm run test:package`.

A change is not validated by a passing build, lint and portable run alone: native and package
results come from CI or from running those commands yourself. Report missing prerequisites and
failed checks rather than choosing a smaller suite.

Sources: [package scripts](package.json), [builder](scripts/build.ts),
[test config](vitest.config.ts), [CI](.github/workflows/ci.yml),
[isolation script](scripts/test-isolation.sh).

## Public test and privacy boundary

Public specs use deterministic fixtures and explicit state isolation. They must not depend
on personal files, agent CLIs, live network, private run history or installation-specific
paths. [The purity check](spec/spec-purity.test.ts) enforces that boundary and names the
file, line and rule. The test runner's global setup also fails on tracked text that contains
a path under a user's home directory (Linux, macOS, WSL drive mounts or a Windows user
profile) or a run identifier, and on tracked files that match Git ignore rules. Keep
environment-specific harnesses outside the public repository.
Research review checks candidate properties. Engine-owned measurements and structured guards judge numbers;
[brief contract](guide/brief-contract.md#research-briefs) describes the single contract.

Keep public ignores generic. Clone-local private exclusions belong in `.git/info/exclude`;
forced staging can bypass ignore rules, so review staged bytes too. Never publish credentials,
private names, personal home paths or actual local run/task identifiers.

## Review and submission

Release conventions live in [`scripts/release.sh`](scripts/release.sh). Run it with
`--help` for the workflow: add a dated changelog section, `prepare <version>`, then
`squash <version> --message-file <file>` to build and prove the two-commit release
branch. Review it and explicitly push `release-v<version>:tests` (using
`--force-with-lease` when replacing tests history). Once CI on tests succeeds,
`publish <version> --commit release-v<version>` fast-forwards main, pushes the
annotated tag and creates the latest GitHub release from that changelog section.

Add meaningful regression coverage for observable behavior changes. For documentation changes,
check every statement against the code, check the command syntax, and run
`npm run test:portable`: it resolves relative links and heading anchors in the README, guides,
examples and skill sources, and checks the README badge and changelog against `package.json`.
Do not weaken a test to obtain a green result. For a dashboard change, open the page
(`flowcrew monitor`) in a browser with realistic run data and assess labels, duplication,
readability and the primary reading flow; the tests check the rendered text, not whether the
page is usable.

Use a short imperative commit subject, stage only related paths and omit `Co-Authored-By`
trailers. Follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md): explain the problem and
result, related issue, validation, test coverage and documentation. Explain unchecked items.
Before upgrading Vitest, inspect the experimental custom pool exports, ready handshake and
worker tests used by [vitest.config.ts](vitest.config.ts).
