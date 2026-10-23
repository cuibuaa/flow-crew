import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { listProjectFilesAt } from '../src/scheduler/sched_scope/path-capabilities.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string, project: string, previous: string, directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-content-')); project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { closeRollbackBaseline(project, directory); setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
function write(path: string, text: string) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), text); }
const metadata = ['.git/FETCH_HEAD', '.git/objects/pack/tmp_pack_fixture', 'nested/.git/HEAD'];

describe('Git metadata has its own owner', () => {
  it.each(metadata)('omits %s from project-content settlement while retaining legitimate edits', path => {
    write('source.txt', 'original'); write('.gitkeep', 'ordinary dotfile');
    const stage = StageConfigSchema.parse({ id: 'writer', role: 'coder', scope: [] });
    const created = createRun(project, 'fixture', '', ['writer']); directory = created.runDirPath;
    const context = createScopeBatchContext(project, [stage], undefined, created.runId);
    write(path, 'Git-owned metadata'); write('source.txt', 'legitimate edit'); write('.gitkeep', 'legitimate dotfile edit');
    const result = settleProjectWrites({ projectDir: project, snapshot: context.snapshot,
      rawWrites: [path, 'source.txt', '.gitkeep'], definiteWrites: new Set([path, 'source.txt', '.gitkeep']) });
    expect(result.violations).toEqual([]); expect(result.rolledBackWrites).toEqual([]);
    expect(result.rawWrites).not.toContain(path); expect(listProjectFilesAt(project, path)).toEqual([]);
    expect(existsSync(join(project, path))).toBe(true);
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('legitimate edit');
    expect(result.durableWrites).toEqual(['source.txt', '.gitkeep']);
  });
});
