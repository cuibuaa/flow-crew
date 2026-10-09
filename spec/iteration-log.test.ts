import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendIterationLog } from '../src/scheduler.js';
import { fcGlobalDir, initializeReservedRun, readRunState, reserveRun, setFcGlobalDir } from '../src/store.js';

const originalFcHome = fcGlobalDir();
const roots: string[] = [];

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('iteration log read by the next planner', () => {
  it('lists a stage added after dispatch with its error, and no artifact lists', () => {
    const root = mkdtempSync(join(tmpdir(), 'iteration-log-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const { runId, runDirPath } = reserveRun(projectDir);
    initializeReservedRun(projectDir, runId, 'fixture', 'name: fixture', ['work']);
    const state = readRunState(projectDir, runId);
    state.stages.work = { ...state.stages.work, status: 'complete', artifacts: ['.cache/build-generations/a/1.js', 'src/a.ts'] };
    // A scoped repair is admitted by the gate loop after the iteration's dispatch list was taken.
    state.stages.repair_c1ae91 = { ...state.stages.work, status: 'failed', error: 'live constraint rollback failed', artifacts: [] };

    appendIterationLog(projectDir, runId, 1, state, ['work']);

    const log = readFileSync(join(runDirPath, 'iteration_log.md'), 'utf8');
    expect(log).toContain('## work (complete)');
    expect(log).toContain('## repair_c1ae91 (failed)');
    expect(log).toContain('Error: live constraint rollback failed');
    expect(log).not.toContain('Artifacts:');
    expect(log).not.toContain('.cache/build-generations');
  });
});
