import { afterEach, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { hashRollbackFileSync } from '../src/rollback-content-store.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

import { inspectBriefOutputs, nodeShipInputFileSystem } from '../src/ship-inputs.js';
import { createArchivedPathVerifier, archiveDeclaredOutputs } from '../src/declared-output-archive.js';

let root: string | undefined;
const previous = fcGlobalDir();
afterEach(() => {
  setFcGlobalDir(previous);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('hashes and archives sparse multi-GiB declared outputs with bounded memory', { timeout: 240_000 }, async () => {
  root = mkdtempSync(join(tmpdir(), 'large-file-state-'));
  const project = join(root, 'project');
  mkdirSync(join(project, 'hf_cache'), { recursive: true });
  writeFileSync(join(project, '.gitignore'), 'hf_cache/\n');
  const path = 'hf_cache/weights.bin', absolute = join(project, path), size = 2 ** 31 + 17;
  const descriptor = openSync(absolute, 'wx');
  try { ftruncateSync(descriptor, size); } finally { closeSync(descriptor); }
  // Logical size exceeds readFile's limit; no model bytes are allocated.
  expect(statSync(absolute).size).toBe(size);
  expect(statSync(absolute).blocks * 512).toBeLessThan(1024 * 1024);
  setFcGlobalDir(join(root, 'store'));
  const run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['plan']).runDirPath;
  const captured = hashRollbackFileSync(absolute);
  const brief = `---\noutputs:\n  - path: ${path}\n    on_existing: update\n---\n`;
  expect(inspectBriefOutputs(brief, project).entries[0].sha256).toBe(captured.sha256);
  const declaration = { path, expectedType: 'file' as const, disposition: 'update' as const, source: 'outputs' as const, line: 2 };
  const manifest = archiveDeclaredOutputs(project, run, [declaration]);
  expect(manifest.outputs[0]).toMatchObject({ members: [{ bytes: size, sha256: captured.sha256 }] });
  expect(createArchivedPathVerifier(project, run, nodeShipInputFileSystem)(path)).toBe(true);
});
