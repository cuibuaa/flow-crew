import { afterEach, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { RollbackContentStore, hashRollbackFileSync } from '../src/rollback-content-store.js';
import { createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { clearAttemptSummaryRefreshDebounce } from '../src/run-events.js';
import { inspectBriefOutputs, nodeShipInputFileSystem, verifyDeclaredBriefInputs } from '../src/ship-inputs.js';
import { archiveDeclaredOutputs, isPathSafelyArchived } from '../src/declared-output-archive.js';

let root: string | undefined;
const previous = fcGlobalDir();
afterEach(() => {
  clearAttemptSummaryRefreshDebounce();
  setFcGlobalDir(previous);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('runs with a sparse multi-GiB project artifact and protects its rollback preimage', { timeout: 120_000 }, async () => {
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
  const contentStore = new RollbackContentStore(run);
  const captured = contentStore.capture(absolute, path);
  const input = { projectDir: project, runDir: run, stageId: 'plan' };
  let invocations = 0;
  await withEngineIntegrity(input, async () => { invocations++; });
  expect(invocations).toBe(1);

  // A same-size edit beyond 2 GiB must still void the result and restore bytes.
  await expect(withEngineIntegrity(input, async () => {
    invocations++;
    const fd = openSync(captured.backingPath, 'r+');
    try { writeSync(fd, Buffer.from([1]), 0, 1, size - 1); } finally { closeSync(fd); }
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(invocations).toBe(2);
  expect(hashRollbackFileSync(captured.backingPath).sha256).toBe(captured.sha256);
  const fd = openSync(captured.backingPath, 'r');
  try {
    const last = Buffer.alloc(1);
    expect(readSync(fd, last, 0, 1, size - 1)).toBe(1);
    expect(last[0]).toBe(0);
  } finally { closeSync(fd); }

  const brief = `---\ninputs:\n  - path: ${path}\n    sha256: ${captured.sha256}\noutputs:\n  - path: ${path}\n    on_existing: update\n---\n`;
  expect(inspectBriefOutputs(brief, project).entries[0].sha256).toBe(captured.sha256);
  const verified = verifyDeclaredBriefInputs(brief, project);
  expect(verified.inputs[0].assertions).toMatchObject([{ kind: 'sha256', state: 'confirmed', observed: captured.sha256 }]);
  const declaration = { path, expectedType: 'file' as const, disposition: 'update' as const, source: 'outputs' as const, line: 2 };
  const manifest = archiveDeclaredOutputs(project, run, [declaration]);
  expect(manifest.outputs[0]).toMatchObject({ members: [{ bytes: size, sha256: captured.sha256 }] });
  expect(isPathSafelyArchived(project, run, path, nodeShipInputFileSystem)).toBe(true);
});
