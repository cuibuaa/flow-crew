import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runShipSetup, cmdShipSetupWithDeps } from '../src/cli-ship-setup.js';
import { assertMeasuredSetupLaunch } from '../src/ship-setup-record.js';
import { admitWriteGrant, assertWriteGrantReady, queryWriteGrantCapability, withStageWriteGrant } from '../src/write-grant.js';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { fcGlobalDir, readStageStatus, runsRoot, setFcGlobalDir } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { retireRunScratch } from '../src/invocation-scratch.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runScopeSafeStageGroup } from '../src/scheduler/sched_loop/services.js';
import { createRun } from './test-support/create-run.js';
import { runStage } from './test-support/stage-deadline.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { extractBriefOutputDeclarations } from '../src/ship-inputs.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

// External capabilities live beside the synthetic installation, independently
// of whether the test runner's private temporary parent is under its checkout.
const installation = vi.hoisted(() => ({ install: () => {} }));
vi.mock('../src/ship-inputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-inputs.js')>();
  const { dirname, join } = await import('node:path');
  const external = actual.externalOutputDirectory, inventory = actual.inspectBriefOutputs;
  installation.install = () => {
    vi.spyOn(actual, 'externalOutputDirectory').mockImplementation((declaration, project, fs, context) =>
      external(declaration, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
    vi.spyOn(actual, 'inspectBriefOutputs').mockImplementation((text, project, fs, context) =>
      inventory(text, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
  };
  return actual;
});

const capability = queryWriteGrantCapability();
const baseBrief = '---\ninputs: [{path: seed, frozen: true}]\n---\nDeliver the change.';
let brief = baseBrief;
let root: string, primary: string, checkout: string, previous: string;
const ownedRuns: string[] = [];
const git = (cwd: string, args: string[]) => isolatedProjectCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], cwd, root).trim();
beforeEach(() => {
  installation.install(); brief = baseBrief;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-grant-')));
  primary = join(root, 'primary'); checkout = join(root, 'checkout');
  mkdirSync(primary);
  git(primary, ['init', '-b', 'base']);
  writeFileSync(join(primary, 'seed'), 'frozen baseline');
  writeFileSync(join(primary, 'brief.md'), brief);
  git(primary, ['add', '.']);
  git(primary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  git(primary, ['worktree', 'add', '-b', 'result', checkout, 'HEAD']);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of ownedRuns.splice(0)) retireRunScratch(directory);
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
const args = (target = checkout) => ['ship-setup', '--project', primary, '--target', target,
  '--brief', 'brief.md', '--base', 'HEAD', '--branch', target === primary ? 'base' : 'result'];
const setup = (target = checkout, runner = vi.fn(() => ({ exitCode: 0 }))) => runShipSetup(args(target), { runValidationCommand: runner });
function expectNoProbe() {
  expect(readdirSync(runsRoot()).filter(name => name.startsWith('.grant-'))).toEqual([]);
}
function runtime(target: string, script = "console.log('started')") {
  const { runId, runDirPath } = createRun(target, 'grant-fixture', 'name: fixture\nstages: []\n', ['author'], brief);
  ownedRuns.push(runDirPath);
  return withStageWriteGrant({ contract: admitWriteGrant(target), projectDir: target, runDir: runDirPath,
    stageId: 'author', externalDirectories: extractBriefOutputDeclarations(brief).filter(output => isAbsolute(output.path)).map(output => output.path), home: join(runDirPath, 'work', 'stages', 'author', 'home') }, () =>
    execWithStdin(process.execPath, ['-e', script], '', { cwd: target, execution: { runDir: runDirPath }, timeout_ms: 60_000 }));
}

// Unavailable hosts visibly skip the real enforcement cases; they never count as passes.
describe.skipIf(capability.kind !== 'landlock')('setup and native grant share readiness', () => {
  it('refuses an embedded common directory before validation or READY, with the runtime rule and repair', async () => {
    const runner = vi.fn(() => ({ exitCode: 0 }));
    let output = '';
    const exit = await cmdShipSetupWithDeps(args(primary), { runValidationCommand: runner,
      stdout: { write: chunk => { output += chunk; } }, stderr: { write: chunk => { output += chunk; } } });
    expect(exit).toBe(1);
    expect(output).toContain('Ship setup: REFUSED');
    expect(output).not.toContain('Ship setup: READY');
    expect(output).toContain('unsafe_path');
    expect(output).toContain(primary);
    expect(output).toContain('use a linked worktree');
    expect(runner).not.toHaveBeenCalled();
    const actual = await runtime(primary);
    expect(actual.writeGrantFailure).toEqual({ kind: 'unsafe_path', path: join(primary, '.git') });
    expect(actual.exitCode).toBe(125);
    expect(actual.output).not.toContain('started');
    expectNoProbe();
  });

  it('rechecks an old READY receipt at the shared quick/library admission boundary', () => {
    writeReadySetupRecord(primary, brief, fcGlobalDir());
    expect(() => assertMeasuredSetupLaunch(primary, brief)).toThrow(expect.objectContaining({
      outcome: { kind: 'unsafe_path', path: join(primary, '.git') }, message: expect.stringContaining('use a linked worktree'),
    }));
    expectNoProbe();
  });

  it('admits a linked worktree, isolates shared refs/config/hooks and outside paths, and cleans its probe', async () => {
    const report = await setup();
    expect(report.state, JSON.stringify(report.blockers)).toBe('ready');
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).not.toThrow();
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    const protectedPaths = ['refs/heads/base', 'config', 'hooks/post-commit'].map(path => join(primary, '.git', path));
    const actual = await runtime(checkout, `const fs=require('node:fs');
fs.writeFileSync('new-file','allowed'); fs.writeFileSync(process.env.HOME+'/state','allowed');
const denials=${JSON.stringify([...protectedPaths, outside])}.map(path=>{try{fs.writeFileSync(path,'bad');return null;}catch(error){return error.code;}});
console.log(JSON.stringify(denials));`);
    expect(actual.exitCode, actual.output).toBe(0);
    expect(actual.writeGrantApplied?.linkedFileCount).toBe(0);
    expect(JSON.parse(actual.output)).toEqual(['EACCES', 'EACCES', 'EACCES', 'EACCES']);
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(readFileSync(join(checkout, 'new-file'), 'utf8')).toBe('allowed');
    expect(git(checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe('result');
    expectNoProbe();
  });

  it('uses runtime run containment when the selected state store is inside the worktree', async () => {
    setFcGlobalDir(join(checkout, 'state'));
    const report = await setup();
    expect(report).toMatchObject({ state: 'refused', blockers: [{ code: 'unsafe_path', reason: expect.stringContaining(checkout) }] });
    writeReadySetupRecord(checkout, brief, fcGlobalDir());
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'unsafe_path', path: checkout } }));
    expect((await runtime(checkout)).writeGrantFailure).toEqual({ kind: 'unsafe_path', path: checkout });
    expectNoProbe();
  });

  it('refuses a run store that cannot contain a directory rather than measuring validation', async () => {
    mkdirSync(fcGlobalDir()); writeFileSync(runsRoot(), 'occupied');
    const runner = vi.fn(() => ({ exitCode: 0 }));
    const report = await setup(checkout, runner);
    expect(report).toMatchObject({ state: 'refused', blockers: [{ code: 'application_failed' }] });
    expect(runner).not.toHaveBeenCalled();
    writeReadySetupRecord(checkout, brief, fcGlobalDir());
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'application_failed', errno: expect.any(Number) } }));
  });

  it('uses the runtime scratch owner and refuses an unusable invocation temporary parent', async () => {
    const temporary = join(root, 'temporary-file'); writeFileSync(temporary, 'occupied');
    vi.stubEnv('TMPDIR', temporary);
    const runner = vi.fn(() => ({ exitCode: 0 }));
    expect(await setup(checkout, runner)).toMatchObject({ state: 'refused', blockers: [{ code: 'application_failed' }] });
    expect(runner).not.toHaveBeenCalled();
    writeReadySetupRecord(checkout, brief, fcGlobalDir());
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'application_failed', errno: expect.any(Number) } }));
    expectNoProbe();
  });

  it('asks private ref/index preparation before READY and at launch', async () => {
    const tree = git(primary, ['rev-parse', 'HEAD^{tree}']);
    rmSync(join(primary, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    const report = await setup();
    expect(report).toMatchObject({ state: 'refused', blockers: [{ code: 'git_preparation_failed', reason: expect.stringContaining('stages/probe/git') }] });
    writeReadySetupRecord(checkout, brief, fcGlobalDir());
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'git_preparation_failed', path: expect.stringContaining('stages/probe/git') } }));
    const actual = await runtime(checkout);
    expect(actual.writeGrantFailure).toEqual({ kind: 'git_preparation_failed', path: expect.stringContaining('stages/author/git') });
    expectNoProbe();
  });

  it('refuses an ignored hardlink before READY, admits copied bytes, and rechecks a stale receipt', async () => {
    const store = join(root, 'package'); writeFileSync(store, 'dependency');
    mkdirSync(join(checkout, 'dependencies')); writeFileSync(join(checkout, '.gitignore'), 'dependencies/\n');
    const dependency = join(checkout, 'dependencies', 'package'); linkSync(store, dependency);
    const report = await setup();
    expect(report).toMatchObject({ state: 'refused', blockers: [{ code: 'linked_files', reason: expect.stringContaining('"count":1') }] });
    expect((await runtime(checkout)).writeGrantFailure).toEqual({ kind: 'linked_files', count: 1 });
    rmSync(dependency); copyFileSync(store, dependency);
    expect((await setup()).state).toBe('ready');
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).not.toThrow();
    rmSync(dependency); linkSync(store, dependency);
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'linked_files', count: 1 } }));
    expectNoProbe();
  });

  it('probes declared external output grants, refuses hardlinks and admits copied output bytes', async () => {
    const output = join(root, 'products'); mkdirSync(output);
    const source = join(root, 'output-store'); writeFileSync(source, 'retained output');
    const product = join(output, 'artifact'); linkSync(source, product);
    brief = `---\ninputs: [{path: seed, frozen: true}]\noutputs: [{path: ${JSON.stringify(output)}, type: directory}]\n---\nRetain products.`;
    writeFileSync(join(primary, 'brief.md'), brief);
    const report = await setup();
    expect(report).toMatchObject({ state: 'refused', blockers: [{ code: 'linked_files', reason: expect.stringContaining('"count":1') }] });
    expect((await runtime(checkout)).writeGrantFailure).toEqual({ kind: 'linked_files', count: 1 });
    rmSync(product); copyFileSync(source, product);
    expect((await setup()).state).toBe('ready');
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).not.toThrow();
    expect((await runtime(checkout)).writeGrantApplied?.linkedFileCount).toBe(0);
    rmSync(product); linkSync(source, product);
    expect(() => assertMeasuredSetupLaunch(checkout, brief)).toThrow(expect.objectContaining({ outcome: { kind: 'linked_files', count: 1 } }));
    expectNoProbe();
  });

  it('still fails an attempt for frozen input writes made through the real native grant', async () => {
    expect((await setup()).state).toBe('ready');
    const stage = StageConfigSchema.parse({ id: 'author', role: 'coder', scope: ['.'] });
    const { runId, runDirPath } = createRun(checkout, 'frozen-grant', 'name: fixture\nstages: []\n', ['author'], brief);
    ownedRuns.push(runDirPath); writeFileSync(runRecordPath(runDirPath, 'task_brief.md'), brief);
    const adapter: Adapter = { sessionKind: 'local', run: async (_prompt, _role, opts) => execWithStdin(process.execPath,
      ['-e', "require('node:fs').writeFileSync('seed','tampered'); console.log('written')"], '',
      { cwd: checkout, timeout_ms: opts.timeout_ms, execution: opts }) };
    await runScopeSafeStageGroup([stage], checkout, runId, 1, (s, settlementBoundary) => runStage(adapter, {
      stageId: s.id, role: { name: 'coder', description: '', prompt: '', tools: [], model: 'test', reasoning_effort: 'low' },
      dependsOn: [], promptTemplate: '', projectDir: checkout, runId, runDir: runDirPath,
      retries: 0, timeout_ms: 60_000, artifactContract: fixtureArtifactContract(s.id), settlementBoundary,
    }));
    const attempt = readStageStatus(checkout, runId, 'author').attempts?.[0];
    expect(attempt).toMatchObject({ processExitCode: 0, exitCode: 1, writeGrantApplied: { linkedFileCount: 0 } });
    const audit = JSON.parse(readFileSync(runRecordPath(runDirPath, 'stages/author/constraint_audit_attempt_1.json'), 'utf8'));
    expect(audit.violations).toEqual([expect.objectContaining({ path: 'seed', kind: 'immutable_evidence_violation' })]);
    expect(readStageStatus(checkout, runId, 'author').status).toBe('failed');
    expect(readFileSync(join(checkout, 'seed'), 'utf8')).toBe('frozen baseline');
  });
});

it.skipIf(capability.kind === 'landlock')('retains the explicit unavailable-kernel mode without a setup-only veto', () => {
  expect(capability).toMatchObject({ kind: 'unavailable', reason: expect.any(String) });
  expect(() => assertWriteGrantReady(checkout, runsRoot())).not.toThrow();
  expect(readdirSync(runsRoot())).toEqual([]);
});
