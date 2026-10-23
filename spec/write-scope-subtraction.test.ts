import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execWithStdin, type Adapter, type RunOpts } from '../src/adapters/base.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { writeRepairRoundDiffArtifact } from '../src/scheduler.js';
import { runScopeSafeStageGroup } from '../src/scheduler/sched_loop/services.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { baselineImage, closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { captureRepairRoundSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { compareRepairFileContents } from '../src/scheduler/sched_scope/file-images.js';
import { restoreProjectPath } from '../src/scheduler/sched_scope/restore.js';
import { resolveImmutableEvidenceBindings } from '../src/scheduler/sched_scope/path-capabilities.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

let root: string, project: string, directory: string, runId: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'write-contract-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  closeRollbackBaseline(project, directory);
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
const stage = (id = 'author', scope: string[] = ['src/estimated.ts']) => StageConfigSchema.parse({ id, role: 'coder', scope });
const role = { name: 'coder', description: 'Synthetic author', prompt: 'Complete the task.', tools: [], model: 'test', reasoning_effort: 'low' };
const mixedInstructions = [
  'Keep `evidence.txt` frozen, but modify `source.ts`.',
  'Preserve `evidence.txt` bytes and derive `source.ts` anew.',
  'Update `source.ts` using the immutable reference snapshot `evidence.txt`.',
  '生成 `source.ts`，并保留 `evidence.txt`。',
];
function write(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), bytes);
}
function git(...args: string[]) { return isolatedProjectCommand('git', args, project, root); }
function commit() {
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic baseline');
}
function create(brief = 'Complete the required project work.', stages = [stage()]) {
  ({ runId, runDirPath: directory } = createRun(project, 'write-contract', 'name: fixture\nstages: []\n', stages.map(s => s.id)));
  writeFileSync(join(directory, 'task_brief.md'), brief);
  return stages;
}
async function execute(work: (opts: RunOpts) => Promise<string[]> | string[], stages = [stage()]) {
  let calls = 0, aborts = 0;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls++;
    opts.abortSignal?.addEventListener('abort', () => { aborts++; }, { once: true });
    const writes = await work(opts);
    return { output: 'Required work completed.', exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' };
  } };
  await runScopeSafeStageGroup(stages, project, runId, 1, (s, settlementBoundary) => runStage(adapter, {
    stageId: s.id, role, dependsOn: [], promptTemplate: 'Complete the required project work.',
    projectDir: project, runId, runDir: directory, retries: 0, timeout_ms: 8_000,
     artifactContract: fixtureArtifactContract(s.id), settlementBoundary,
  }));
  return { calls, aborts, status: readStageStatus(project, runId, stages[0].id),
    audits: stages.map(s => JSON.parse(readFileSync(join(directory, `stages/${s.id}/constraint_audit_attempt_1.json`), 'utf8'))) };
}
function accepted(result: Awaited<ReturnType<typeof execute>>, expectedCalls = 1) {
  expect(result.status.status, result.status.error).toBe('complete');
  expect(result.status.attempts).toHaveLength(1);
  expect([result.calls, result.aborts]).toEqual([expectedCalls, 0]);
  for (const audit of result.audits) {
    expect(audit.violations).toEqual([]); expect(audit.rolledBackWrites).toEqual([]); expect(audit.rollbackFailures).toEqual([]);
  }
  const events = readRunEvents(project, runId);
  expect(events.filter(e => ['attempt_suspended', 'scope_revision_requested', 'scope_revision_decided', 'live_constraint_violation'].includes(e.type))).toEqual([]);
}

describe('legitimate work outside planner estimates', () => {
  // Scrubbed versions of the two recorded make-test shapes: ephemeral root
  // members must remain usable until the real command removes them itself.
  it.each(['pair', 'state-tree'])('completes make test with root temporary directories (%s)', async shape => {
    const members = shape === 'pair' ? ['token.bin', 'token.pub']
      : ['state/events.log', 'state/locks/registry', 'state/locks/request', 'state/decision/job.log', 'state/decision/summary.json'];
    write('Makefile', `test:\n\t${JSON.stringify(process.execPath)} suite.mjs\n`);
    write('suite.mjs', `import * as fs from 'node:fs'; import * as path from 'node:path';\nconst dir = fs.mkdtempSync(path.join(process.cwd(), 'offline-test-'));\nconst members = ${JSON.stringify(members)};\ntry {\n for (const name of members) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'synthetic fixture'); }\n await new Promise(resolve => setTimeout(resolve, 180));\n for (const name of members) if (fs.readFileSync(path.join(dir, name), 'utf8') !== 'synthetic fixture') throw new Error('temporary dependency changed');\n console.log('temporary dependencies intact');\n} finally { fs.rmSync(dir, {recursive:true, force:true}); }\n`);
    commit(); create();
    const result = await execute(async opts => {
      const command = await execWithStdin('make', ['test'], '', { cwd: project, timeout_ms: 3_000,
        abortSignal: opts.abortSignal, execution: opts });
      expect(command.exitCode, command.output).toBe(0);
      expect(command.output).toContain('temporary dependencies intact');
      write('scripts/required.mjs', 'export const completed = true;\n');
      write('reports/test-result.txt', 'make test passed\n');
      return ['scripts/required.mjs', 'reports/test-result.txt'];
    });
    accepted(result);
    expect(readdirSync(project).filter(name => name.startsWith('offline-test-'))).toEqual([]);
    expect(result.audits[0].durableWrites).toEqual(expect.arrayContaining(['scripts/required.mjs', 'reports/test-result.txt']));
    expect(readFileSync(join(project, 'reports/test-result.txt'), 'utf8')).toBe('make test passed\n');
  });

  it('accepts a required new output under an input directory with exact output precedence', async () => {
    write('inputs/original.txt', 'original evidence'); commit();
    create('---\ninputs: [{path: inputs, frozen: true}]\noutputs: [inputs/report.md]\n---\nKeep `inputs` frozen. Produce the required report.');
    const result = await execute(() => { write('inputs/report.md', 'Required report'); return ['inputs/report.md']; });
    accepted(result); expect(readFileSync(join(project, 'inputs/original.txt'), 'utf8')).toBe('original evidence');
    expect(readFileSync(join(project, 'inputs/report.md'), 'utf8')).toBe('Required report');
  });

  it.each(mixedInstructions)('accepts the declared output under explanatory prose (%s)', async instruction => {
    write('evidence.txt', 'FROZEN'); write('source.ts', 'old'); commit();
    // Frontmatter freezes evidence independently of the explanatory prose.
    create(`---\ninputs: [{path: evidence.txt, frozen: true}, source.ts]\noutputs: [source.ts]\n---\n${instruction}`);
    const result = await execute(() => { write('source.ts', 'requested change'); return ['source.ts']; });
    accepted(result);
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('requested change');
    expect(readFileSync(join(project, 'evidence.txt'), 'utf8')).toBe('FROZEN');
  });

  it.each(['leaf', 'tree'])('accepts an exact replacement output alias with frozen input %s', async kind => {
    const report = kind === 'leaf' ? 'report.md' : 'inputs/report.md';
    const target = kind === 'leaf' ? 'source.ts' : 'inputs/prior.md';
    write(target, 'prior report'); write('inputs/evidence.txt', 'FROZEN');
    symlinkSync(kind === 'leaf' ? 'source.ts' : 'prior.md', join(project, report)); commit();
    const input = kind === 'leaf' ? report : 'inputs';
    create(`---\ninputs: [{path: ${input}, frozen: true}]\noutputs:\n  - path: ${report}\n    on_existing: replace\n---\nKeep \`${input}\` frozen. Produce the declared replacement report.`);
    const result = await execute(() => {
      rmSync(join(project, report)); write(report, 'required report'); return [report];
    });
    accepted(result);
    expect(readFileSync(join(project, report), 'utf8')).toBe('required report');
    expect(readFileSync(join(project, target), 'utf8')).toBe('prior report');
    expect(readFileSync(join(project, 'inputs/evidence.txt'), 'utf8')).toBe('FROZEN');
  });

  it('accepts a requested report after a frozen input list', async () => {
    write('evidence.txt', 'FROZEN'); commit();
    create('---\ninputs: [{path: evidence.txt, frozen: true}]\n---\n# Frozen inputs\n- `evidence.txt`\n\nCreate `report.md` summarizing the evidence.');
    accepted(await execute(() => { write('report.md', 'required report'); return ['report.md']; }));
    expect(readFileSync(join(project, 'report.md'), 'utf8')).toBe('required report');
    expect(readFileSync(join(project, 'evidence.txt'), 'utf8')).toBe('FROZEN');
  });

  it('accepts a new sibling beneath an absent parent of explicitly frozen evidence', async () => {
    commitWithSource();
    create('---\ninputs: [{path: new/evidence.bin, frozen: true}]\n---\nKeep `new/evidence.bin` frozen. Create `new/report.md`.');
    accepted(await execute(() => { write('new/report.md', 'required report'); return ['new/report.md']; }));
    expect(readFileSync(join(project, 'new/report.md'), 'utf8')).toBe('required report');
    expect(existsSync(join(project, 'new/evidence.bin'))).toBe(false);
  });

  it('accepts an additive test file in a locator-only input tree', async () => {
    write('tests/existing.test.ts', 'existing test'); commit(); create('---\ninputs: [tests]\n---\nAdd the required runtime test.');
    const result = await execute(() => { write('tests/runtime.test.ts', 'new required test'); return ['tests/runtime.test.ts']; });
    accepted(result); expect(readFileSync(join(project, 'tests/runtime.test.ts'), 'utf8')).toBe('new required test');
  });

  it('accepts legitimate duplicate-file consolidation in an input tree', async () => {
    write('tools/readers/main.mjs', 'same bytes'); write('tools/duplicate/main.mjs', 'same bytes');
    write('tools/manifest.json', '{"reader":"duplicate/main.mjs"}'); commit();
    create('---\ninputs: [tools]\n---\nConsolidate byte-identical readers and repoint the manifest.');
    const result = await execute(() => {
      rmSync(join(project, 'tools/duplicate'), { recursive: true });
      write('tools/manifest.json', '{"reader":"readers/main.mjs"}');
      return ['tools/duplicate/main.mjs', 'tools/manifest.json'];
    });
    accepted(result); expect(existsSync(join(project, 'tools/duplicate/main.mjs'))).toBe(false);
    expect(readFileSync(join(project, 'tools/readers/main.mjs'), 'utf8')).toBe('same bytes');
  });

  it('accepts required scripts, docs, reports and arbitrary caches without a name catalog', async () => {
    commitWithSource(); create();
    const paths = ['scripts/new.mjs', 'docs/report.md', 'reports/check.txt', 'downloads/data/meta.json', '.unusual-cache/value.bin'];
    accepted(await execute(() => { for (const path of paths) write(path, 'required bytes'); return paths; }));
    for (const path of paths) expect(readFileSync(join(project, path), 'utf8')).toBe('required bytes');
  });

  it('keeps ignored predecessor fixtures when git add -f changes only the index', async () => {
    write('.gitignore', 'samples/\n'); write('source.txt', 'source'); commit(); write('samples/baseline.json', 'predecessor fixture');
    create('---\ninputs: [samples]\n---\nRetain and stage predecessor fixtures.');
    const result = await execute(() => { git('add', '-f', 'samples/baseline.json'); return ['samples/baseline.json']; });
    accepted(result); expect(result.audits[0].durableWrites).not.toContain('samples/baseline.json');
    expect(readFileSync(join(project, 'samples/baseline.json'), 'utf8')).toBe('predecessor fixture');
  });

  it('does not promote timestamp or index changes to frozen content violations', async () => {
    write('evidence.txt', 'original bytes'); commit(); create('---\ninputs: [{path: evidence.txt, frozen: true}]\n---\nKeep `evidence.txt` immutable.');
    const result = await execute(() => {
      const later = new Date(Date.now() + 60_000); utimesSync(join(project, 'evidence.txt'), later, later);
      git('add', 'evidence.txt'); return ['evidence.txt'];
    });
    accepted(result); expect(result.audits[0].durableWrites).toEqual([]);
  });

  it('does not blame an innocent reader for a predecessor change against a stale baseline', async () => {
    write('part/one.txt', 'old'); commit(); create();
    createScopeBatchContext(project, [stage()], undefined, runId);
    write('part/one.txt', 'predecessor completed');
    const result = await execute(() => { expect(readFileSync(join(project, 'part/one.txt'), 'utf8')).toBe('predecessor completed'); return []; });
    accepted(result); expect(result.audits[0].durableWrites).not.toContain('part/one.txt');
    expect(readFileSync(join(project, 'part/one.txt'), 'utf8')).toBe('predecessor completed');
  });
});
function commitWithSource() { write('source.txt', 'baseline'); commit(); }

describe('the surviving project guarantees', () => {
  it.each(mixedInstructions)('retains structured frozen evidence under explanatory prose (%s)', async instruction => {
    const bytes = Buffer.from([0, 255, 10, 128]);
    write('evidence.txt', bytes); write('source.ts', 'old'); commit();
    // Frontmatter freezes evidence independently of the explanatory prose.
    create(`---\ninputs: [{path: evidence.txt, frozen: true}, source.ts]\noutputs: [source.ts]\n---\n${instruction}`);
    const result = await execute(() => {
      write('evidence.txt', 'CORRUPT'); write('source.ts', 'requested change');
      return ['evidence.txt', 'source.ts'];
    });
    expect(result.status.status).toBe('failed'); expect(result.aborts).toBe(0);
    expect(result.audits[0].rollbackFailures).toEqual([]);
    expect(result.audits[0].rolledBackWrites).toEqual(['evidence.txt']);
    expect(readFileSync(join(project, 'evidence.txt'))).toEqual(bytes);
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('requested change');
  });

  it.each([
    'Preserve `evidence.txt` together with `source.ts` as frozen evidence.',
    'Preserve `evidence.txt` together with `source.ts` bytes.',
  ])('restores every structured frozen file under compound prose (%s)', async instruction => {
    write('evidence.txt', 'FROZEN'); write('source.ts', 'ALSO FROZEN'); write('other.md', 'free'); commit();
    create(`---\ninputs: [{path: evidence.txt, frozen: true}, {path: source.ts, frozen: true}]\n---\n${instruction}`);
    const result = await execute(() => { write('source.ts', 'CORRUPT'); write('other.md', 'edited'); return ['source.ts', 'other.md']; });
    expect(result.status.status).toBe('failed'); expect(result.audits[0].rollbackFailures).toEqual([]);
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('ALSO FROZEN');
    expect(readFileSync(join(project, 'other.md'), 'utf8')).toBe('edited');
  });

  it('still binds a single named file and leaves an unrelated path writable', async () => {
    write('evidence.txt', 'FROZEN'); write('source.ts', 'old'); commit();
    create('---\ninputs: [{path: evidence.txt, frozen: true}, source.ts]\n---\nPreserve `evidence.txt` as frozen evidence.');
    const result = await execute(() => { write('source.ts', 'requested change'); write('evidence.txt', 'CORRUPT'); return ['source.ts', 'evidence.txt']; });
    expect(result.status.status).toBe('failed');
    expect(result.audits[0].rolledBackWrites).toEqual(['evidence.txt']);
    expect(readFileSync(join(project, 'evidence.txt'), 'utf8')).toBe('FROZEN');
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('requested change');
  });

  it('restores the named root file beside an evidence directory in a preservation request', async () => {
    write('notes.md', 'ORIGINAL NOTES'); write('evidence/source.md', 'ORIGINAL SOURCE'); commit();
    create('---\ninputs: [{path: notes.md, frozen: true}, {path: evidence, frozen: true}]\n---\nPreserve `notes.md` and `evidence/source.md` as frozen evidence.');
    const result = await execute(() => { write('notes.md', 'CORRUPT'); return ['notes.md']; });
    expect(result.status.status).toBe('failed');
    expect(result.audits[0].rolledBackWrites).toEqual(['notes.md']);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('ORIGINAL NOTES');
  });

  it('runs an author when prose restates a structurally frozen input', async () => {
    write('frozen.txt', 'ORIGINAL'); commit();
    create('---\ninputs:\n  - path: frozen.txt\n    frozen: true\n---\nThe frontmatter marks `frozen.txt` as frozen immutable evidence.');
    accepted(await execute(() => { write('report.md', 'delivered'); return ['report.md']; }));
    expect(readFileSync(join(project, 'frozen.txt'), 'utf8')).toBe('ORIGINAL');
  });

  it('restores a frozen file replaced by a directory and retains the displaced contents', async () => {
    const bytes = Buffer.from([0, 255, 10, 128]); write('evidence.bin', bytes); commit();
    create('---\ninputs: [{path: evidence.bin, frozen: true}]\n---\nKeep `evidence.bin` frozen.');
    writeFileSync(join(root, 'outside.txt'), 'untouched');
    const result = await execute(() => {
      rmSync(join(project, 'evidence.bin')); write('evidence.bin/nested/child', 'replacement child');
      symlinkSync(join(root, 'outside.txt'), join(project, 'evidence.bin/link'));
      return ['evidence.bin', 'evidence.bin/nested/child'];
    });
    expect(result.status.status).toBe('failed'); expect(result.audits[0].rollbackFailures).toEqual([]);
    expect(readFileSync(join(project, 'evidence.bin'))).toEqual(bytes);
    const retained = result.audits[0].retainedReplacements['evidence.bin'];
    expect(retained).toContain(join(directory, 'rollback-retained'));
    expect(existsSync(join(retained, 'nested/child'))).toBe(true);
    expect(readFileSync(join(retained, 'nested/child'), 'utf8')).toBe('replacement child');
    expect(readlinkSync(join(retained, 'link'))).toBe(join(root, 'outside.txt'));
    closeRollbackBaseline(project, directory);
    expect(readFileSync(join(retained, 'nested/child'), 'utf8')).toBe('replacement child');
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('untouched');
  });

  it.each(['input', 'chain', 'directory'])('restores a frozen file ancestor without touching its replacement target (%s)', async shape => {
    write('original/value.bin', 'FROZEN'); write('other/value.bin', 'OTHER');
    if (shape === 'directory') write('input/value.bin', 'FROZEN');
    else {
      if (shape === 'chain') symlinkSync('original', join(project, 'middle'), 'dir');
      symlinkSync(shape === 'chain' ? 'middle' : 'original', join(project, 'input'), 'dir');
    }
    commit(); create('---\ninputs: [{path: input/value.bin, frozen: true}]\n---\nKeep `input/value.bin` frozen.');
    const changed = shape === 'chain' ? 'middle' : 'input';
    const result = await execute(() => {
      rmSync(join(project, changed), { recursive: true });
      symlinkSync('other', join(project, changed), 'dir');
      return [changed];
    });
    expect(result.status.status).toBe('failed'); expect(result.audits[0].rollbackFailures).toEqual([]);
    expect(result.audits[0].rolledBackWrites).toContain(changed);
    if (shape !== 'directory') expect(readlinkSync(join(project, changed))).toBe('original');
    expect(readFileSync(join(project, 'input/value.bin'), 'utf8')).toBe('FROZEN');
    expect(readFileSync(join(project, 'original/value.bin'), 'utf8')).toBe('FROZEN');
    expect(readFileSync(join(project, 'other/value.bin'), 'utf8')).toBe('OTHER');
  });

  it('refuses leaf restoration until its admitted parent identity is restored', () => {
    write('original/value.bin', 'FROZEN'); write('other/value.bin', 'OTHER');
    symlinkSync('original', join(project, 'input'), 'dir'); commit();
    create('---\ninputs: [{path: input/value.bin, frozen: true}]\n---\nKeep `input/value.bin` frozen.');
    const context = createScopeBatchContext(project, [stage()], undefined, runId);
    const before = context.snapshot.rollbackBaseline.frozenImages.get('input/value.bin')!;
    expect(before.restorationParent).toBe(join(project, 'original'));
    rmSync(join(project, 'input')); symlinkSync('other', join(project, 'input'), 'dir');
    expect(restoreProjectPath(project, 'input/value.bin', before).restored).toBe(false);
    expect(readFileSync(join(project, 'other/value.bin'), 'utf8')).toBe('OTHER');
    const result = settleProjectWrites({ projectDir: project, snapshot: context.snapshot,
      rawWrites: ['input'], definiteWrites: new Set(['input']) });
    expect(result.violations.length).toBeGreaterThan(0); expect(result.rollbackFailures).toEqual([]);
    expect(readlinkSync(join(project, 'input'))).toBe('original');
    expect(readFileSync(join(project, 'other/value.bin'), 'utf8')).toBe('OTHER');
  });

  it.each(['direct', 'alias'])('rejects task-frozen corruption at settlement and restores exact bytes (%s)', async spelling => {
    const bytes = Buffer.from([0, 255, 10, 13, 42, 128]);
    write('evidence/input.bin', bytes); symlinkSync('evidence', join(project, 'alias'), 'dir'); commit();
    create('---\ninputs: [{path: alias, frozen: true}]\n---\nKeep `alias` frozen.');
    const path = spelling === 'direct' ? 'evidence/input.bin' : 'alias/input.bin';
    const result = await execute(() => {
      write(path, 'corrupted');
      // Evidence remains changed until the child has closed: there is no live restorer.
      expect(readFileSync(join(project, path), 'utf8')).toBe('corrupted');
      return [path];
    });
    expect(result.status.status).toBe('failed'); expect(result.status.error).toContain('immutable_evidence_violation');
    expect(result.calls).toBe(1); expect(result.aborts).toBe(0);
    expect(result.audits[0].rolledBackWrites).toContain('evidence/input.bin');
    expect(readFileSync(join(project, 'evidence/input.bin'))).toEqual(bytes);
    expect(readFileSync(join(project, 'alias/input.bin'))).toEqual(bytes);
  });

  it('protects ignored and tracked frozen bytes regardless of their names', async () => {
    write('.gitignore', 'artifacts/\n'); write('artifacts/tracked.txt', 'tracked'); write('artifacts/ignored.txt', 'ignored');
    git('init', '-q'); git('add', '.'); git('add', '-f', 'artifacts/tracked.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
    create('---\ninputs: [{path: artifacts, frozen: true}]\n---\nKeep `artifacts` immutable.');
    const result = await execute(() => { write('artifacts/tracked.txt', 'bad'); write('artifacts/ignored.txt', 'bad'); return ['artifacts/tracked.txt', 'artifacts/ignored.txt']; });
    expect(result.status.status).toBe('failed');
    expect(readFileSync(join(project, 'artifacts/tracked.txt'), 'utf8')).toBe('tracked');
    expect(readFileSync(join(project, 'artifacts/ignored.txt'), 'utf8')).toBe('ignored');
  });

  it('waits for a shared-tree owner to release, then admits the next author successfully', async () => {
    write('shared.txt', 'initial'); commit();
    const stages = [stage('first', ['first/**']), stage('second', ['second/**'])]; create(undefined, stages);
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { started = resolve; });
    const order: string[] = [];
    const running = execute(async opts => {
      order.push(opts.stageId);
      if (opts.stageId === 'first') { write('shared.txt', 'first-active'); started(); await held; }
      else { expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('first-active'); write('shared.txt', 'second-complete'); }
      return ['shared.txt'];
    }, stages);
    try {
      await active; await new Promise(resolve => setTimeout(resolve, 30));
      expect(order).toEqual(['first']); expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('first-active');
    } finally { release(); }
    accepted(await running, 2); expect(order).toEqual(['first', 'second']);
    expect(readStageStatus(project, runId, 'second').status).toBe('complete');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('second-complete');
  });

  it('keeps unknown preimages explicit and never removes their present bytes', () => {
    write('.gitignore', 'opaque/\n'); write('source.txt', 'baseline');
    write('evidence/original.txt', 'original'); symlinkSync('evidence', join(project, 'alias'), 'dir');
    commit(); write('opaque/retained.bin', 'must survive'); create();
    const context = createScopeBatchContext(project, [stage()], undefined, runId);
    const unknown = baselineImage(context.snapshot.rollbackBaseline, 'opaque/retained.bin');
    const aliasUnknown = baselineImage(context.snapshot.rollbackBaseline, 'alias/original.txt');
    expect(aliasUnknown).toMatchObject({ exists: false, provenance: 'unknown' });
    expect(restoreProjectPath(project, 'alias/original.txt', aliasUnknown)).toMatchObject({ restored: false });
    expect(readFileSync(join(project, 'evidence/original.txt'), 'utf8')).toBe('original');
    expect(unknown).toMatchObject({ exists: false, provenance: 'unknown' });
    expect(compareRepairFileContents(unknown, { exists: false, provenance: 'observed' })).toBe('unavailable');
    expect(restoreProjectPath(project, 'opaque/retained.bin', unknown)).toMatchObject({ restored: false });
    expect(readFileSync(join(project, 'opaque/retained.bin'), 'utf8')).toBe('must survive');
    const result = settleProjectWrites({ projectDir: project, snapshot: context.snapshot,
      rawWrites: ['opaque/retained.bin'], definiteWrites: new Set(['opaque/retained.bin']) });
    expect(result.violations).toEqual([]); expect(result.rolledBackWrites).toEqual([]);
    const diffPath = writeRepairRoundDiffArtifact({ snapshot: context.snapshot, projectDir: project, runDirPath: directory,
      iteration: 1, round: 1, repairStages: [stage()], statuses: { author: { status: 'complete', retries: 0,
        writes: ['opaque/retained.bin'], writeAttribution: 'structured' } } });
    const diff = JSON.parse(readFileSync(diffPath, 'utf8'));
    expect(diff.files.find((file: { path: string }) => file.path === 'opaque/retained.bin')).toMatchObject({
      status: 'content-unavailable', before: { exists: false, provenance: 'unknown' } });
  });

  it('restores an output alias retargeted onto frozen evidence without losing either preimage', async () => {
    write('inputs/prior.md', 'previous output'); write('inputs/evidence.md', 'exact evidence');
    symlinkSync('prior.md', join(project, 'inputs/report.md')); commit();
    create('---\ninputs: [{path: inputs, frozen: true}]\noutputs:\n  - path: inputs/report.md\n    on_existing: replace\n---\nKeep `inputs` frozen.');
    const result = await execute(() => {
      rmSync(join(project, 'inputs/report.md')); symlinkSync('evidence.md', join(project, 'inputs/report.md'));
      write('inputs/report.md', 'corrupt through output alias'); return ['inputs/report.md'];
    });
    expect(result.status.status).toBe('failed');
    expect(readlinkSync(join(project, 'inputs/report.md'))).toBe('prior.md');
    expect(readFileSync(join(project, 'inputs/prior.md'), 'utf8')).toBe('previous output');
    expect(readFileSync(join(project, 'inputs/evidence.md'), 'utf8')).toBe('exact evidence');
  });

  it('restores large frozen evidence from owned backing after settlement', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x81); write('evidence.bin', bytes); commit();
    create('---\ninputs: [{path: evidence.bin, frozen: true}]\n---\nKeep `evidence.bin` immutable.');
    const result = await execute(() => { write('evidence.bin', 'bad'); return ['evidence.bin']; });
    expect(result.status.status).toBe('failed');
    expect(readFileSync(join(project, 'evidence.bin'))).toEqual(bytes);
  });

  it.each([
    { ancestor: 'evidence', member: 'evidence/value.txt', writes: [] },
    { ancestor: 'evidence', member: 'evidence/value.txt', writes: ['./evidence/value.txt', 'evidence'] },
    { ancestor: 'evidence/nested', member: 'evidence/nested/value.txt', writes: ['evidence/nested/value.txt', 'evidence/nested'] },
    { ancestor: 'container', member: 'container/evidence/value.txt', writes: ['container'], replacement: 'file', input: 'container/evidence' },
  ])('never follows a substituted frozen ancestor when restoring content (%j)', ({ ancestor, member, writes, replacement, input }) => {
    write(member, 'original'); writeFileSync(join(root, 'outside.txt'), 'outside sentinel'); commit();
    const frozen = input ?? 'evidence';
    create(`---\ninputs: [{path: ${frozen}, frozen: true}]\n---\nKeep \`${frozen}\` frozen.`);
    const context = createScopeBatchContext(project, [stage()], undefined, runId);
    expect(context.snapshot.rollbackBaseline.frozenImages.get(ancestor)).toMatchObject({ exists: true, type: 'directory' });
    rmSync(join(project, ancestor), { recursive: true });
    if (replacement === 'file') write(ancestor, 'replacement sentinel');
    else symlinkSync(root, join(project, ancestor), 'dir');
    let result!: ReturnType<typeof settleProjectWrites>;
    expect(() => { result = settleProjectWrites({ projectDir: project, snapshot: context.snapshot,
      rawWrites: writes, definiteWrites: new Set() }); }).not.toThrow();
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.rollbackFailures).toEqual([]);
    expect(result.rolledBackWrites).toContain(member);
    expect(readFileSync(join(project, member), 'utf8')).toBe('original');
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('outside sentinel');
    if (replacement === 'file') expect(readFileSync(result.retainedReplacements[ancestor], 'utf8')).toBe('replacement sentinel');
  });

  it('rejects additive files only when the task explicitly freezes the entire evidence tree', async () => {
    write('evidence/original.txt', 'original'); commit();
    create('---\ninputs: [{path: evidence, frozen: true}]\n---\nKeep `evidence` frozen.');
    const result = await execute(() => { write('evidence/addition.txt', 'forbidden addition'); return ['evidence/addition.txt']; });
    expect(result.status.status).toBe('failed');
    expect(result.audits[0].rolledBackWrites).toContain('evidence/addition.txt');
    expect(existsSync(join(project, 'evidence/addition.txt'))).toBe(false);
    expect(readFileSync(join(project, 'evidence/original.txt'), 'utf8')).toBe('original');
  });

  it('freezes only boolean frontmatter declarations, regardless of annotation prose', () => {
    write('evidence.txt', 'original');
    for (const metadata of ['note: frozen evidence', 'role: immutable evidence', 'frozen: false']) {
      expect(resolveImmutableEvidenceBindings(project,
        `---\ninputs:\n  - path: evidence.txt\n    ${metadata}\n---\nPreserve \`evidence.txt\` bytes.`)).toEqual([]);
    }
    expect(resolveImmutableEvidenceBindings(project,
      '---\ninputs: [{path: evidence.txt, frozen: true}, source.ts]\n---\nUse the source.')
      .map(binding => binding.path)).toEqual(['evidence.txt']);
    expect(resolveImmutableEvidenceBindings(project, 'Preserve `evidence.txt` bytes.')).toEqual([]);
  });
});


it('keeps ordinary wave snapshots and settled writes as identities without rollback payloads', () => {
  write('src/tracked.py', 'print(1)\n'); commit();
  write('src/tracked.py', 'print(2)\n');
  write('data/untracked.bin', Buffer.alloc(3_000_000, 7));
  write('notes.md', 'operator notes\n');
  const stages = create('---\noutputs: [out.md]\n---\nDo work.', [stage('author', ['src'])]);
  const snapshot = captureRepairRoundSnapshot(project, stages, { runDirPath: directory });
  expect(readdirSync(join(directory, '.rollback-preimages'))).toEqual([]);
  for (const image of snapshot.files.values()) {
    expect(image.text).toBeUndefined(); expect(image.bytes).toBeUndefined(); expect(image.backingPath).toBeUndefined();
  }
  write('src/new_output.py', 'x = 1\n'.repeat(1000));
  const settled = settleProjectWrites({ projectDir: project, snapshot,
    rawWrites: ['src/new_output.py'], definiteWrites: new Set(['src/new_output.py']) });
  expect(settled).toMatchObject({ appliedWrites: ['src/new_output.py'], durableWrites: ['src/new_output.py'],
    rolledBackWrites: [], rollbackFailures: [], violations: [] });
  expect(readdirSync(join(directory, '.rollback-preimages'))).toEqual([]);
});

it('restores the original task-frozen bytes at two successive settlements', () => {
  write('frozen.txt', 'ORIGINAL'); commit();
  const stages = create('---\ninputs: [{path: frozen.txt, frozen: true}]\n---\nKeep the evidence.', [stage()]);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const snapshot = captureRepairRoundSnapshot(project, stages, { runDirPath: directory });
    expect(snapshot.rollbackBaseline.frozenImages.get('frozen.txt')?.backingPath).toBeTruthy();
    write('frozen.txt', `CORRUPT ${attempt}`);
    write('report.md', `delivered ${attempt}`);
    const settled = settleProjectWrites({ projectDir: project, snapshot,
      rawWrites: ['frozen.txt', 'report.md'], definiteWrites: new Set(['frozen.txt', 'report.md']) });
    expect(settled).toMatchObject({ appliedWrites: ['report.md'], durableWrites: ['report.md'],
      rolledBackWrites: ['frozen.txt'], rollbackFailures: [], rollbackFailureReasons: {},
      violations: [{ path: 'frozen.txt', certainty: 'definite', reason: 'task-frozen evidence content changed' }] });
    expect(readFileSync(join(project, 'frozen.txt'), 'utf8')).toBe('ORIGINAL');
  }
});
