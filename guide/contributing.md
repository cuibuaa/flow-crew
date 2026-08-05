# Contributing guide

The repository has two deliberately different test surfaces. Keeping that
boundary intact is part of making a change reviewable from a clean clone.

## Public and private tests

`spec/` is the tracked public contract suite. It must run on any supported
machine with repository dependencies installed. Public tests may use temporary
directories, deterministic fakes, Fastify injection, and explicit
`setFcGlobalDir()` isolation; they may not depend on an operator's files,
history, agent CLIs, or network.

> If a test needs anything from your own machine, it does not belong in `spec/`.

`tests/` is an ignored private workbench for machine- or project-specific
harnesses. Do not weaken that ignore rule and do not move a test into `spec/`
until it passes the public purity gate.

`spec/spec-purity.test.ts` recursively enforces the public boundary. It scans
every source under `spec/` plus any Git-tracked source found under ignored test
trees, so a file forced in with `git add -f` still meets the same bar instead
of becoming a blind spot. In an exported archive, where Git metadata is absent, purity scans every test
source that the archive contains. It rejects host home paths,
mounted-drive and Windows paths, repository-escaping relative paths, direct
`node_modules` imports, local project identifiers, implicit home access,
unisolated child processes, real network clients, personal run/task history,
and externally required environment inputs that do not skip when absent.
Diagnostics name the file, line, and rule. `git add -f` therefore cannot make a
machine-local test invisible to the public gate.

The root Vitest configuration discovers both trees. Therefore:

- a clean clone runs only tracked `spec/` tests with `npm test`;
- a maintainer checkout may run both `spec/` and local `tests/` with the same
  command; and
- `npx vitest run spec` is the explicit public-only command.

CI proves the stronger environmental condition by running the public suite with
a clean home, no existing FlowCrew state, no agent CLI on `PATH`, and no network
for the test process.

## Public ignores and clone-local privacy

The tracked `.gitignore` is part of every published clone. Keep only generic
artifacts there, such as dependency directories, build output, coverage, and
logs. It must not contain a private project name, a personal absolute path, or
another identifier whose presence would itself disclose local work.

Protect local private paths and symbolic links in `.git/info/exclude` instead.
That file belongs to one clone, is never committed or published, and accepts
the same pattern syntax as `.gitignore`. This separation preserves both sides
of the boundary: a public cleanup cannot reveal private names, and removing a
public ignore cannot expose a local symlink to `git add -A`. Because both
ignore layers can be bypassed with `git add -f`, the tracked-test purity gate
remains the final mechanical check for test sources that enter the repository
from an ignored directory.

## Local verification

Use Node.js 22.5 or newer. From a fresh dependency install, run:

```bash
npm ci
npm run build
npm run build:ui
npm run lint
npm test
```

Vitest upgrades need one extra review: `vitest.config.ts` uses Vitest's
experimental custom pool/worker API. Confirm its `vitest/node` exports and
types, the `createPoolWorker` contract, the real `started` handshake, and the
ready-aware worker tests before merging an upgrade. If that API disappears,
temporarily remove the custom pool and set `maxWorkers: 1`; the measured cost
for the root suite is 437.80s → 1131.80s.

Add or update public tests for behavior that downstream users can rely on. Use
private tests only when the fixture genuinely cannot satisfy the public-machine
contract. Documentation-only changes should still be checked for broken links,
stale command names, and invalid examples.

## Verifying a dashboard change

Static checks pass a UI that fails when a person actually opens it. A payload
can be well-formed, every field present, no dead endpoint, every test green,
Reality-Gate satisfied — and the same page still fails outright once a real
browser renders it against real data volume. Element-by-element assertions
don't answer "what does opening this screen actually look like."

Before calling a dashboard change done:

1. **Drive a real, non-headless browser** against the page the way a user
   actually reaches it — not just `localhost` if your users reach it over a
   network, and not a scripted DOM query in place of rendering.
2. **Walk every route** (read the list from `ui/src/App.tsx`, don't work from
   memory), and for each one record: the URL you actually land on (catches a
   silent redirect), any visible error text, console errors and warnings, and
   failed network requests — including the request *count*, which is what
   catches an accidental fan-out.
3. **Actually interact.** Expand a collapsed section, open a log, submit a
   form. A control that only fails once clicked is invisible to a check that
   never clicks it.
4. **Test at realistic data scale.** A handful of fixture rows and a
   production-sized dataset can expose completely different failures.

Then read the rendered page as a person would — not a keyword scan for
"error" or "failed" — and judge each visible element against these seven
questions, which mirror the design-review lens in
`config/agents/doc_reviewer.yaml`:

1. **Purpose traceability** — can you name which question this answers for
   the person looking at it?
2. **Near-duplicate entries** — is the same sentence repeated with only an
   identifier swapped?
3. **Identifier consistency** — does the same entity get one human-readable
   name throughout the view, not several?
4. **Self-explaining language** — would someone who has only read the README,
   `guide/`, or `--help` understand every label, with no unexplained internal
   term?
5. **Scan-length and readability** — does any line run long enough to break
   skimming, and is full detail one click away rather than always inline?
6. **Label-content truthfulness** — does the label accurately describe what
   it leads to?
7. **Uninterrupted primary reading flow** — does an empty state or a minor
   collapsed section interrupt the main decision path?

A metrics-only pass does not substitute for this. Green tests, zero console
errors, and a passing route count can each prove their own narrow property,
but none of them can tell you that a paragraph reads as repetitive, that a
label doesn't match its content, or that the reading flow is broken. The same
seven questions apply to CLI output too — a command's output is part of the
operating surface just as much as a page is.

## Pull requests

Keep a pull request focused and include:

- a concise description of the problem and solution;
- a related issue when one exists;
- the exact build, lint, and test evidence you ran;
- tracked `spec/` coverage for public behavior changes; and
- documentation updates when a command, contract, or operator workflow changes.

The repository PR template asks for the same build/test evidence and test/doc
updates. Do not mark a checkbox complete without corresponding output or a
short explanation of why it is not applicable.

## Commits

Use a short imperative subject and keep unrelated work in separate commits.
Stage only the files that belong to the change. Do not add `Co-Authored-By`
trailers to commit messages.

See the root [CONTRIBUTING.md](../CONTRIBUTING.md) for the concise submission
checklist.
