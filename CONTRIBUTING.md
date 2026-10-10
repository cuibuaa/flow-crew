# Contributing to FlowCrew

Read [AGENTS.md](AGENTS.md) first: the design principle there (the simplest architecture that solves the problem, and
no new mechanism that does not replace at least as much as it adds) decides what a change should look like.

FlowCrew requires Node.js 22.5 or newer. Install exactly from the lockfile and
run the same quality sequence expected by CI:

```bash
npm ci
npm run build
npm run build:ui
npm run lint
npm test
```

`npm run build` compiles in staging, then publishes exactly the current backend
output set to `dist`. Replacements and orphan removals share the publication
transaction; a failure restores the previous files and manifest. Previous
generations remain archived in `.cache/build-generations`. UI resources remain
available for older pages. If orphan removal would affect a live process using
that `dist`, publication refuses before writing: use an isolated checkout or
wait until its consumers stop. An archive does not redirect a running process's
later imports, so it cannot make deletion from a live root safe.

## Tests

`spec/` is the complete tracked, machine-independent suite. The root Vitest
configuration collects that suite, so a clean clone and CI exercise the same
published contracts.

> If a test needs anything from your own machine, it does not belong in `spec/`.

Before moving a test into `spec/`, make it independent of home-directory state,
agent CLIs, real network access, local project names and paths, child processes,
and personal run history. The self-test in `spec/spec-purity.test.ts` reports
the precise file, line, and rule when this boundary is crossed. See the
[detailed contributing guide](guide/contributing.md) for the full public-test
contract.

Add or update a public test when changing observable behavior. Keep
machine-specific harnesses outside the published repository when their
environment-specific fixtures cannot meet the public contract.

## Commits and pull requests

Write a focused commit with a short imperative subject. Do not add
`Co-Authored-By` trailers.

The pull request should follow `.github/PULL_REQUEST_TEMPLATE.md`:

- describe the change and link the related issue when applicable;
- report the build, UI build, lint, and test commands you ran;
- include tests for new or changed behavior; and
- update documentation for affected commands, contracts, or workflows.

Keep unrelated changes out of the pull request and explain any checklist item
that cannot be completed.
