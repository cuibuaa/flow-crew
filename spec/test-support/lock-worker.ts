import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, rmSync, linkSync, fsyncSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskRegistry } from '../../src/task-registry.js';
import { createTaskEntry } from '../../src/fc-tasks.js';
import { setFcGlobalDir, updateRunState, withRunStateLock, runDir } from '../../src/store.js';
import { runRecordPath } from '../../src/run-layout.js';
import { readLockWaits } from '../../src/lock-publication.js';

const [kind, mode, root, path, runId, project, label, controlled] = process.argv.slice(2);
setFcGlobalDir(join(root, 'fc'));
const nativeWait = Atomics.wait;
const cell = new Int32Array(new SharedArrayBuffer(4));
const until = (file: string) => { while (!existsSync(file)) nativeWait(cell, 0, 0, 10); };
const hold = () => { process.send!({ type: 'held', pid: process.pid }); until(join(root, 'release-holder')); };
if (mode === 'wait') {
  Date.now = () => Number(readFileSync(join(root, 'clock'), 'utf8'));
  process.hrtime.bigint = () => BigInt(Date.now()) * 1_000_000n;
  let step = 0;
  Atomics.wait = () => {
    process.send!({ type: 'waiting', step, waits: readLockWaits(path), clock: Date.now() });
    const gate = join(root, `step-${label}-${step++}`);
    until(gate);
    rmSync(gate);
    return 'ok';
  };
}
if (mode === 'wait' && controlled === 'recovery') {
  const unlink = fs.unlinkSync;
  let stopped = false;
  fs.unlinkSync = file => {
    if (!stopped && String(file) === path) {
      stopped = true;
      process.send!({ type: 'recovering' });
      until(join(root, `release-${label}`));
    }
    return unlink(file);
  };
  syncBuiltinESMExports();
}
try {
  if (mode === 'legacy-hold') {
    if (kind === 'ledger') mkdirSync(path); else writeFileSync(path, '');
    hold();
    rmSync(path, { recursive: true });
    process.send!({ type: 'done' });
    process.disconnect!();
    process.exit(0);
  }
  const mutation = () => {
    if (mode === 'wait' && controlled === 'controlled') { process.send!({ type: 'entered' }); until(join(root, `release-${label}`)); }
  };
  const registry = new TaskRegistry({ baseDir: join(root, 'fc'), syncFile: fd => { mutation(); fsyncSync(fd); } });
  const entry = { id: mode === 'hold' ? mode : `wait-${label}`, subject: mode, description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
  if (kind === 'run-state') {
    const canonical = runRecordPath(runDir(project, runId), '.run-state.lock');
    const directory = path === canonical ? runDir(project, runId) : dirname(path);
    if (mode === 'hold') withRunStateLock(directory, hold);
    else if (path === canonical) updateRunState(project, runId, state => { mutation(); state.taskDescription = 'mutation completed'; });
    else withRunStateLock(directory, () => writeFileSync(join(root, 'global-mutation'), 'completed'));
  } else if (kind === 'registry') {
    if (mode === 'hold') registry.withSessionWrite(hold);
    else registry.create({ projectDir: project, name: 'mutation completed' });
  } else {
    createTaskEntry({ storeRoot: join(root, 'ledger'), session: 'session', entry,
      publication: { create: (from: string, to: string) => { if (mode === 'hold') hold(); else mutation(); linkSync(from, to); } } });
  }
  process.send!({ type: 'done' });
} catch (error) {
  process.send!({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally { process.disconnect!(); }
