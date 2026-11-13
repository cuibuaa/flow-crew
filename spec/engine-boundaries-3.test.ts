import { bindFrozenInputs } from '../src/scheduler/sched_scope/frozen-inputs.js';
import { captureProjectTree, changedTreeFiles, projectCommit } from '../src/evidence-ledger.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { runRecordPath } from '../src/run-layout.js';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildRetryPreamble, parseDispatchedStageConfig } from '../src/scheduler.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { artifacts, inputFile, stageArtifacts } from './spec_contracts/declared-fixtures.js';

import { fcGlobalDir, runDir, setFcGlobalDir, writeRunState, type StoreState } from '../src/store.js';

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'flowcrew-boundaries-3-'));
  roots.push(path);
  return path;
}
function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function git(project: string, args: string[]): void {
  const script = "import { spawnSync } from 'node:child_process'; const result = spawnSync('git', ['-c', 'gc.auto=0', ...JSON.parse(process.argv[1])], { stdio: 'inherit' }); process.exit(result.status ?? 1);";
  execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
    cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
    stdio: 'ignore', timeout: 15_000,
  });
}
function pytestAvailable(project: string): boolean {
  const script = "import { spawnSync } from 'node:child_process'; const result = spawnSync('python3', ['-m', 'pytest', '--version'], { stdio: 'ignore' }); process.exit(result.status ?? 1);";
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
      stdio: 'ignore', timeout: 15_000,
    });
    return true;
  } catch { return false; }
}
function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
    prompt_template: 'fixture', skills: [], criterion_refs: [], is_gate: false,
    depends_on: [], dependency_reasons: {}, ...raw,
  });
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('A — tracked Git identities and frozen preimages', () => {
  it('captures an unfiltered clean tree by object identity and detects changed bytes', async () => {
    const project = root();
    const run = root();
    write(runRecordPath(run, 'run.json'), JSON.stringify({ baseCommit: projectCommit(project), briefAdmission: createBriefAdmission(inspectBrief(''), { kind: 'not_required' }) }));
    mkdirSync(join(project, 'data'), { recursive: true });
    for (let index = 0; index < 8; index++) write(join(project, 'data', `${index}.bin`), randomBytes(128 * 1024));
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const before = captureProjectTree(project);
    expect(before.hash).toMatch(/^[a-f0-9]{64}$/);
    const original = readFileSync(join(project, 'data/0.bin'));
    write(join(project, 'data/0.bin'), randomBytes(original.length));
    expect(changedTreeFiles(before, captureProjectTree(project)).map(file => file.path)).toEqual(['data/0.bin']);
  });

  it('fails dirty and attribute-filtered frozen changes without substituting different Git bytes', () => {
    const project = root();
    const run = root();
    write(runRecordPath(run, 'run.json'), JSON.stringify({ baseCommit: projectCommit(project), briefAdmission: createBriefAdmission(inspectBrief(''), { kind: 'not_required' }) }));
    write(join(project, '.gitattributes'), 'data/filtered.bin filter=copy\n');
    write(join(project, 'data/filtered.bin'), 'filtered-old');
    write(join(project, 'data/dirty.bin'), 'dirty-old');
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    write(join(project, 'data/dirty.bin'), 'dirty-now');
    write(join(project, 'data/filtered.bin'), 'filtered-now');
    write(runRecordPath(run, 'run.json'), JSON.stringify({ baseCommit: projectCommit(project), briefAdmission: createBriefAdmission(inspectBrief('---\ninputs: [{path: data/dirty.bin, frozen: true}, {path: data/filtered.bin, frozen: true}]\n---\n'), { kind: 'not_required' }) }));
    write(runRecordPath(run, 'task_brief.md'), '---\ninputs: [{path: data/dirty.bin, frozen: true}, {path: data/filtered.bin, frozen: true}]\n---\n');
    const context = { frozen: bindFrozenInputs(project, run) };
    try {
      const dirty = context.frozen.members['data/dirty.bin'] as { sha256: string };
      const filtered = context.frozen.members['data/filtered.bin'] as { sha256: string };
      expect(dirty.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(filtered.sha256).toMatch(/^[a-f0-9]{64}$/);
      write(join(project, 'data/dirty.bin'), 'dirty-bad');
      write(join(project, 'data/filtered.bin'), 'filtered-bad');
      const paths = ['data/dirty.bin', 'data/filtered.bin'];
      expect(settleProjectWrites({ projectDir: project, context, rawWrites: paths, appliedWrites: paths }))
        .toMatchObject({ rolledBackWrites: [], rollbackFailures: paths, violations: paths.map(path => ({
          path, certainty: 'definite', reason: 'task-frozen evidence content changed or cannot be verified',
        })) });
      expect(readFileSync(join(project, 'data/dirty.bin'), 'utf8')).toBe('dirty-bad');
      expect(readFileSync(join(project, 'data/filtered.bin'), 'utf8')).toBe('filtered-bad');
    } finally {  }
  });

  it('detects frozen local bytes hidden by assume-unchanged and reports them unrestored', () => {
    const project = root();
    const run = root();
    write(runRecordPath(run, 'run.json'), JSON.stringify({ baseCommit: projectCommit(project), briefAdmission: createBriefAdmission(inspectBrief(''), { kind: 'not_required' }) }));
    write(join(project, 'data/local.txt'), 'committed\n');
    git(project, ['init', '-q']);
    git(project, ['add', '.']);
    git(project, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    git(project, ['update-index', '--assume-unchanged', 'data/local.txt']);
    write(join(project, 'data/local.txt'), 'operator-local\n');
    write(runRecordPath(run, 'run.json'), JSON.stringify({ baseCommit: projectCommit(project), briefAdmission: createBriefAdmission(inspectBrief('---\ninputs: [{path: data/local.txt, frozen: true}]\n---\n'), { kind: 'not_required' }) }));
    write(runRecordPath(run, 'task_brief.md'), '---\ninputs: [{path: data/local.txt, frozen: true}]\n---\n');
    const context = { frozen: bindFrozenInputs(project, run) };
    try {
      expect(context.frozen.members['data/local.txt']).toMatchObject({ state: 'present' });
      write(join(project, 'data/local.txt'), 'stage-change\n');
      expect(settleProjectWrites({ projectDir: project, context, rawWrites: ['data/local.txt'], appliedWrites: ['data/local.txt'] }))
        .toMatchObject({ rolledBackWrites: [], rollbackFailures: ['data/local.txt'],
          violations: [{ path: 'data/local.txt', certainty: 'definite', reason: 'task-frozen evidence content changed or cannot be verified' }] });
      expect(readFileSync(join(project, 'data/local.txt'), 'utf8')).toBe('stage-change\n');
    } finally {  }
  });
});

describe('C — retry context', () => {
  it('still describes a real budget timeout as a timeout and retains its larger retry budget', () => {
    const run = root();
    write(runRecordPath(run, 'run.json'), JSON.stringify({ briefAdmission: createBriefAdmission(inspectBrief(''), { kind: 'not_required' }) }));
    write(runRecordPath(run, 'stages', 'work', 'status.json'), JSON.stringify({ error: 'attempt timeout exceeded' }));
    const preamble = buildRetryPreamble(1, 1000, run, 'work', { previousBudgetMs: 1000, nextBudgetMs: 2000 });
    expect(preamble).toContain('\"previousError\":\"attempt timeout exceeded\"');
    expect(preamble).toContain('\"previousBudgetMs\":1000');
    expect(preamble).toContain('\"nextBudgetMs\":2000');
  });
});
