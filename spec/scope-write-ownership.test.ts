import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { compareRepairFileContents, readRepairFileImage } from '../src/scheduler/sched_scope/file-images.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { createScopeBatchContext, type ScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { createLiveGuardFactory } from '../src/scheduler/sched_scope/write-enforcement.js';
import { createScopeReconciler } from '../src/scheduler/sched_scope/reconciliation.js';
import { listProjectFiles } from '../src/scheduler/sched_scope/path-capabilities.js';
import { beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string;
let project: string;
let priorState: string;
let runPath: string;

beforeEach(() => {
  const scratch = join(process.cwd(), '.cache');
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'scope-ownership-'));
  project = join(root, 'project');
  mkdirSync(project);
  execFileSync(process.execPath, ['--input-type=module', '-e', "import { execFileSync } from 'node:child_process'; execFileSync('git', ['init', '-q']);"], {
    cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'state') },
  });
  priorState = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
  runPath = '';
});

afterEach(() => {
  closeRollbackBaseline(project, runPath || undefined);
  setFcGlobalDir(priorState);
  rmSync(root, { recursive: true, force: true });
});

const stage = (id: string, scope: string[]) => StageConfigSchema.parse({ id, role: 'coder', scope });

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), contents);
}

function projectProbe(script: string, args: string[] = []): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, ...args], {
    cwd: project, encoding: 'utf8', env: { ...process.env, HOME: root, FC_HOME: join(root, 'state') },
  });
}

function commitFixture(force = false): void {
  projectProbe("import { execFileSync } from 'node:child_process'; for (const args of JSON.parse(process.argv[1])) execFileSync('git', args);", [
    JSON.stringify([force ? ['add', '-f', '.'] : ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']]),
  ]);
}

async function scan(context: ScopeBatchContext, writer: ReturnType<typeof stage>, runId: string, paths: string[], attributed = true) {
  // A deterministic observer distinguishes notification from adapter proof
  // even when native recursive watching is unavailable on the test platform.
  context.snapshot.rollbackBaseline.watcher?.close();
  const watcher = Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;
  context.snapshot.rollbackBaseline.watcher = watcher;
  const factory = createLiveGuardFactory().createSchedulerLiveConstraintGuardFactory({
    stage: writer, projectDir: project, runId, context,
  })!;
  const aborts: string[] = [];
  const monitor = factory({ attemptIndex: 1, attemptStartedAt: new Date().toISOString() })
    .beginInvocation(1, reason => aborts.push(reason));
  if (attributed) monitor.observePaths(paths);
  else for (const path of paths) watcher.emit('change', 'change', path);
  return { result: await monitor.finish(), aborts };
}

describe('observed existence owns dependency comparison', () => {
  it.each([
    { boundary: 'live', attributed: true }, { boundary: 'live', attributed: false },
    { boundary: 'settlement', attributed: true }, { boundary: 'settlement', attributed: false },
  ])('uses the shared cache rule during $boundary (attributed=$attributed)', async ({ boundary, attributed }) => {
    const source = 'tools/parity/module.py';
    const trackedCache = 'tools/parity/__pycache__/tracked.pyc';
    const cache = 'tools/parity/__pycache__/module.pyc';
    const ignoredData = 'tools/parity/data/frozen.csv';
    const omittedData = 'tools/parity/.venv/evidence.csv';
    const newData = 'tools/parity/.venv/added.csv';
    write('.gitignore', '**/__pycache__/\n**/data/\n**/.venv/\n');
    write(source, 'VALUE = 1\n');
    write(trackedCache, 'authored cache fixture\n');
    commitFixture(true);
    write(ignoredData, 'id\n1\n');
    write(omittedData, 'id\n2\n');
    const writer = stage('writer', ['**']);
    const created = createRun(project, 'input-preservation', '', [writer.id]);
    runPath = created.runDirPath;
    writeFileSync(join(runPath, 'task_brief.md'), '---\ninputs: [tools/parity]\n---\n# Goal\nRead the Python source.\n');
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    beginStageAttempt(project, created.runId, writer.id, 0);
    const originals = new Map([
      [source, 'VALUE = 1\n'], [trackedCache, 'authored cache fixture\n'],
      [ignoredData, 'id\n1\n'], [omittedData, 'id\n2\n'],
    ]);
    write(cache, 'interpreter output\n');
    for (const path of originals.keys()) write(path, 'real edit\n');
    write(newData, 'new data member\n');
    const protectedPaths = [...originals.keys(), newData];
    const writes = [cache, ...protectedPaths];
    if (boundary === 'live') {
      const { result, aborts } = await scan(context, writer, created.runId, writes, attributed);
      if (attributed) expect(result.exemptedPaths).toContain(cache);
      expect(result.incidents.map(incident => incident.path).sort()).toEqual(protectedPaths.sort());
      expect(result.incidents.every(incident => incident.restored)).toBe(true);
      expect(aborts.length).toBeGreaterThan(0);
    } else {
      completeStageAttempt(project, created.runId, writer.id, 0, {
        exitCode: 0, duration_ms: 1, writes: attributed ? writes : [],
        writeAttribution: attributed ? 'structured' : 'unknown',
      });
      const reconciled = createScopeReconciler().reconcileStageScope({
        stage: writer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
      });
      expect(reconciled.violation).toBe(attributed);
      const audit = JSON.parse(readFileSync(join(runPath, reconciled.status.attempts![0].constraintAudit!.path), 'utf8'));
      if (attributed) expect(audit.exemptedWrites).toContain(cache);
      expect(audit.rolledBackWrites.sort()).toEqual(protectedPaths.sort());
      expect(audit.rollbackFailures).toEqual([]);
    }
    expect(readFileSync(join(project, cache), 'utf8')).toBe('interpreter output\n');
    for (const [path, contents] of originals) expect(readFileSync(join(project, path), 'utf8')).toBe(contents);
    expect(() => readFileSync(join(project, newData), 'utf8')).toThrow();
  });

  it('preserves tracked cache content reached through a declared directory alias', async () => {
    const path = 'tools/parity/__pycache__/nested/evidence.pyc';
    write(path, 'authored bytes\n');
    commitFixture();
    symlinkSync('tools/parity', join(project, 'input-alias'), 'dir');
    const writer = stage('writer', ['**']);
    const created = createRun(project, 'input-alias-preservation', '', [writer.id]);
    runPath = created.runDirPath;
    writeFileSync(join(runPath, 'task_brief.md'), '---\ninputs: [input-alias]\n---\n# Goal\nPreserve the source.\n');
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    beginStageAttempt(project, created.runId, writer.id, 0);
    write('input-alias/__pycache__/nested/evidence.pyc', 'real edit\n');
    const { result } = await scan(context, writer, created.runId, ['input-alias/__pycache__/nested/evidence.pyc'], false);
    expect(result.incidents).toContainEqual(expect.objectContaining({ path, restored: true }));
    expect(readFileSync(join(project, path), 'utf8')).toBe('authored bytes\n');
  });

  it.each([false, true])('keeps a declared output inside a preserved input writable at live and settlement boundaries (existing=%s)', async existing => {
    const output = 'fixtures/source/report.md';
    const evidence = 'fixtures/source/evidence.txt';
    const undeclared = 'fixtures/source/undeclared.txt';
    write(evidence, 'preserved evidence\n');
    if (existing) write(output, 'previous report\n');
    commitFixture();
    const writer = stage('writer', ['**']);
    const created = createRun(project, 'nested-output', '', [writer.id]);
    runPath = created.runDirPath;
    writeFileSync(join(runPath, 'task_brief.md'), [
      '---', 'inputs: [fixtures/source]', 'outputs:',
      `  - path: ${output}`, ...(existing ? ['    on_existing: replace'] : []),
      '---', '# Goal', 'Write the declared report from preserved evidence.',
    ].join('\n'));
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    beginStageAttempt(project, created.runId, writer.id, 0);
    write(output, 'authorized report\n');
    const allowed = await scan(context, writer, created.runId, [output]);
    expect(allowed.result.incidents).toEqual([]);
    expect(allowed.aborts).toEqual([]);
    completeStageAttempt(project, created.runId, writer.id, 0, {
      exitCode: 0, duration_ms: 1, writes: [output], writeAttribution: 'structured',
    });
    const reconciled = createScopeReconciler().reconcileStageScope({
      stage: writer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
    });
    expect(reconciled.violation).toBe(false);
    expect(readFileSync(join(project, output), 'utf8')).toBe('authorized report\n');
    const audit = JSON.parse(readFileSync(join(runPath, reconciled.status.attempts![0].constraintAudit!.path), 'utf8'));
    expect(audit.durableWrites).toContain(output);
    expect(audit.rollbackFailures).toEqual([]);

    // A sibling remains a preserved input even under the same unrestricted scope.
    write(evidence, 'unauthorized evidence replacement\n');
    write(undeclared, 'unauthorized new sibling\n');
    const protectedWrites = await scan(context, writer, created.runId, [evidence, undeclared]);
    expect(protectedWrites.result.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: evidence, restored: true }),
      expect.objectContaining({ path: undeclared, restored: true }),
    ]));
    expect(readFileSync(join(project, evidence), 'utf8')).toBe('preserved evidence\n');
    expect(() => readFileSync(join(project, undeclared), 'utf8')).toThrow();
    expect(readFileSync(join(project, output), 'utf8')).toBe('authorized report\n');
  });

  it('does not accuse an omitted dependency merely because a scan nominates it', async () => {
    const dependency = join('.venv', 'library', 'index.js');
    write(dependency, 'pre-existing dependency\n');
    const writer = stage('writer', ['src/allowed.ts']);
    const created = createRun(project, 'dependency-comparison', '', [writer.id]);
    runPath = created.runDirPath;
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    const { result, aborts } = await scan(context, writer, created.runId, [dependency], false);
    expect(result.incidents).toEqual([]);
    expect(aborts).toEqual([]);
    expect(readFileSync(join(project, dependency), 'utf8')).toBe('pre-existing dependency\n');
  });

  it('keeps observed absence distinct from unknown existence in both directions', () => {
    const missing = readRepairFileImage(project, 'new.txt');
    expect(missing).toMatchObject({ exists: false, provenance: 'observed' });
    write('new.txt', 'created\n');
    const present = readRepairFileImage(project, 'new.txt');
    expect(compareRepairFileContents(missing, present)).toBe('different');
    expect(compareRepairFileContents(present, missing)).toBe('different');
    expect(compareRepairFileContents({ exists: false, provenance: 'unknown' }, missing)).toBe('unavailable');
    expect(compareRepairFileContents(present, { exists: false, provenance: 'unknown' })).toBe('unavailable');
  });

  it('refuses structured dependency writes with an unknown preimage without deleting their bytes', async () => {
    const dependency = join('.venv', 'library', 'index.js');
    write(dependency, 'pre-existing dependency\n');
    const writer = stage('writer', []);
    const created = createRun(project, 'dependency-refusal', '', [writer.id]);
    runPath = created.runDirPath;
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    write(dependency, 'proven unauthorized replacement\n');
    const { result, aborts } = await scan(context, writer, created.runId, [dependency]);
    expect(result.incidents).toContainEqual(expect.objectContaining({
      path: dependency, restored: false, changeObserved: true,
      rollbackFailure: expect.stringContaining('absence was not observed'),
    }));
    expect(aborts).toContain('live_constraint_rollback_failure');
    completeStageAttempt(project, created.runId, writer.id, 0, {
      exitCode: 0, duration_ms: 1, writes: [dependency], writeAttribution: 'structured',
    });
    const reconciled = createScopeReconciler().reconcileStageScope({
      stage: writer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
    });
    expect(reconciled.violation).toBe(true);
    expect(reconciled.status.status).toBe('failed');
    const audit = JSON.parse(readFileSync(join(runPath, reconciled.status.attempts![0].constraintAudit!.path), 'utf8'));
    expect(audit.violations).toContainEqual(expect.objectContaining({ path: dependency, certainty: 'definite' }));
    expect(audit.rollbackFailures).toEqual([dependency]);
    expect(audit.rollbackFailureReasons[dependency]).toContain('absence was not observed');
    expect(readFileSync(join(project, dependency), 'utf8')).toBe('proven unauthorized replacement\n');
  });

  it('allows the project install command after a locked dependency change at live and settlement boundaries', async () => {
    const dependencyDirectory = 'node_modules';
    write('.gitignore', `${dependencyDirectory}/\n`);
    write('vendor/fixture/package.json', JSON.stringify({ name: 'install-fixture', version: '1.0.0', main: 'index.js' }));
    write('vendor/fixture/index.js', 'module.exports = 42;\n');
    write('vendor/existing/package.json', JSON.stringify({ name: 'existing-fixture', version: '1.0.0' }));
    const manifest = { name: 'dependency-install-fixture', private: true, version: '1.0.0',
      dependencies: { 'existing-fixture': 'file:vendor/existing' } };
    write('package.json', JSON.stringify(manifest));
    const npm = (args: string[]) => projectProbe("import { execFileSync } from 'node:child_process'; execFileSync('npm', JSON.parse(process.argv[1]));", [
      JSON.stringify([...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(root, 'npm-cache')]),
    ]);
    npm(['install', '--package-lock-only']);
    npm(['ci']);
    commitFixture();
    const writer = stage('writer', ['package.json', 'package-lock.json']);
    const created = createRun(project, 'dependency-install', '', [writer.id]);
    runPath = created.runDirPath;
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    expect([...context.snapshot.rollbackBaseline.images.keys()].some(path => path.startsWith(`${dependencyDirectory}/`))).toBe(true);
    expect(context.snapshot.measurement.baselineFilesHashed).toBe(0);
    beginStageAttempt(project, created.runId, writer.id, 0);
    write('package.json', JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'install-fixture': 'file:vendor/fixture' } }));
    npm(['install', '--package-lock-only']);
    npm(['ci']);
    const dependencyPaths = listProjectFiles(join(project, dependencyDirectory)).map(path => `${dependencyDirectory}/${path}`);
    expect(dependencyPaths.length).toBeGreaterThan(0);
    const writes = ['package.json', 'package-lock.json', ...dependencyPaths];
    const { result, aborts } = await scan(context, writer, created.runId, writes);
    expect(result.incidents).toEqual([]);
    expect(aborts).toEqual([]);
    completeStageAttempt(project, created.runId, writer.id, 0, {
      exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured',
    });
    const reconciled = createScopeReconciler().reconcileStageScope({
      stage: writer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
    });
    expect(reconciled.violation).toBe(false);
    const audit = JSON.parse(readFileSync(join(runPath, reconciled.status.attempts![0].constraintAudit!.path), 'utf8'));
    expect(audit.exemptedWrites).toEqual(expect.arrayContaining(dependencyPaths));
    expect(audit.rollbackFailures).toEqual([]);
    expect(projectProbe("import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); process.stdout.write(String(require('install-fixture')));")).toBe('42');
  });

  it.each([
    { protection: 'tracked files', alias: false, attributed: false },
    { protection: 'declared inputs', alias: true, attributed: false },
    { protection: 'declared inputs', alias: true, attributed: true },
  ])('restores dependency content and link-target changes protected by $protection (aliases=$alias, attributed=$attributed)', async ({ alias, attributed }) => {
    const prefixes = ['', 'ui/'];
    const dependencyDirectory = 'node_modules';
    const paths = prefixes.flatMap(prefix => [
      join(prefix, dependencyDirectory, 'tool', 'package.json'),
      join(prefix, dependencyDirectory, 'tool', 'bin', 'tool.js'),
      join(prefix, dependencyDirectory, '.bin', 'tool'),
    ]);
    if (alias) for (const prefix of prefixes) {
      const parent = join(project, prefix), target = join(root, 'dependency-store', prefix || 'root');
      mkdirSync(parent, { recursive: true }); mkdirSync(target, { recursive: true });
      symlinkSync(relative(parent, target), join(parent, dependencyDirectory));
    }
    for (const path of paths) {
      if (path.endsWith('/.bin/tool')) {
        mkdirSync(dirname(join(project, path)), { recursive: true });
        symlinkSync('../tool/bin/tool.js', join(project, path));
      } else write(path, `original ${path}\n`);
    }
    write('.gitignore', `${dependencyDirectory}/\n`);
    if (!alias) commitFixture(true);
    const writer = stage('writer', []);
    const created = createRun(project, 'protected-dependencies', '', [writer.id]);
    runPath = created.runDirPath;
    if (alias) writeFileSync(join(runPath, 'task_brief.md'), `---\ninputs: ${JSON.stringify(prefixes.map(prefix => `${prefix}${dependencyDirectory}/`))}\n---\nUse the frozen dependencies.`);
    const context = createScopeBatchContext(project, [writer], undefined, created.runId);
    for (const path of paths) {
      if (path.endsWith('/.bin/tool')) {
        rmSync(join(project, path)); symlinkSync('../wrong/bin.js', join(project, path));
      } else write(path, 'changed dependency content');
    }
    const { result, aborts } = await scan(context, writer, created.runId, paths, attributed);
    expect(result.incidents).toHaveLength(6);
    expect(result.incidents.every(incident => incident.changeObserved && incident.restored)).toBe(true);
    expect(aborts).toContain('live_constraint_violation');
    for (const path of paths) {
      if (path.endsWith('/.bin/tool')) expect(readlinkSync(join(project, path))).toBe('../tool/bin/tool.js');
      else expect(readFileSync(join(project, path), 'utf8')).toBe(`original ${path}\n`);
    }
  });

});

describe('enforcement owns batch audit outcomes', () => {
  function batch() {
    const author = stage('author', ['src/author.ts']);
    const observer = stage('observer', ['src/observer.ts']);
    write('src/author.ts', 'author preimage\n');
    write('src/observer.ts', 'observer preimage\n');
    write('src/unowned.ts', 'unowned preimage\n');
    const created = createRun(project, 'batch-ownership', '', [author.id, observer.id]);
    runPath = created.runDirPath;
    const context = createScopeBatchContext(project, [author, observer], undefined, created.runId);
    // Exercise settlement independently of asynchronous watcher delivery.
    context.snapshot.rollbackBaseline.reliable = false;
    beginStageAttempt(project, created.runId, author.id, 0);
    beginStageAttempt(project, created.runId, observer.id, 0);
    return { author, observer, created, context };
  }

  it.each(['structured', 'snapshot'] as const)('does not label an authorized peer write out of scope for a %s observer', attribution => {
    const { author, observer, created, context } = batch();
    write('src/author.ts', 'authorized peer write\n');
    completeStageAttempt(project, created.runId, author.id, 0, {
      exitCode: 0, duration_ms: 1, writes: ['src/author.ts'], writeAttribution: 'structured',
    });
    completeStageAttempt(project, created.runId, observer.id, 0, {
      exitCode: 0, duration_ms: 1, writes: [], writeAttribution: attribution,
    });
    const reconcile = createScopeReconciler().reconcileStageScope;
    const authored = reconcile({ stage: author, projectDir: project, runId: created.runId, context, attemptIndex: 1 });
    expect(authored.status.attempts![0].constraintAudit!.appliedWriteCount).toBe(1);
    const observed = reconcile({ stage: observer, projectDir: project, runId: created.runId, context, attemptIndex: 1 });
    expect(observed.status.attempts![0].constraintAudit).toMatchObject({ violationCount: 0, unverifiedCount: 0 });
    const audit = JSON.parse(readFileSync(join(runPath, observed.status.attempts![0].constraintAudit!.path), 'utf8'));
    expect(audit.rawWrites).toContain('src/author.ts');
    expect(audit.violations).toEqual([]);
    expect(readFileSync(join(project, 'src/author.ts'), 'utf8')).toBe('authorized peer write\n');
  });

  it('refuses a structured cross-scope write even when a peer owns that path', () => {
    const { observer, created, context } = batch();
    write('src/author.ts', 'observer trespass\n');
    completeStageAttempt(project, created.runId, observer.id, 0, {
      exitCode: 0, duration_ms: 1, writes: ['src/author.ts'], writeAttribution: 'structured',
    });
    const observed = createScopeReconciler().reconcileStageScope({
      stage: observer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
    });
    expect(observed.violation).toBe(true);
    expect(observed.status.attempts![0].constraintAudit).toMatchObject({ violationCount: 1, rolledBackWriteCount: 1 });
    expect(readFileSync(join(project, 'src/author.ts'), 'utf8')).toBe('author preimage\n');
  });

  it('delivers a structured trespass only to its writer across three disjoint partitions', async () => {
    const { author, observer: offender, created, context: original } = batch();
    const observer = stage('third', ['src/third.ts']);
    const context = createScopeBatchContext(project, [author, offender, observer], original.snapshot, created.runId);
    write('src/author.ts', 'structured trespass\n');
    const offenderResult = await scan(context, offender, created.runId, ['src/author.ts']);
    expect(offenderResult.result.incidents).toContainEqual(expect.objectContaining({ path: 'src/author.ts', restored: true }));
    expect(offenderResult.aborts).toContain('live_constraint_violation');
    for (const innocent of [author, observer]) {
      const result = await scan(context, innocent, created.runId, []);
      expect(result.result.incidents).toEqual([]);
      expect(result.aborts).toEqual([]);
    }
    expect(readFileSync(join(project, 'src/author.ts'), 'utf8')).toBe('author preimage\n');
  });

  it('retains an unverified unauthorized change outside every batch partition', () => {
    const { observer, context, created } = batch();
    write('src/unowned.ts', 'unverified trespass\n');
    completeStageAttempt(project, created.runId, observer.id, 0, {
      exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'snapshot',
    });
    const reconciled = createScopeReconciler().reconcileStageScope({
      stage: observer, projectDir: project, runId: created.runId, context, attemptIndex: 1,
    });
    expect(reconciled.status.attempts![0].constraintAudit).toMatchObject({
      unverifiedCount: 1, violationCount: 0, rolledBackWriteCount: 1,
    });
    expect(readFileSync(join(project, 'src/unowned.ts'), 'utf8')).toBe('unowned preimage\n');
  });
});
