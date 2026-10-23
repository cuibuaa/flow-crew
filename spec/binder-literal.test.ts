import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImmutableEvidenceBindings } from '../src/scheduler/sched_scope/path-capabilities.js';

// Scrubbed counterexamples: no operator reports or ignored fixtures are read.
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'binder-literal-'));
  mkdirSync(join(project, 'evidence'));
  writeFileSync(join(project, 'notes.md'), 'original notes');
  writeFileSync(join(project, 'evidence/source.md'), 'original evidence');
  writeFileSync(join(project, 'frozen.txt'), 'original baseline');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('does not freeze either named path from prose alone', () => {
  const brief = '---\ninputs: [notes.md, evidence]\n---\nPreserve `notes.md` and `evidence/source.md` as frozen evidence.';
  expect(resolveImmutableEvidenceBindings(project, brief).map(binding => binding.path))
    .toEqual([]);
});

it('accepts prose restating a frozen path already bound by frontmatter', () => {
  const brief = '---\ninputs:\n  - path: frozen.txt\n    frozen: true\n---\nThe frontmatter marks `frozen.txt` as frozen immutable evidence.';
  expect(resolveImmutableEvidenceBindings(project, brief).map(binding => binding.path)).toEqual(['frozen.txt']);
});
