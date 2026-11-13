import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GitStandIn, success } from './test-support/git-stand-in.js';

const transport = vi.hoisted(() => ({ current: undefined as unknown as GitStandIn }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const isGit = (file: string) => file === 'git' || file === 'fact-stand-in';
  return { ...actual,
    spawnSync: (file: string, args: string[], options: object) => isGit(file)
      ? transport.current.sync(args, options) : actual.spawnSync(file, args, options),
    execFileSync: (file: string, args: string[], options: object) => isGit(file)
      ? transport.current.exec(args, options) : actual.execFileSync(file, args, options),
    spawn: (file: string, args: string[], options: object) => isGit(file)
      ? transport.current.spawn(args, options) : actual.spawn(file, args, options),
  };
});
// Select the stand-in through the owner's one typed executable parameter.
// Every caller below still executes the real acquisition/classification code.
vi.mock('../src/git-facts.js', async original => {
  const actual = await original<typeof import('../src/git-facts.js')>();
  const program = { file: 'fact-stand-in', prefixArgs: [] };
  return { ...actual,
    gitSync: (args: string[], options: never) => actual.gitSync(args, options, program),
    gitResultSync: (args: string[], options: never) => actual.gitResultSync(args, options, program),
    runGit: (args: string[], options: never) => actual.runGit(args, options, program),
    gitAsync: (args: string[], options: never) => actual.gitAsync(args, options, program),
  };
});

import { GitNotAnswered, gitSync, gitResultSync, gitAsync, runGit } from '../src/git-facts.js';
import { changedPaths, decisionInput, reviewFacts } from '../src/decision-context.js';
import { captureProjectTree, evidenceContext, projectCommit } from '../src/evidence-ledger.js';
import { ignoredProjectPaths } from '../src/project-identity.js';
import { campaignBaseDirectory } from '../src/config.js';
import { createGitWorktree, cmdShipSetupWithDeps, runShipSetup } from '../src/cli-ship-setup.js';
import { cmdShipPreflightWithDeps, collectShipPreflight } from '../src/cli-ship-preflight.js';
import { cmdLandWithDeps, runLand } from '../src/cli-land.js';
import { NodeGit, Orchestrator } from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import { writeTaskBrief } from '../src/brief-writer.js';
import { fcGlobalDir, initializeReservedRun, readRunState, reserveRun, setFcGlobalDir, updateRunState, writeRunState, type StoreState } from '../src/store.js';
import { renderRunSummary } from '../src/run-summary.js';
import { runRecordPath } from '../src/run-layout.js';
import { listProjectFiles, listProjectFilesAt } from '../src/scheduler/sched_scope/path-capabilities.js';
import { baselineImage, closeRollbackBaseline, ensureRollbackBaseline, type RunRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { gitObjectIdForPath, readRepairFileImage, type GitIndexEntry } from '../src/scheduler/sched_scope/file-images.js';
import { restoreProjectPath } from '../src/scheduler/sched_scope/restore.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { recordThrownStageAttempt } from '../src/scheduler/sched_scope/stage-group.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';

const oid = createHash('sha1').update('blob 7\0content').digest('hex');
const pastEveryOldBound = 10 ** 10;
let root: string, project: string, directory: string, previous: string, driver: GitStandIn, state: StoreState;
const role = { name: 'fixture', description: '', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'fixture' };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'git-facts-'));
  project = join(root, 'project'); directory = join(root, 'records');
  mkdirSync(project); mkdirSync(directory);
  writeFileSync(join(project, 'file.txt'), 'content');
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  driver = transport.current = new GitStandIn(); driver.writeDescriptor = (fd, bytes) => { writeSync(fd, bytes); };
  driver.answer = (args, options) => {
    if (args.includes('rev-parse')) return success(args.includes('--show-toplevel') ? project
      : args.includes('--git-common-dir') ? join(root, 'repository', '.git') : oid);
    if (args[0] === 'config') return { status: 1 };
    if (args[0] === 'hash-object') return success(oid);
    if (args[0] === 'cat-file') return success('content');
    if (args[0] === 'check-ignore') return success('ignored.txt\0');
    if (args[0] === 'check-attr') return success(Buffer.from(String(options.input).split('\0').filter(Boolean)
      .flatMap(path => args.slice(3).map(attribute => `${path}\0${attribute}\0unspecified\0`)).join('')));
    if (args[0] === 'ls-files') {
      if (args.includes('-s')) return success(`100644 ${oid} 0\tfile.txt\0`);
      if (args.includes('-v')) return success('H file.txt\0');
      return success(args.includes('--others') && !args.includes('--cached') ? '' : 'file.txt\0');
    }
    if (args[0] === 'diff') return success(args.includes('--name-only') ? '' : args.includes('--numstat') ? '1\t0\tfile.txt\n' : 'patch\n');
    if (args[0] === 'log') return success(args.includes('--format=%H%x09%s') ? `${oid}\tchange\n` : `${oid} change\n`);
    if (args[0] === 'ls-tree') return success('file.txt\0');
    return success();
  };
  state = { runId: 'fixture', projectDir: project, workflowName: 'planner', status: 'running',
    startedAt: '2000-01-01T00:00:00Z', baseCommit: oid, stages: {}, taskDescription: 'fixture' };
  writeFileSync(join(directory, 'validation_baseline.json'), JSON.stringify({ baseCommit: oid }));
});
afterEach(() => {
  closeRollbackBaseline(project); setFcGlobalDir(previous);
  vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});

function heldSync<T>(operation: () => T): T {
  driver.held = true;
  let completed = false, holds = 0;
  driver.onHold = release => {
    holds++;
    vi.advanceTimersByTime(pastEveryOldBound);
    expect(completed).toBe(false);
    release();
  };
  const value = operation(); completed = true;
  expect(holds).toBeGreaterThan(0);
  driver.held = false;
  return value;
}

async function heldAsync<T>(operation: () => Promise<T>): Promise<T> {
  driver.held = true;
  let settled = false, holds = 0;
  const result = operation().finally(() => { settled = true; });
  // The stand-in owns explicit releases. Only microtasks run between them;
  // no OS clock or polling interval can decide the result.
  for (let turns = 0; !settled && turns < 1000; turns++) {
    await Promise.resolve();
    if (driver.pending.length) {
      const release = driver.pending.shift()!; holds++;
      vi.advanceTimersByTime(pastEveryOldBound);
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
    }
  }
  expect(settled).toBe(true); expect(holds).toBeGreaterThan(0);
  driver.held = false;
  return result;
}

function terminateAt(match: (args: string[]) => boolean): void {
  const answer = driver.answer;
  driver.answer = (args, options) => match(args) ? { status: null, signal: 'SIGTERM' } : answer(args, options);
}

describe('one Git owner distinguishes answers from external termination', () => {
  it.each([0, 1, 128])('waits for exit %i with empty output beyond every former bound', status => {
    driver.answer = () => ({ status });
    const immediate = gitResultSync([], { encoding: 'utf8' });
    expect(heldSync(() => gitResultSync([], { encoding: 'utf8' }))).toEqual(immediate);
    expect(immediate).toMatchObject({ status, stdout: '', signal: null });
  });
  it('throws the same type for sync and async children with no exit status', async () => {
    driver.answer = () => ({ status: null, signal: 'SIGTERM' });
    expect(() => gitSync([], { encoding: 'utf8' })).toThrow(GitNotAnswered);
    expect(() => gitResultSync([])).toThrow(GitNotAnswered);
    await expect(runGit([], {})).rejects.toBeInstanceOf(GitNotAnswered);
  });
  it('retains a real UTF-8 answer split across native output chunks', async () => {
    vi.spyOn(driver, 'spawn').mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      const bytes = Buffer.from('文');
      queueMicrotask(() => {
        child.stdout.emit('data', bytes.subarray(0, 1)); child.stdout.emit('data', bytes.subarray(1));
        child.emit('close', 0, null);
      });
      return child;
    });
    expect(await gitAsync([], {})).toBe('文');
  });
});

describe('synchronous Git consumers preserve immediate and held answers', () => {
  const consumers: Array<[string, () => unknown]> = [
    ['review changed paths', () => changedPaths(project, state)],
    ['review routing', () => decisionInput({ id: 'assess', decision: { kind: 'post_author', successors: ['review', 'full'] } } as never, project, directory, state)],
    ['review no-index diff', () => reviewFacts(project, directory, state, Infinity)],
    ['evidence diff and inventory', () => evidenceContext(project, directory)],
    ['evidence baseline commit', () => projectCommit(project)],
    ['ignored-path set', () => [...ignoredProjectPaths(project, ['ignored.txt', 'file.txt'])]],
    ['project inventory', () => listProjectFiles(project)],
    ['tree inventory', () => captureProjectTree(project)],
    ['campaign identity', () => campaignBaseDirectory(project)],
    ['run summary', () => renderRunSummary(project, directory, state)],
    ['staged-hash verification', () => gitObjectIdForPath(project, join(project, 'file.txt'))],
  ];
  it.each(consumers)('%s waits in place and preserves its answer', (_name, operation) => {
    // Make the historical fallback observably different from a valid fact.
    if (_name === 'project inventory' || _name === 'tree inventory') writeFileSync(join(project, 'ignored.txt'), 'ignored');
    if (_name === 'review changed paths') {
      const answer = driver.answer;
      driver.answer = (args, options) => args[0] === 'diff' && args.includes('--name-only') ? success('file.txt\0') : answer(args, options);
    }
    // Exercise added-file diffs as well as tracked diffs in both review paths.
    if (_name.includes('diff') || _name.includes('routing')) {
      const answer = driver.answer;
      driver.answer = (args, options) => args[0] === 'ls-files' && args.includes('--others')
        ? success('file.txt\0') : args.includes('--no-index') ? { status: 1, stdout: 'added patch\n' } : answer(args, options);
    }
    const immediate = operation();
    expect(heldSync(operation)).toEqual(immediate);
  });
  it.each(consumers)('%s propagates termination instead of its old fallback', (_name, operation) => {
    terminateAt(() => true);
    expect(operation).toThrow(GitNotAnswered);
    expect(existsSync(join(directory, 'stage_evidence'))).toBe(false);
  });

  it.each(consumers)('%s keeps empty answers separate from real nonzero answers', (name, operation) => {
    driver.answer = () => success();
    const empty = operation();
    driver.answer = () => ({ status: 128 });
    const error = operation();
    if (name === 'review changed paths' || name === 'ignored-path set') {
      expect(empty).toEqual([]); expect(error).toEqual([]);
    } else if (name === 'evidence baseline commit') {
      expect(empty).toBe(''); expect(error).toBeUndefined();
    } else if (name === 'staged-hash verification') {
      expect(empty).toBe(''); expect(error).toBeUndefined();
    } else if (name === 'campaign identity') {
      expect(empty).toBe(project); expect(error).toBe(project);
    } else if (name === 'project inventory') {
      expect(empty).toEqual([]); expect(error).toEqual(['file.txt']);
    } else if (name === 'tree inventory') {
      expect(empty).toMatchObject({ files: [] }); expect(error).toMatchObject({ files: [expect.objectContaining({ path: 'file.txt' })] });
    } else if (name === 'review routing') {
      expect(empty).not.toHaveProperty('adapter'); expect(error).toHaveProperty('adapter');
    } else if (name === 'review no-index diff') {
      expect(empty).toHaveProperty('diff', ''); expect(error).toHaveProperty('unavailable', true);
    } else if (name === 'evidence diff and inventory') {
      expect(empty).not.toContain('Git patch unavailable'); expect(error).toContain('Git patch unavailable');
    } else if (name === 'run summary') {
      expect(empty).toContain('No file changes'); expect(error).toContain('Git measurement unavailable');
    }
  });

  it.each(['paths', 'untracked', 'patch', 'added'] as const)('review routing propagates termination of the %s read', target => {
    const answer = driver.answer;
    driver.answer = (args, options) => args[0] === 'ls-files' && args.includes('--others')
      ? success('file.txt\0') : args.includes('--no-index') ? { status: 1, stdout: 'added patch\n' } : answer(args, options);
    terminateAt(args => target === 'paths' ? args[0] === 'diff' && args.includes('--name-only')
      : target === 'untracked' ? args[0] === 'ls-files' && args.includes('--others') && !args.includes('--cached')
        : target === 'added' ? args.includes('--no-index') : args[0] === 'diff' && args.includes('--no-textconv') && !args.includes('--no-index'));
    expect(() => decisionInput({ id: 'assess', decision: { kind: 'post_author', successors: ['review', 'full'] } } as never,
      project, directory, state)).toThrow(GitNotAnswered);
  });
  it.each(['patch', 'untracked', 'added'] as const)('evidence publishes no substitute patch after terminated %s', target => {
    const answer = driver.answer;
    driver.answer = (args, options) => args[0] === 'ls-files' && args.includes('--others') && !args.includes('--cached')
      ? success('file.txt\0') : args.includes('--no-index') ? { status: 1, stdout: 'added patch\n' } : answer(args, options);
    terminateAt(args => target === 'untracked' ? args[0] === 'ls-files' && args.includes('--others') && !args.includes('--cached')
      : target === 'added' ? args.includes('--no-index') : args[0] === 'diff' && args.includes('--binary') && !args.includes('--no-index'));
    expect(() => evidenceContext(project, directory)).toThrow(GitNotAnswered);
    expect(existsSync(join(directory, 'stage_evidence'))).toBe(false);
  });
  it.each(['status', 'log'])('summary propagates a terminated %s after the initial diff succeeds', command => {
    terminateAt(args => args[0] === command);
    expect(() => renderRunSummary(project, directory, state)).toThrow(GitNotAnswered);
  });

  it('captures the store baseline synchronously and never publishes an absent baseline on termination', () => {
    const fast = reserveRun(project);
    initializeReservedRun(project, fast.runId, 'fixture', '', []);
    const immediateCommit = readRunState(project, fast.runId).baseCommit;
    const reserved = reserveRun(project);
    let interleaved = false; queueMicrotask(() => { interleaved = true; });
    const initialized = heldSync(() => initializeReservedRun(project, reserved.runId, 'fixture', '', []));
    expect(initialized).not.toBeInstanceOf(Promise); expect(interleaved).toBe(false);
    expect(readRunState(project, initialized.runId).baseCommit).toBe(immediateCommit);
    expect(immediateCommit).toBe(oid);
    const another = reserveRun(project);
    terminateAt(args => args[0] === 'rev-parse');
    expect(() => initializeReservedRun(project, another.runId, 'fixture', '', [])).toThrow(GitNotAnswered);
    expect(existsSync(runRecordPath(another.runDirPath, 'run.json'))).toBe(false);
  });

  it('keeps terminal store publication synchronous and leaves the previous verdict when summary Git is terminated', () => {
    const reserved = reserveRun(project);
    const created = initializeReservedRun(project, reserved.runId, 'fixture', '', []);
    const before = readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8');
    terminateAt(args => args[0] === 'diff');
    expect(() => updateRunState(project, created.runId, current => { current.status = 'complete'; })).toThrow(GitNotAnswered);
    expect(readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8')).toBe(before);
    expect(existsSync(runRecordPath(created.runDirPath, 'summary.md'))).toBe(false);
    driver.answer = () => success();
    const terminal = readRunState(project, created.runId); terminal.status = 'complete';
    expect(heldSync(() => writeRunState(project, created.runId, terminal))).toBeUndefined();
    expect(readRunState(project, created.runId).status).toBe('complete');
  });
});

describe('rollback Git facts', () => {
  it('waits for every baseline probe and config read without changing the preimage strategy', () => {
    const immediate = ensureRollbackBaseline(project).baseline;
    const expected = { initialization: immediate.initialization, clean: [...immediate.cleanTracked], lazy: [...immediate.lazyGitTracked.keys()] };
    closeRollbackBaseline(project);
    const held = heldSync(() => ensureRollbackBaseline(project).baseline);
    expect({ initialization: held.initialization, clean: [...held.cleanTracked], lazy: [...held.lazyGitTracked.keys()] }).toEqual(expected);
  });
  it.each(['rev-parse', 'ls-files', 'diff', 'core.autocrlf', 'core.eol', 'check-attr'])('propagates terminated %s without a filesystem/config fallback', target => {
    terminateAt(args => args[0] === target || args.includes(target));
    expect(() => ensureRollbackBaseline(project)).toThrow(GitNotAnswered);
  });
  it('keeps the filesystem strategy for a real non-repository Git error', () => {
    driver.answer = () => ({ status: 128 });
    const baseline = ensureRollbackBaseline(project).baseline;
    expect(baseline.initialization.strategy).toBe('filesystem-images');
    expect(baseline.images.get('file.txt')?.sha256).toBeDefined();
  });
  function materializationBaseline(): RunRollbackBaseline {
    const baseline = ensureRollbackBaseline(project).baseline;
    baseline.lazyGitTracked.clear();
    return baseline;
  }
  it('materializes held blob bytes identically and caches no unavailable preimage on termination', () => {
    const baseline = materializationBaseline();
    const immediate = baselineImage(baseline, 'file.txt'); baseline.images.delete('file.txt');
    expect(heldSync(() => baselineImage(baseline, 'file.txt'))).toEqual(immediate);
    baseline.images.delete('file.txt'); terminateAt(args => args[0] === 'cat-file');
    expect(() => baselineImage(baseline, 'file.txt')).toThrow(GitNotAnswered);
    expect(baseline.images.has('file.txt')).toBe(false);
  });
  it('inspects held initialized submodule HEAD and status without an inspection failure', () => {
    mkdirSync(join(project, 'module')); writeFileSync(join(project, 'module', 'member'), 'nested');
    const entry: GitIndexEntry = { path: 'module', objectId: oid, mode: '160000', stage: 0, kind: 'gitlink' };
    const operation = () => readRepairFileImage(project, 'module', [entry]);
    const immediate = operation(); expect(immediate.inspectionFailure).toBeUndefined();
    expect(heldSync(operation)).toEqual(immediate);
    terminateAt(args => args.includes('rev-parse')); expect(operation).toThrow(GitNotAnswered);
    driver.answer = args => args.includes('status') ? { status: null, signal: 'SIGKILL' } : success(oid);
    expect(operation).toThrow(GitNotAnswered);
  });
  it.each(['cat-file', 'hash-object'])('restores held blobs but preserves the target on terminated %s before replacement', command => {
    const before = { exists: true, type: 'file' as const, gitObjectId: oid };
    const operation = () => restoreProjectPath(project, 'file.txt', before, join(root, 'retained'));
    writeFileSync(join(project, 'file.txt'), 'operator');
    expect(operation()).toEqual({ restored: true });
    writeFileSync(join(project, 'file.txt'), 'operator');
    expect(heldSync(operation)).toEqual({ restored: true });
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('content');
    writeFileSync(join(project, 'file.txt'), 'operator'); terminateAt(args => args[0] === command);
    expect(operation).toThrow(GitNotAnswered);
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('operator');
    expect(readdirSync(project)).toEqual(['file.txt']);
  });
  it('does not report a restoration when the final post-rename hash is terminated', () => {
    const answer = driver.answer; let hashes = 0;
    driver.answer = (args, options) => args[0] === 'hash-object' && ++hashes === 2
      ? { status: null, signal: 'SIGTERM' } : answer(args, options);
    expect(() => restoreProjectPath(project, 'file.txt', { exists: true, type: 'file', gitObjectId: oid })).toThrow(GitNotAnswered);
    expect(hashes).toBe(2);
  });
  it('does not turn termination into a write-settlement audit or thrown-stage verdict', () => {
    const baseline = ensureRollbackBaseline(project).baseline;
    terminateAt(args => args[0] === 'check-ignore');
    const snapshot = { files: new Map(), rollbackBaseline: baseline, declaredScopes: {} };
    expect(() => settleProjectWrites({ projectDir: project, snapshot: snapshot as never,
      rawWrites: ['file.txt'], definiteWrites: new Set(['file.txt']) })).toThrow(GitNotAnswered);
    const missing = new GitNotAnswered('SIGTERM');
    expect(() => recordThrownStageAttempt(project, 'fixture', 'author', 0, missing)).toThrow(missing);
    expect(existsSync(join(fcGlobalDir(), 'runs', 'fixture'))).toBe(false);
  });
  it('does not hide termination while enumerating a followed directory alias', () => {
    // Root directory enumeration takes the same propagation path after stat.
    terminateAt(() => true);
    expect(() => listProjectFilesAt(project, '.')).not.toThrow();
    mkdirSync(join(project, 'nested'));
    expect(() => listProjectFilesAt(project, 'nested')).toThrow(GitNotAnswered);
  });
});

describe('async consumers retain their public shapes and non-answer boundaries', () => {
  const silent = { write: (_text: string) => true };
  const preflight = () => collectShipPreflight(['--project', project], {
    projectDir: project, packageRoot: root, readCampaignEntries: () => [],
    probeDaemon: async () => ({ state: 'unavailable', reason: 'fixture' }),
  });
  it('preflight campaign identity waits for Git and propagates termination through the command boundary', async () => {
    const immediate = await preflight();
    const held = heldSync(preflight); // synchronous fact read occurs before this async function yields
    expect((await held).report.campaign).toEqual(immediate.report.campaign);
    terminateAt(args => args.includes('--git-common-dir'));
    await expect(preflight()).rejects.toBeInstanceOf(GitNotAnswered);
    await expect(cmdShipPreflightWithDeps(['--project', project], { projectDir: project, packageRoot: root,
      stdout: silent, stderr: silent })).rejects.toBeInstanceOf(GitNotAnswered);
  });

  it('worktree setup waits beyond its old checkout bound and propagates termination', async () => {
    const request = { projectDir: project, targetDir: join(root, 'target'), base: 'HEAD', branch: 'trial' };
    const immediate = await createGitWorktree(request);
    expect(await heldAsync(async () => createGitWorktree(request))).toEqual(immediate);
    terminateAt(() => true);
    await expect(createGitWorktree(request)).rejects.toBeInstanceOf(GitNotAnswered);
  });
  it('createGitWorktree preserves both synchronous and Promise dependency returns', async () => {
    const request = { projectDir: project, targetDir: join(root, 'target'), base: 'HEAD', branch: 'trial' };
    const response = { exitCode: 0, stdout: 'created' };
    expect(createGitWorktree(request, () => response)).toBe(response);
    const promised = Promise.resolve(response);
    expect(createGitWorktree(request, () => promised)).toBe(promised);
    await promised;
  });

  function setupArgs() {
    writeFileSync(join(project, 'brief.md'), '# Goal\nFixture.');
    return ['--project', project, '--target', join(root, 'target'), '--brief', join(project, 'brief.md'), '--base', 'HEAD', '--branch', 'trial'];
  }
  it('setup never records a refusal or cleans invocation-owned resources after a terminated Git command', async () => {
    const args = setupArgs(); terminateAt(values => values[0] === 'worktree' && values[1] === 'add');
    const mutations: string[] = [];
    const answer = driver.answer;
    driver.answer = (values, options) => { mutations.push(values.join(' ')); return answer(values, options); };
    await expect(cmdShipSetupWithDeps(args, { stdout: silent, stderr: silent })).rejects.toBeInstanceOf(GitNotAnswered);
    expect(mutations.some(value => value.includes('worktree remove') || value.includes('update-ref -d'))).toBe(false);
    expect(existsSync(join(root, 'target'))).toBe(true);
    expect(existsSync(join(fcGlobalDir(), 'ship-setup'))).toBe(false);
  });
  it('setup preserves real nonzero worktree failure handling', async () => {
    const args = setupArgs();
    driver.answer = () => ({ status: 128 });
    expect((await runShipSetup(args)).state).toBe('refused');
  });
  it('setup reaches the same ready outcome after all of its Git children are held and released', async () => {
    const args = setupArgs(), target = join(root, 'target');
    const answer = driver.answer;
    driver.answer = (values, options) => {
      if (values[0] === 'worktree' && values[1] === 'add') mkdirSync(target, { recursive: true });
      return answer(values, options);
    };
    const outcome = (report: Awaited<ReturnType<typeof runShipSetup>>) => ({
      state: report.state, ready: report.ready, branch: report.branch, base: report.base,
      created: report.worktreeCreated, inputs: report.targetVerification, blockers: report.blockers,
    });
    const immediate = await runShipSetup(args, { stdout: silent, stderr: silent }); expect(immediate.state).toBe('ready');
    rmSync(target, { recursive: true, force: true });
    expect(outcome(await heldAsync(() => runShipSetup(args, { stdout: silent, stderr: silent })))).toEqual(outcome(immediate));
  });
  it.each(['base', 'branch', 'residue', 'source input', 'reuse inventory', 'reuse base'] as const)('setup propagates terminated %s before recording a refusal', async target => {
    const args = setupArgs(), targetDir = join(root, 'target');
    if (target === 'source input') writeFileSync(join(project, 'brief.md'), '---\ninputs: [{path: missing.txt}]\n---\n# Goal\nFixture.');
    if (target.startsWith('reuse')) mkdirSync(targetDir);
    const answer = driver.answer;
    driver.answer = (values, options) => values[0] === 'worktree' && values[1] === 'list'
      ? success(`worktree ${targetDir}\nHEAD ${oid}\nbranch refs/heads/trial\n\n`)
      : target === 'residue' && values[0] === 'worktree' && values[1] === 'add' ? { status: 128 } : answer(values, options);
    terminateAt(values => target === 'source input' ? values[0] === 'cat-file'
      : target === 'base' || target === 'reuse base' ? values[0] === 'rev-parse'
        : target === 'branch' ? values[0] === 'update-ref'
          : values[0] === 'worktree' && values[1] === 'list');
    await expect(cmdShipSetupWithDeps(args, { stdout: silent, stderr: silent })).rejects.toBeInstanceOf(GitNotAnswered);
    expect(driver.calls.some(values => values[0] === 'update-ref' && values[1] === '-d')).toBe(false);
    expect(existsSync(join(fcGlobalDir(), 'ship-setup'))).toBe(false);
  });

  function landArgs() {
    const run = join(fcGlobalDir(), 'runs', 'legacy'); mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'run.json'), JSON.stringify({ ...state, runId: 'legacy', status: 'complete' }));
    return ['--run', 'legacy', '--json'];
  }
  it('landing inspection preserves held answers and never substitutes an inspection issue for termination', async () => {
    const args = landArgs();
    const immediate = await runLand(args);
    expect(await heldAsync(() => runLand(args))).toEqual(immediate);
    terminateAt(values => values[0] === 'status');
    await expect(runLand(args)).rejects.toBeInstanceOf(GitNotAnswered);
    await expect(cmdLandWithDeps(args, { stdout: silent, stderr: silent })).rejects.toBeInstanceOf(GitNotAnswered);
    expect(driver.calls.some(values => values.includes('remove') || values.includes('prune'))).toBe(false);
  });
  function removableLand() {
    const args = [...landArgs(), '--remove', '--acknowledge-regenerable=0'];
    const primary = join(root, 'primary'); mkdirSync(primary);
    driver.answer = values => {
      if (values[0] === 'symbolic-ref') return success('trial');
      if (values[0] === 'rev-parse') return success(project);
      if (values[0] === 'worktree' && values[1] === 'list') return success(
        `worktree ${primary}\nHEAD ${oid}\nbranch refs/heads/main\n\nworktree ${project}\nHEAD ${oid}\nbranch refs/heads/trial\n\n`);
      return success();
    };
    return args;
  }
  it('landing removal has the same transaction outcome after every held Git answer', async () => {
    const args = removableLand();
    const immediate = await runLand(args); expect(immediate.state).toBe('removed');
    expect(await heldAsync(() => runLand(args))).toEqual(immediate);
  });
  it.each(['ignored', 'branch', 'unpushed', 'at risk', 'root', 'worktrees', 'remove', 'prune', 'delete'] as const)('landing propagates terminated %s without a refusal or later removal step', async target => {
    const args = removableLand();
    const match = (values: string[]) => target === 'ignored' ? values[0] === 'ls-files'
      : target === 'branch' ? values[0] === 'symbolic-ref'
        : target === 'unpushed' ? values[0] === 'rev-list' && values.includes('--remotes')
          : target === 'at risk' ? values[0] === 'rev-list' && values.includes('--all')
            : target === 'root' ? values[0] === 'rev-parse'
              : target === 'worktrees' ? values[0] === 'worktree' && values[1] === 'list'
                : target === 'delete' ? values[0] === 'branch' : values[0] === 'worktree' && values[1] === target;
    terminateAt(match);
    await expect(cmdLandWithDeps(args, { stdout: silent, stderr: silent })).rejects.toBeInstanceOf(GitNotAnswered);
    expect(match(driver.calls.at(-1)!)).toBe(true);
  });
  it.each(['prefix', 'changes', 'since'])('NodeGit %s keeps the Promise shape and propagates termination', async kind => {
    const git = new NodeGit();
    const operation = () => kind === 'prefix' ? git.findCommitByPrefix(project, 'fixture')
      : kind === 'changes' ? git.hasUncommittedChanges(project) : git.findCommitSince(project, '2000-01-01');
    const immediate = await operation();
    expect(await heldAsync(operation)).toEqual(immediate);
    terminateAt(() => true); await expect(operation()).rejects.toBeInstanceOf(GitNotAnswered);
    driver.answer = () => ({ status: 128 });
    expect(await operation()).toBe(kind === 'changes' ? false : undefined);
  });
  it('the orchestrator joins and propagates a terminated Git observation without settling or retrying the task', async () => {
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const task = registry.create({ kind: 'quick', projectDir: project, name: 'Fixture',
      status: 'running', started_at: '2000-01-01T00:00:00Z', commit_prefix: 'fixture' });
    const orchestrator = new Orchestrator({ registry, git: new NodeGit(),
      systemd: { isActive: async () => ({ kind: 'terminal', exitCode: 0 }) } as never,
      reconcileOrphanRuns: () => {}, isProjectBusy: () => null });
    terminateAt(() => true);
    await expect(orchestrator.tickOnce()).rejects.toBeInstanceOf(GitNotAnswered);
    expect(registry.get(task.id)).toEqual(task);
    await orchestrator.stop();
  });
  it('brief identity waits before buying authorship and termination creates no evidence', async () => {
    const adapter = { run: vi.fn(async () => ({ output: '', exitCode: 1, duration_ms: 0 })) };
    terminateAt(args => args[0] === 'rev-parse');
    await expect(writeTaskBrief('Do work', { projectDir: project, adapter: 'fixture', role, adapterInstance: adapter })).rejects.toBeInstanceOf(GitNotAnswered);
    expect(adapter.run).not.toHaveBeenCalled(); expect(existsSync(join(fcGlobalDir(), 'brief-writing'))).toBe(false);
    driver.answer = () => success(oid);
    const immediate = await writeTaskBrief('Do work', { projectDir: project, adapter: 'fixture', role, adapterInstance: adapter });
    const held = await heldSync(() => writeTaskBrief('Do work', { projectDir: project, adapter: 'fixture', role, adapterInstance: adapter, replay: false }));
    expect(held.outcome).toBe(immediate.outcome); expect(held.digest).toBe(immediate.digest);
  });
  it('brief input-tree validation waits for Git and does not substitute an invalid-input reason on termination', async () => {
    const fields = { criteria: ['Complete work'], inputs: ['file.txt'], constraints: [], assumptions: [], blocking_questions: [] };
    const adapter = { run: vi.fn(async () => ({ output: JSON.stringify(fields), exitCode: 0, duration_ms: 0 })) };
    const operation = () => writeTaskBrief('Do work', { projectDir: project, adapter: 'fixture', role, adapterInstance: adapter, replay: false });
    const immediate = await operation(); expect(immediate.outcome).toBe('ready');
    // Identity is read synchronously, then the stub author yields. Hold the tree
    // read at the same synchronous transport boundary after that yield.
    driver.held = true; driver.onHold = release => { vi.advanceTimersByTime(pastEveryOldBound); release(); };
    expect((await operation()).outcome).toBe('ready'); driver.held = false;
    terminateAt(args => args[0] === 'ls-tree');
    await expect(operation()).rejects.toBeInstanceOf(GitNotAnswered);
  });
  it('the scheduler preserves non-answer identity without a failed attempt, verdict, successor or run summary', async () => {
    // Scope inventory completes; the worker's evidence patch is terminated
    // before a backend invocation can begin.
    const workflow = WorkflowConfigSchema.parse({ name: 'fact-boundary', defaults: { max_iterations: 1 }, stages: [
      { id: 'author', role: 'coder', depends_on: [], scope: [],
        artifact_contract: { version: 1, produces: [], reads: [] } },
      { id: 'later', role: 'coder', depends_on: ['author'], scope: [],
        artifact_contract: { version: 1, produces: [], reads: [] } },
    ] });
    terminateAt(args => args[0] === 'diff' && args.includes('--binary'));
    const adapter = { run: vi.fn() };
    await expect(runWorkflow(workflow, '', project, adapter, new Map([['coder', role]]))).rejects.toBeInstanceOf(GitNotAnswered);
    expect(adapter.run).not.toHaveBeenCalled();
    const runs = readdirSync(join(fcGlobalDir(), 'runs'));
    expect(runs).toHaveLength(1);
    const run = join(fcGlobalDir(), 'runs', runs[0]);
    expect(readRunState(project, runs[0]).status).toBe('running');
    expect(existsSync(runRecordPath(run, 'summary.md'))).toBe(false);
    const events = readFileSync(join(run, 'events.jsonl'), 'utf8');
    expect(events).not.toMatch(/attempt_failed|stage_failed|scheduler_failed|"type":"decision"/);
  });
});
