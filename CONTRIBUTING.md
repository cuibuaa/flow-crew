# Contributing to FlowCrew

FlowCrew requires Node.js 22.5 or newer. Install exactly from the lockfile and
run the same quality sequence expected by CI:

```bash
npm ci
npm run build
npm run build:ui
npm run lint
npm test
```

## Tests

`spec/` is the tracked, machine-independent public suite. `tests/` is an
ignored private workbench and must remain ignored. The root Vitest configuration
runs both when both exist; a clean clone contains only `spec/`.

> If a test needs anything from your own machine, it does not belong in `spec/`.

Before moving a test into `spec/`, make it independent of home-directory state,
agent CLIs, real network access, local project names and paths, child processes,
and personal run history. The self-test in `spec/spec-purity.test.ts` reports
the precise file, line, and rule when this boundary is crossed. See the
[detailed contributing guide](guide/contributing.md) for the full public-test
contract.

Add or update a public test when changing observable behavior. Keep a test in
the private workbench only when its environment-specific fixture cannot meet
the public contract.

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
