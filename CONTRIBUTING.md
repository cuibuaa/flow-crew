# Contributing

For a contributor: how do I make and validate a repository change?

Read [AGENTS.md](AGENTS.md) first; it takes precedence over this guide. Prefer removing or
restructuring a mechanism over adding a parallel exception. Explain any new mechanism's
cost and verify the behavior it changes. [Architecture](guide/architecture.md) names the
boundaries; [agent protocol](guide/agent-protocol.md) describes submitted results.

## Build and validation

Node.js 22.5 or newer is required. In a development checkout, install lockfile dependencies:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix ui
```

The CI quality job runs the combined engine/UI build, lint and full test suite:

```bash
npm run build
npm run lint
npm test
```

Build includes backend TypeScript, both UI type checks and Vite. `build:ui` delegates to the
same combined builder. `npm run build -- "$BUILD_ROOT"` sends `dist`, `ui/dist` and `.cache`
to a chosen output root; set `BUILD_ROOT` to a directory you own. Staging uses the temporary
root. Vite may write its bootstrap cache in UI dependencies, so use an isolated source and
dependency copy when those dependencies are shared or a checkout serves other work.
Build publication refuses replacement of a live distribution. Tests use the checkout's
`dist` and its manifest: a private build alone does not redirect them. Validate an isolated
copy with identical source/configuration and its freshly built distribution.

The root Vitest configuration includes `spec/**/*.test.ts`, `.test.tsx` and the recorded
UX performance replays. `test:baseline-identities` excludes those replay files for an explicit
population comparison; it is not the full suite. `test:ux-perf` selects a focused replay
configuration. `build:clean` removes `dist` before building; it is unsuitable for a live root.

On Linux with Docker, the separate public-spec isolation acceptance condition is:

```bash
npm run test:isolation
```

The script uses `node:22-bookworm`, no container network, a clean home, no agent CLIs and an
empty passwd file for the caller UID. Docker may fetch the image if absent. It inherits the
caller's CPU affinity. A passing build/lint/test set does not establish this separate check.
CI also tests portable process supervision without a service manager and on macOS. Report
missing environment prerequisites and failed checks rather than selecting a smaller suite.

Sources: [package scripts](package.json), [builder](scripts/build.ts),
[test config](vitest.config.ts), [CI](.github/workflows/ci.yml),
[isolation script](scripts/test-isolation.sh).

## Public test and privacy boundary

Public specs use deterministic fixtures and explicit state isolation. They must not depend
on personal files, agent CLIs, live network, private run history or installation-specific
paths. [The purity check](spec/spec-purity.test.ts) enforces that boundary and names the
file, line and rule. Keep environment-specific harnesses outside the public repository.
Use immutable injected research evidence or the framework manifest for round checks;
[brief contract](guide/brief-contract.md#research-rounds) explains mutable slots.

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
check source truth, recipe syntax and local links. Do not weaken a test to obtain a green result.
For a dashboard change, exercise actual routes and controls in a rendered browser at realistic
scale; the routes are in [App.tsx](ui/src/App.tsx). Assess labels, duplication, readability,
purpose and the primary reading flow using the [reviewer role](config/agents/doc_reviewer.yaml).
Tests and payload checks do not establish visual usability.

Use a short imperative commit subject, stage only related paths and omit `Co-Authored-By`
trailers. Follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md): explain the problem and
result, related issue, validation, test coverage and documentation. Explain unchecked items.
Before upgrading Vitest, inspect the experimental custom pool exports, ready handshake and
worker tests used by [vitest.config.ts](vitest.config.ts).
