import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execWithStdin, spawnOwnedCommand, withRunProcessOwnership, type Adapter, type ExecResult } from '../src/adapters/base.js';
import { admitWriteGrant, currentStageWriteGrant, legacyWriteGrant, prepareWriteGrant, queryWriteGrantCapability, withStageWriteGrant, WriteGrantError, type StageWriteGrant, type WriteGrantContract } from '../src/write-grant.js';
import { stageSessionHome } from '../src/adapter-session.js';
import { retireRunScratch } from '../src/invocation-scratch.js';
import { createGitWorktree } from '../src/cli-ship-setup.js';
import { runRecordPath } from '../src/run-layout.js';
import { readRunStateView } from '../src/run-state-view.js';
import { fcGlobalDir, listRuns, readRunState, readStageStatus, setFcGlobalDir, updateOperationalRunStateAtPath, updateRunState, writeRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { stateToRunDetail } from '../src/dashboard.js';
import { StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { executeOrdinaryStage } from '../src/scheduler/sched_loop/ordinary-stage.js';
import { stageRecordSchema } from '../src/handoff.js';
import { observeEnginePublications } from '../src/engine-fs.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
let contract: WriteGrantContract;
const artifacts = { version: 1 as const, produces: [], reads: [], groups: [] };
const role = { name: 'local', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Local process fixture.' };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'write-grant-')));
  project = join(root, 'project'); mkdirSync(project);
  mkdirSync(join(project, 'left')); mkdirSync(join(project, 'right'));
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  ({ runId, runDirPath: directory } = createRun(project, 'grant-fixture', 'name: grant-fixture\nstages: []\n', ['left', 'right']));
  contract = readRunState(project, runId).writeGrant!;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); retireRunScratch(directory); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

const declaration = (stageId = 'left', scope: string[] = ['left/']): StageWriteGrant => ({
  projectDir: project, runDir: directory, stageId, home: stageSessionHome(directory, stageId, 'local'), contract, artifacts,
});
const supported = (): boolean => {
  if (contract.capability.kind === 'landlock') return true;
  expect(contract.capability).toMatchObject({ kind: 'unavailable', reason: expect.any(String) });
  expect(readRunState(project, runId).writeGrant).toEqual(contract);
  return false;
};
async function launch(script: string, options: { stageId?: string; scope?: string[]; onStdout?: (text: string) => void; onChild?: (handles: { pid?: number }) => void } = {}): Promise<ExecResult> {
  const stageId = options.stageId ?? 'left';
  const agent: Adapter = { sessionKind: 'local', run: async (_prompt, _role, opts) => execWithStdin(process.execPath, ['-e', script], '', {
    cwd: opts.workDir, timeout_ms: opts.timeout_ms, execution: opts, captureStreams: true,
    onStdout: options.onStdout, onChild: options.onChild,
  }) };
  return runStage(agent, { stageId, role, dependsOn: [], promptTemplate: 'Run the local fixture.',
    projectDir: project, runId, runDir: directory, retries: 0, timeout_ms: 60_000, artifactContract: artifacts,
    scope: options.scope ?? [`${stageId}/`],
  });
}
const observe = (operation: string): string => `const fs = require('node:fs');
try { ${operation}; console.log(JSON.stringify({denied: false})); }
catch(error) { console.log(JSON.stringify({denied: true, code: error.code})); }`;
const git = (cwd: string, args: string[]): string => isolatedProjectCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], cwd, root).trim();
const release = (path: string): Promise<void> => new Promise((resolve, reject) => {
  const socket = createConnection(path, () => socket.write('go'));
  socket.on('error', reject); socket.on('end', () => { socket.end(); resolve(); });
});
/** A real granted actor, held until a socket event. Completion also rejects
 * readiness if launch fails, so tests cannot wait for an event from a dead child. */
function actor(grant: StageWriteGrant, body: string) {
  let ready!: (socket: string) => void, fail!: (error: unknown) => void;
  const readiness = new Promise<string>((resolve, reject) => { ready = resolve; fail = reject; });
  let carry = '';
  const result = withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', `
const fs=require('node:fs'), net=require('node:net'), path=require('node:path');
const socket=path.join(process.env.TMPDIR,'actor.sock');
const server=net.createServer(s=>s.on('data',()=>{let result;
try { result=(()=>{${body}})(); } catch(error) { result={error:error.code}; }
s.end(); server.close(()=>console.log(JSON.stringify({result}))); }));
server.listen(socket,()=>console.log(JSON.stringify({ready:socket})));`], '', {
    cwd: grant.projectDir, timeout_ms: 60_000, execution: { runDir: grant.runDir }, captureStreams: true,
    onStdout: text => {
      carry += text; const lines = carry.split('\n'); carry = lines.pop()!;
      for (const line of lines) { const event = JSON.parse(line); if (event.ready) ready(event.ready); }
    },
  }));
  void result.then(value => fail(new Error(`Actor exited before readiness: ${value.output}`)), fail);
  return { readiness, result };
}
async function linkedWorktree(): Promise<{ common: string; checkout: string }> {
  const primary = join(root, 'primary'); mkdirSync(primary);
  git(primary, ['init', '-b', 'base']);
  writeFileSync(join(primary, 'seed'), 'initial');
  git(primary, ['add', 'seed']); git(primary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);
  const checkout = join(root, 'checkout');
  const result = await createGitWorktree({ projectDir: primary, targetDir: checkout, branch: 'fixture', base: 'HEAD' });
  expect(result.exitCode, result.stderr).toBe(0);
  return { common: join(primary, '.git'), checkout };
}

// A stage that prints something else must fail with what it printed, not with a parse error.
const parsed = (output: string): unknown => { try { return JSON.parse(output); } catch { throw new Error(`stage output is not JSON:\n${output}`); } };

describe('stage filesystem write grant through production launch', () => {
  it.each(['plain', 'symlink', 'hardlink', 'rename-out', 'rename-in', 'truncate', 'delete', 'mkdir', 'system-temp', 'child'])(
    'denies the first %s write with an OS error', async kind => {
      if (!supported()) return;
      const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
      const inside = join(project, 'left', 'inside'); writeFileSync(inside, 'inside');
      const alias = join(project, 'left', 'alias'); symlinkSync(outside, alias);
      const systemTemporary = join('/tmp', `flowcrew-grant-${randomUUID()}`);
      const operations: Record<string, string> = {
        plain: `fs.writeFileSync(${JSON.stringify(outside)}, 'bad')`,
        symlink: `fs.writeFileSync(${JSON.stringify(alias)}, 'bad')`,
        hardlink: `fs.linkSync(${JSON.stringify(outside)}, ${JSON.stringify(join(project, 'left', 'new-link'))})`,
        'rename-out': `fs.renameSync(${JSON.stringify(inside)}, ${JSON.stringify(join(root, 'moved'))})`,
        'rename-in': `fs.renameSync(${JSON.stringify(outside)}, ${JSON.stringify(join(project, 'left', 'moved'))})`,
        truncate: `fs.truncateSync(${JSON.stringify(outside)}, 0)`,
        delete: `fs.unlinkSync(${JSON.stringify(outside)})`,
        mkdir: `fs.mkdirSync(${JSON.stringify(join(root, 'new-directory'))})`,
        'system-temp': `fs.writeFileSync(${JSON.stringify(systemTemporary)}, 'bad'); fs.unlinkSync(${JSON.stringify(systemTemporary)})`,
      };
      const script = kind === 'child'
        ? `const result = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(observe(operations.plain))}], {encoding:'utf8'}); process.stdout.write(result.stdout); process.exitCode=result.status;`
        : observe(operations[kind]);
      const result = await launch(script);
      expect(result.exitCode, result.output).toBe(0);
      expect(parsed(result.output)).toMatchObject({ denied: true, code: expect.stringMatching(/^(EACCES|EPERM|EXDEV)$/) });
      expect(result.writeGrantApplied).toEqual({ abi: contract.capability.kind === 'landlock' ? contract.capability.abi : 0, linkedFileCount: 0 });
      expect(readFileSync(outside, 'utf8')).toBe('unchanged');
      expect(readStageStatus(project, runId, 'left').attempts?.at(-1)?.writeGrantApplied).toEqual(result.writeGrantApplied);
    });

  it('inherits the grant in a detached grandchild after reparenting and reaps it by event', async () => {
    if (!supported()) return;
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    const script = `import ctypes, errno, json, os, sys
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) # subreaper: adopt and reap our own orphan
parent = os.getpid()
release_r, release_w = os.pipe()
result_r, result_w = os.pipe()
child = os.fork()
if child == 0:
    os.setsid()
    grandchild = os.fork()
    if grandchild: os._exit(0)
    os.setsid()
    os.close(release_w)
    os.close(result_r)
    os.read(release_r, 1)
    try:
        with open(sys.argv[1], 'w') as stream: stream.write('bad')
        result = dict(denied=False)
    except OSError as error:
        result = dict(denied=True, errno=error.errno)
    result.update(reparented=os.getppid() == parent, detached=os.getpgrp() == os.getpid())
    os.write(result_w, json.dumps(result).encode())
    os._exit(0)
os.close(release_r)
os.close(result_w)
os.waitpid(child, 0)
os.write(release_w, b'x')
os.close(release_w)
result = json.loads(os.read(result_r, 4096))
os.waitpid(-1, 0)
print(json.dumps(result))
`;
    const agent: Adapter = { sessionKind: 'local', run: async (_prompt, _role, opts) => execWithStdin('/usr/bin/python3', ['-I', '-S', '-B', '-c', script, outside], '', {
      cwd: project, timeout_ms: opts.timeout_ms, execution: opts,
    }) };
    const result = await runStage(agent, { stageId: 'left', role, dependsOn: [], promptTemplate: '', projectDir: project, runId,
      runDir: directory, retries: 0, timeout_ms: 60_000, artifactContract: artifacts, scope: ['left/'] });
    expect(result.exitCode, result.output).toBe(0);
    expect(parsed(result.output)).toEqual({ denied: true, errno: 13, reparented: true, detached: true });
  });

  it('keeps the agent pid and process group across exec and permits writes, sockets, spawning and a project test', async () => {
    if (!supported()) return;
    let supervisedPid: number | undefined;
    const script = `const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process'), path = require('node:path');
fs.writeFileSync('left/allowed', 'ok');
fs.writeFileSync(path.join(process.env.HOME, 'state'), 'ok');
fs.writeFileSync(path.join(process.env.TMPDIR, 'test.cjs'), "const assert=require('node:assert/strict'); assert.equal(2+2,4)");
const test = cp.spawnSync(process.execPath, ['--test', path.join(process.env.TMPDIR,'test.cjs')], {encoding:'utf8'});
if(test.status !== 0) throw new Error(test.stderr);
const sock = path.join(process.env.TMPDIR, 'allowed.sock');
const server = net.createServer(socket => socket.end('ok'));
server.listen(sock, () => { const socket=net.connect(sock); let reply=''; socket.on('data',chunk => reply+=chunk); socket.on('end', () => server.close(() => console.log(JSON.stringify({ pid:process.pid, pgid:Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[4]), testExit:test.status, socket:reply })))); });`;
    const result = await launch(script, { onChild: handles => { supervisedPid = handles.pid; } });
    expect(result.exitCode, result.output).toBe(0);
    expect(parsed(result.output)).toEqual({ pid: supervisedPid, pgid: supervisedPid, testExit: 0, socket: 'ok' });
  });



  it('commits on its own branch with narrow shared Git grants and refuses other branch, config and hook writes', async () => {
    if (!supported()) return;
    const { common, checkout } = await linkedWorktree();
    const grant = { ...declaration(), projectDir: checkout, scope: ['.'], contract: admitWriteGrant(checkout) };
    const result = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', `const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
fs.writeFileSync('change', 'ok');
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
git('add','change'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','own branch');
const denials = ${JSON.stringify([join(common, 'refs', 'heads', 'base'), join(common, 'config'), join(common, 'hooks', 'post-commit')])}.map(path => { try {fs.writeFileSync(path,'bad'); return null;} catch(error) {return error.code;} });
console.log(JSON.stringify({branch:git('symbolic-ref','--short','HEAD'), files:git('ls-tree','--name-only','HEAD').split('\\n'), denials}));`], '', { cwd: checkout, timeout_ms: 60_000 }));
    expect(result.exitCode, result.output).toBe(0);
    expect(parsed(result.output)).toMatchObject({ branch: expect.stringMatching(/^fc\/[^/]+\/left\/head$/), files: ['change', 'seed'], denials: ['EACCES', 'EACCES', 'EACCES'] });
    expect(result.writeGrantApplied?.linkedFileCount).toBe(0);
    expect(git(checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe('fixture');
  });

  it('admits an unborn repository and commits on a private stage branch without creating a primary HEAD', async () => {
    if (!supported()) return;
    git(project, ['init', '-b', 'base', '--separate-git-dir', join(root, 'unborn-git')]);
    const admitted = admitWriteGrant(project);
    expect(admitted.git?.baseCommit).toBeNull();
    const grant = { ...declaration(), contract: admitted };
    const result = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', `
const fs=require('node:fs'),cp=require('node:child_process');
fs.writeFileSync('left/first','initial');
const git=(...args)=>cp.execFileSync('git',args,{encoding:'utf8'}).trim();
git('add','left/first');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','first');
console.log(JSON.stringify({branch:git('symbolic-ref','--short','HEAD'),files:git('ls-tree','--name-only','HEAD')}));`], '', { cwd: project, timeout_ms: 60_000 }));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.writeGrantApplied?.linkedFileCount).toBe(0);
    expect(parsed(result.output)).toEqual({ branch: expect.stringMatching(/^fc\/[^/]+\/left\/head$/), files: 'left' });
    expect(() => git(project, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(git(project, ['symbolic-ref', '--short', 'HEAD'])).toBe('base');
  });

  it('keeps ref deletion private across invocations and disables automatic shared-object maintenance', async () => {
    if (!supported()) return;
    const { common, checkout } = await linkedWorktree();
    const grant = { ...declaration(), projectDir: checkout, scope: ['.'], contract: admitWriteGrant(checkout) };
    const invoke = (operation: string) => withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', `
const cp=require('node:child_process'),fs=require('node:fs');
const git=(...args)=>cp.execFileSync('git',args,{encoding:'utf8'}).trim();
const disposable=git('symbolic-ref','--short','HEAD').replace(/head$/,'disposable');
${operation}
let denied;try{fs.writeFileSync(${JSON.stringify(join(common, 'packed-refs.lock'))},'bad');}catch(error){denied=error.code;}
console.log(JSON.stringify({maintenance:git('config','--bool','maintenance.auto'),refs:git('for-each-ref','--format=%(refname)'),denied}));
`], '', { cwd: checkout, timeout_ms: 60_000 }));
    const first = await invoke("git('branch',disposable,'HEAD');");
    expect(first.exitCode, first.output).toBe(0);
    expect(parsed(first.output)).toMatchObject({ maintenance: 'false', refs: expect.stringContaining('/left/disposable'), denied: 'EACCES' });
    // Even deleting an absent AUTO_MERGE takes packed-refs.lock on newer Git.
    // A real branch deletion exercises that lock on older Git as well.
    const second = await invoke("git('update-ref','-d','AUTO_MERGE');git('branch','-D',disposable);");
    expect(second.exitCode, second.output).toBe(0);
    expect(parsed(second.output)).toEqual({ maintenance: 'false', refs: expect.stringMatching(/^refs\/heads\/fc\/[^/]+\/left\/head$/), denied: 'EACCES' });
    expect(git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/heads/fc'])).toBe('');
    expect(git(checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe('fixture');
  });

  it.each(['git', 'cache', 'output'] as const)('prevents live cross-stage hard links and renames through shared %s directories', async kind => {
    if (!supported()) return;
    let shared: string;
    if (kind === 'git') {
      const { common, checkout } = await linkedWorktree(); project = checkout;
      mkdirSync(join(project, 'left')); mkdirSync(join(project, 'right'));
      contract = admitWriteGrant(project); shared = join(common, 'objects');
    } else {
      shared = join(root, 'shared-cache'); mkdirSync(shared);
      if (kind === 'cache') contract = { ...contract, sharedCaches: [shared] };
    }
    const sharedGrant = (id: string) => ({ ...declaration(id, [id + '/']),
      ...(kind === 'output' ? { externalDirectories: [shared] } : {}) });
    const victim = join(project, 'left', 'victim'); writeFileSync(victim, 'unchanged');
    const alias = join(shared, 'alias');
    // Right is live before left tries to contaminate a shared root. Both
    // preflight counts are zero, so the denial must be lifetime enforcement.
    const right = actor(sharedGrant('right'), `
let direct, through; try { fs.writeFileSync(${JSON.stringify(victim)},'bad'); direct='SUCCEEDED'; } catch(e) { direct=e.code; }
try { fs.writeFileSync(${JSON.stringify(alias)},'bad'); through='SUCCEEDED'; } catch(e) { through=e.code; }
return {direct, through};`);
    const left = actor(sharedGrant('left'), `
const codes={};
for(const [name,operation] of [
 ['link',()=>fs.linkSync('left/victim',${JSON.stringify(alias)})],
 ['rename-out',()=>fs.renameSync('left/victim',${JSON.stringify(join(shared, 'moved'))})],
 ['link-in',()=>fs.linkSync(${JSON.stringify(join(shared, 'source'))},'left/alias')],
 ['rename-in',()=>fs.renameSync(${JSON.stringify(join(shared, 'source'))},'left/moved')]
]) { try { operation(); codes[name]='SUCCEEDED'; } catch(e) { codes[name]=e.code; } }
// Ordinary cross-directory moves within the private scope remain permitted.
fs.mkdirSync('left/a');fs.mkdirSync('left/b');fs.writeFileSync('left/a/own','ok');fs.renameSync('left/a/own','left/b/own');
return codes;`);
    writeFileSync(join(shared, 'source'), 'shared');
    try {
      const [rightSocket, leftSocket] = await Promise.all([right.readiness, left.readiness]);
      await release(leftSocket); const first = await left.result;
      await release(rightSocket); const second = await right.result;
      for (const result of [first, second]) {
        expect(result.exitCode, result.output).toBe(0);
        expect(result.writeGrantApplied?.linkedFileCount).toBe(0);
      }
      expect(JSON.parse(first.output.trim().split('\n').at(-1)!).result).toEqual({ link: 'EXDEV', 'rename-out': 'EXDEV', 'link-in': 'EXDEV', 'rename-in': 'EXDEV' });
      expect(JSON.parse(second.output.trim().split('\n').at(-1)!).result).toEqual({ direct: 'SUCCEEDED', through: 'SUCCEEDED' });
      // The peer is authorized to create shared/alias; it must be a fresh file,
      // never an alias of the victim, whose content remains unchanged.
      expect(readFileSync(victim, 'utf8')).toBe('bad');
    } finally { await Promise.allSettled([left.result, right.result]); }
  });

  it.each(['directory', 'file'] as const)('refuses overlapping shared-cache and private %s grants instead of restoring REFER', async kind => {
    if (!supported()) return;
    const cache = join(project, 'left', 'cache'); mkdirSync(cache);
    const scope = kind === 'file' ? ['left/cache/exact'] : ['left/'];
    if (kind === 'file') writeFileSync(join(cache, 'exact'), 'old');
    const result = await withStageWriteGrant({ ...declaration('left', scope), contract: { ...contract, sharedCaches: [cache] } },
      () => execWithStdin(process.execPath, ['-e', 'process.exit(0)'], '', { cwd: project, timeout_ms: 60_000 }));
    expect(result.exitCode).toBe(125);
    expect(result.writeGrantFailure).toEqual({ kind: 'unsafe_path', path: cache });
  });

  it('applies the same grant at the owned supervisor path and binds the supervised agent identity', async () => {
    if (!supported()) return;
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    updateRunState(project, runId, state => { state.engineCheckpoint = { pid: process.pid, at: new Date().toISOString(), processes: [] } as typeof state.engineCheckpoint; });
    const launched = await withRunProcessOwnership(project, runId, () => withStageWriteGrant(declaration(), async () => {
      const owned = spawnOwnedCommand(process.execPath, ['-e', `const fs=require('node:fs'); let code; try {fs.writeFileSync(${JSON.stringify(outside)},'bad');} catch(error) {code=error.code;} console.log(JSON.stringify({code,pid:process.pid,pgid:Number(fs.readFileSync('/proc/self/stat','utf8').split(' ')[4])}));`], { cwd: project });
      let output = ''; owned.child.stdout!.on('data', chunk => { output += chunk; });
      const exitCode = await new Promise<number | null>((resolve, reject) => { owned.child.once('error', reject); owned.child.once('close', resolve); });
      await owned.stop();
      return { exitCode, output, applied: owned.writeGrantApplied() };
    }));
    expect(launched.exitCode, launched.output).toBe(0);
    const observed = JSON.parse(launched.output);
    expect(observed).toMatchObject({ code: 'EACCES', pgid: observed.pid });
    expect(launched.applied?.linkedFileCount).toBe(0);
    expect(readRunState(project, runId).engineCheckpoint?.processes).toHaveLength(2);
    expect(readRunState(project, runId).engineCheckpoint?.processes?.[0].pid).toBe(observed.pid);
  });

  it('refuses hard-linked dependency files and home files before the agent starts, with the complete count', async () => {
    if (!supported()) return;
    const store = join(root, 'store-file'); writeFileSync(store, 'shared');
    mkdirSync(join(project, 'node_modules'));
    linkSync(store, join(project, 'node_modules', 'dependency'));
    const home = declaration().home; mkdirSync(home, { recursive: true }); linkSync(store, join(home, 'linked'));
    const result = await launch(`require('node:fs').writeFileSync('left/started','bad')`, { scope: ['.'] });
    expect(result.exitCode).toBe(125);
    expect(result.writeGrantFailure).toEqual({ kind: 'linked_files', count: 2 });
    expect(readStageStatus(project, runId, 'left').attempts?.at(-1)?.writeGrantFailure).toEqual({ kind: 'linked_files', count: 2 });
    expect(existsSync(join(project, 'left', 'started'))).toBe(false);
  });

  it('returns the complete typed linked-file count beyond the interpreter recursion depth', async () => {
    if (!supported()) return;
    const store = join(root, 'store'); writeFileSync(store, 'shared');
    const directories: string[] = []; let deep = join(project, 'left');
    try {
      for (let index = 0; index < 1_100; index++) { deep = join(deep, 'd'); mkdirSync(deep); directories.push(deep); }
      linkSync(store, join(deep, 'pkg'));
      const result = await launch("console.log('STARTED')");
      expect(result.exitCode).toBe(125);
      expect(result.writeGrantFailure).toEqual({ kind: 'linked_files', count: 1 });
      expect(result.output).not.toContain('STARTED');
    } finally {
      if (existsSync(join(deep, 'pkg'))) unlinkSync(join(deep, 'pkg'));
      for (const path of directories.reverse()) rmdirSync(path);
    }
  });

  it('counts hard links in shared caches and shared Git objects as well as project paths', async () => {
    if (!supported()) return;
    const { common, checkout } = await linkedWorktree();
    const cache = join(root, 'shared-cache'); mkdirSync(cache);
    const store = join(root, 'store-file'); writeFileSync(store, 'shared');
    linkSync(store, join(cache, 'cache-file')); linkSync(store, join(common, 'objects', 'linked-file'));
    const grant = { ...declaration(), projectDir: checkout, scope: ['.'], contract: { ...admitWriteGrant(checkout), sharedCaches: [cache] } };
    const result = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', 'process.exit(0)'], '', { cwd: checkout, timeout_ms: 60_000 }));
    expect(result.exitCode).toBe(125);
    expect(result.writeGrantFailure).toEqual({ kind: 'linked_files', count: 2 });
  });

  it('refuses an ignored hard-linked dependency store fixture and admits materialized copies', async () => {
    if (!supported()) return;
    const { checkout } = await linkedWorktree();
    writeFileSync(join(checkout, '.gitignore'), 'dependencies/\n');
    const store = join(root, 'dependency-store'); mkdirSync(store);
    const source = join(store, 'package'); writeFileSync(source, 'dependency bytes');
    mkdirSync(join(checkout, 'dependencies')); const dependency = join(checkout, 'dependencies', 'package');
    linkSync(source, dependency);
    expect(git(checkout, ['check-ignore', 'dependencies/package'])).toBe('dependencies/package');
    const grant = { ...declaration(), projectDir: checkout, scope: ['.'], contract: admitWriteGrant(checkout) };
    const launch = () => withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', 'process.stdout.write("started")'], '', { cwd: checkout, timeout_ms: 60_000 }));
    expect((await launch()).writeGrantFailure).toEqual({ kind: 'linked_files', count: 1 });
    grant.contract.sharedCaches.push(store);
    expect((await launch()).writeGrantFailure).toEqual({ kind: 'linked_files', count: 2 });
    rmSync(dependency); copyFileSync(source, dependency);
    const copied = await launch();
    expect(copied.exitCode, copied.output).toBe(0);
    expect(copied.writeGrantApplied?.linkedFileCount).toBe(0);
  });

  it('ignores planner notes while retaining outside-alias and primary-checkout refusal', async () => {
    if (!supported()) return;
    const exact = join(project, 'left', 'exact'); writeFileSync(exact, 'old');
    const result = await launch(observe(`fs.writeFileSync('left/sibling','bad')`), { scope: ['left/exact'] });
    expect(parsed(result.output)).toEqual({ denied: false });
    for (const scope of [['left/missing'], ['left/*.ts']]) {
      expect((await launch('process.exit(0)', { scope })).exitCode).toBe(0);
    }
    const outside = join(root, 'alias-target'); mkdirSync(outside); symlinkSync(outside, join(project, 'alias'));
    expect(parsed((await launch(observe("fs.writeFileSync('alias/outside','bad')"), { scope: ['alias/'] })).output)).toEqual({ denied: true, code: 'EACCES' });
    const { common } = await linkedWorktree();
    expect(() => prepareWriteGrant({ ...declaration(), projectDir: dirname(common), contract: admitWriteGrant(dirname(common)) }, root)).toThrow(WriteGrantError);
  });

  it('grants the whole project regardless of exact-file or glob work-division notes', async () => {
    if (!supported()) return;
    writeFileSync(join(project, 'left', 'exact'), 'old');
    const result = await launch(`const fs=require('node:fs'); fs.writeFileSync('left/exact','new'); console.log('ok')`, { scope: ['left/exact'] });
    expect(result.exitCode, result.output).toBe(0);
    const fileTree = await launch(`const fs=require('node:fs');fs.writeFileSync('left/exact','tree content');{${observe("fs.writeFileSync('left/sibling','bad')")}}`, { scope: ['left/exact/**'] });
    expect(fileTree.exitCode, fileTree.output).toBe(0);
    expect(JSON.parse(fileTree.output)).toEqual({ denied: false });
    const tree = await launch(`require('node:fs').writeFileSync('left/new-file','ok')`, { scope: ['left/**'] });
    expect(tree.exitCode, tree.output).toBe(0);
  });

  it('freezes kernel capability and project cache declarations at admission, without text-derived authority', () => {
    const cache = join(root, 'declared-cache');
    mkdirSync(join(project, 'config')); writeFileSync(join(project, 'config', 'write-grant.json'), JSON.stringify({ shared_caches: [cache] }));
    const query = vi.fn(() => ({ kind: 'unavailable' as const, reason: 'kernel_unavailable' as const }));
    const admitted = admitWriteGrant(project, query);
    expect(query).toHaveBeenCalledOnce();
    expect(admitted).toEqual({ version: 1, capability: { kind: 'unavailable', reason: 'kernel_unavailable' }, sharedCaches: [cache] });
    const state = readRunState(project, runId); const original = state.writeGrant;
    state.writeGrant = admitted; writeRunState(project, runId, state);
    expect(readRunState(project, runId).writeGrant).toEqual(original);
    updateOperationalRunStateAtPath(directory, state => { state.writeGrant = admitted; });
    expect(readRunState(project, runId).writeGrant).toEqual(original);
    expect(query).toHaveBeenCalledOnce();
    expect(prepareWriteGrant({ ...declaration(), contract: admitted }, root)).toBeUndefined();
  });

  it('records an unavailable kernel as a closed value and retains existing launch behavior', async () => {
    const unavailable = { version: 1 as const, capability: { kind: 'unavailable' as const, reason: 'abi_too_old' as const, abi: 2 }, sharedCaches: [] };
    const module = await import('../src/write-grant.js');
    vi.spyOn(module, 'admitWriteGrant').mockReturnValue(unavailable);
    const run = createRun(project, 'unavailable-fixture', 'name: unavailable-fixture\nstages: []\n', ['left']);
    directory = run.runDirPath; runId = run.runId;
    expect(readRunState(project, runId).writeGrant).toEqual(unavailable);
    const target = join(root, 'outside');
    const result = await withStageWriteGrant({ ...declaration(), contract: unavailable }, () => execWithStdin(process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)},'ok')`], '', { cwd: project, timeout_ms: 60_000 }));
    expect(result.exitCode, result.output).toBe(0); expect(result.writeGrantApplied).toBeUndefined();
    expect(readFileSync(target, 'utf8')).toBe('ok');
  });

  it('grants only project-declared shared caches and redirects undeclared cache variables', async () => {
    if (!supported()) return;
    const declared = join(root, 'declared-cache'), undeclared = join(root, 'ambient-cache');
    mkdirSync(declared); mkdirSync(undeclared); mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'config', 'write-grant.json'), JSON.stringify({ shared_caches: [declared] }));
    const admitted = admitWriteGrant(project);
    const command = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(declared, 'allowed'))},'ok'); let code; try{fs.writeFileSync(${JSON.stringify(join(undeclared,'bad'))},'bad');}catch(error){code=error.code;} console.log(JSON.stringify({code,cache:process.env.npm_config_cache,pip:process.env.PIP_CACHE_DIR,home:process.env.HOME}));`;
    const result = await withStageWriteGrant({ ...declaration(), contract: admitted }, () => execWithStdin(process.execPath, ['-e', command], '', {
      cwd: project, timeout_ms: 60_000, env: { npm_config_cache: declared, PIP_CACHE_DIR: undeclared },
    }));
    expect(result.exitCode, result.output).toBe(0);
    const observed = JSON.parse(result.output);
    expect(observed).toMatchObject({ code: 'EACCES', cache: declared });
    expect(observed.pip).toBe(join(observed.home, 'cache', 'pip'));
  });

  it('freezes declared cache aliases before an agent can redirect them', async () => {
    if (!supported()) return;
    const first = join(root, 'first-cache'), second = join(root, 'second-cache'), alias = join(project, 'cache-alias');
    mkdirSync(first); mkdirSync(second); symlinkSync(first, alias); mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'config', 'write-grant.json'), JSON.stringify({ shared_caches: [alias] }));
    const admitted = admitWriteGrant(project);
    expect(admitted.sharedCaches).toEqual([first]);
    rmSync(alias); symlinkSync(second, alias);
    const result = await withStageWriteGrant({ ...declaration(), scope: [], contract: admitted }, () => execWithStdin(process.execPath, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(join(first, 'allowed'))},'ok'); ${observe(`fs.writeFileSync(${JSON.stringify(join(second, 'denied'))},'bad')`)}`], '', { cwd: project, timeout_ms: 60_000 }));
    expect(result.exitCode, result.output).toBe(0);
    expect(parsed(result.output)).toEqual({ denied: true, code: 'EACCES' });
  });

  it('surfaces a runtime application error on an admitted capable host as a typed failure, without executing the agent', async () => {
    if (!supported()) return;
    const module = await import('../src/write-grant.js');
    const original = module.prepareWriteGrant;
    // Deterministically model a grant root disappearing after preparation.
    // The real launch bridge must observe ENOENT, never run unconstrained.
    vi.spyOn(module, 'prepareWriteGrant').mockImplementation((grant, scratch) => {
      const prepared = original(grant, scratch)!;
      prepared.writable.push({ path: join(root, 'missing-at-apply'), kind: 'file' });
      return prepared;
    });
    const result = await launch("require('node:fs').writeFileSync('left/started','bad')");
    expect(result.exitCode).toBe(125);
    expect(result.writeGrantFailure).toEqual({ kind: 'application_failed', errno: 2 });
    expect(existsSync(join(project, 'left', 'started'))).toBe(false);
  });

  it('retains a typed executable launch failure after applying the complete grant', async () => {
    if (!supported()) return;
    const missing = join(root, 'missing-agent');
    const result = await withStageWriteGrant(declaration(), () => execWithStdin(missing, [], '', { cwd: project, timeout_ms: 60_000 }));
    expect(result.exitCode).toBe(125);
    expect(result.writeGrantFailure).toEqual({ kind: 'exec_failed', errno: 2, path: missing });
    expect(result.writeGrantApplied?.linkedFileCount).toBe(0);
  });

  it('reads legacy records through state and listing and records legacy continuation explicitly', async () => {
    const path = runRecordPath(directory, 'run.json');
    const state = JSON.parse(readFileSync(path, 'utf8')); delete state.writeGrant;
    writeFileSync(path, JSON.stringify(state)); // fixture: bytes produced by the pre-grant engine
    expect(readRunStateView(project, runId).run.writeGrant).toEqual(legacyWriteGrant());
    expect(listRuns(project)).toContain(runId);
    expect(pollWatch(createWatchState(), { runsRoot: dirname(directory), candidateRunIds: () => [runId], nowMs: () => Date.parse(state.startedAt), isProcessAlive: () => false }).stats.readableRuns).toBe(1);
    expect(stateToRunDetail(readRunState(project, runId), project).writeGrant).toEqual(legacyWriteGrant());
    const status = execFileSync(process.execPath, ['--import', join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      join(import.meta.dirname, '..', 'src', 'cli.ts'), 'status', '--project', project], {
      cwd: project, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock') },
    });
    expect(status).toContain(`Run: ${runId}`);
    expect(status).toContain('Write grant: {"kind":"legacy_ungranted"}');
    updateRunState(project, runId, current => { current.status = 'running'; });
    expect(readRunState(project, runId).writeGrant).toEqual(legacyWriteGrant());
    const result = await launch(`require('node:fs').writeFileSync('right/legacy','ok')`);
    expect(result.exitCode, result.output).toBe(0); expect(result.writeGrantApplied).toBeUndefined();
  });

  it('queries the actual kernel instead of inferring capability from the OS name', () => {
    const capability = queryWriteGrantCapability();
    expect(contract.capability).toEqual(capability);
    if (capability.kind === 'landlock') expect(capability.abi).toBeGreaterThanOrEqual(3);
    else expect(capability).toMatchObject({ kind: 'unavailable', reason: expect.any(String) });
  });

  it.each(['ordinary', 'repair'] as const)('keeps role-selected native adapters and their internal retries granted on the %s path', async path => {
    if (!supported()) return;
    const bin = join(root, 'bin'); mkdirSync(bin);
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    const source = join(root, 'native-source'); mkdirSync(source);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('CODEX_HOME', source);
    vi.stubEnv('CLAUDE_CONFIG_DIR', source);
    vi.stubEnv('CODEX_PLUGINS_CACHE', source);
    vi.stubEnv('CODEX_SKILLS_CACHE', source);
    for (const provider of ['codex', 'claude']) writeFileSync(join(bin, provider), `#!${process.execPath}\n` + `
const fs=require('node:fs'), p=require('node:path');
const provider=p.basename(process.argv[1]), home=provider==='codex'?process.env.CODEX_HOME:process.env.CLAUDE_CONFIG_DIR;
process.stdin.resume(); process.stdin.on('end', () => {
 const receipt=p.join(home,'denials.json');
 const denials=fs.existsSync(receipt)?JSON.parse(fs.readFileSync(receipt,'utf8')):[];
 let code; try {fs.writeFileSync(${JSON.stringify(outside)},'bad');} catch(error) {code=error.code;}
 denials.push(code); fs.writeFileSync(receipt,JSON.stringify(denials));
 if(denials.length===1) {
  if(provider==='codex') process.stderr.write('error: reasoning effort is not supported with tools for this model\\n');
  else console.log(JSON.stringify({type:'result',is_error:true,error:{param:'effort',message:'unsupported effort'}}));
  process.exitCode=1; return;
 }
 const result=JSON.stringify({status:'delivered',summary:JSON.stringify(denials),caveats:[],remaining_work:[],blocks:null});
 if(provider==='codex') { console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}})); }
 else console.log(JSON.stringify({type:'result',is_error:false,result}));
});
`, { mode: 0o700 });
    for (const provider of ['codex', 'claude']) {
      const stage = StageConfigSchema.parse({ id: provider === 'codex' ? 'left' : 'right', role: 'native', scope: [provider === 'codex' ? 'left/' : 'right/'], artifact_contract: artifacts });
      const workflow = WorkflowConfigSchema.parse({ name: 'native-grant', stages: [stage], defaults: { max_retries: 0 } });
      const roles = new Map([['native', { ...role, reasoning_effort: 'high', adapter: provider }]]);
      const fallback: Adapter = { async run() { throw new Error('role-selected adapter was bypassed'); } };
      const agentsDir = join(import.meta.dirname, '..', 'config', 'agents');
      const state = readRunState(project, runId);
      const result = path === 'repair'
        ? await executeSingleStage(stage, project, runId, directory, workflow, fallback, roles, agentsDir, state, [stage])
        : (await executeOrdinaryStage(stage, [stage], state, project, runId, directory, fallback, roles, agentsDir, new Map(), new Map())).result;
      expect(result?.exitCode, result?.output).toBe(0);
      expect(JSON.parse(JSON.parse(result!.output).summary)).toEqual(['EACCES', 'EACCES']);
      expect(result?.invocations).toHaveLength(2);
      expect(result?.writeGrantApplied?.linkedFileCount).toBe(0);
    }
  });

  it('keeps delegated engine-recorded commands inside the requesting stage grant', async () => {
    if (!supported()) return;
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    let observed: any;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const adapter: Adapter = { sessionKind: 'local', async run(prompt, _role, opts) {
      const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
      const request = { command: `${quote(process.execPath)} -e ${quote(observe(`fs.writeFileSync(${JSON.stringify(outside)},'bad')`))}`, cwd: project, shell: '/bin/sh' };
      const result = await execWithStdin('/bin/sh', ['-c', `${client} ${quote(JSON.stringify(request))}`], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts });
      expect(result.exitCode, result.output).toBe(0);
      observed = JSON.parse(result.output);
      expect(observed.record?.exitCode, result.output).toBe(0);
      expect(JSON.parse(observed.stdout)).toEqual({ denied: true, code: 'EACCES' });
      return { ...result, output: JSON.stringify({ pass: true, reason: 'Recorded command observed.', criteria: {}, audit_findings: { version: 1, findings: [] } }) };
    } };
    await runStage(adapter, { stageId: 'left', role, dependsOn: [], promptTemplate: '', projectDir: project, runId, runDir: directory,
      retries: 0, timeout_ms: 60_000, artifactContract: artifacts, scope: ['left/'], isGate: true, outputSchema: stageRecordSchema({ isGate: true }) });
    expect(observed).toBeDefined();
  });

  it('restores the enclosing stage grant after an in-process nested stage launch', async () => {
    if (!supported()) return;
    const outer: Adapter = { sessionKind: 'local', async run(_prompt, _role, opts) {
      const inner = await launch(observe("fs.writeFileSync('left/from-inner','bad')"), { stageId: 'right' });
      expect(JSON.parse(inner.output)).toEqual({ denied: false });
      expect(currentStageWriteGrant()?.stageId).toBe('left');
      return execWithStdin(process.execPath, ['-e', observe("fs.writeFileSync('right/from-outer','bad')")], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts });
    } };
    const result = await runStage(outer, { stageId: 'left', role, dependsOn: [], promptTemplate: '', projectDir: project, runId, runDir: directory,
      retries: 0, timeout_ms: 60_000, artifactContract: artifacts, scope: ['left/'] });
    expect(parsed(result.output)).toEqual({ denied: false });
  });

  it('pins shared Git authority at admission even if an agent rewrites its worktree pointer', async () => {
    if (!supported()) return;
    const { common, checkout } = await linkedWorktree();
    const other = join(root, 'other-repository'); mkdirSync(other); git(other, ['init']);
    const grant = { ...declaration(), projectDir: checkout, scope: ['.'], contract: admitWriteGrant(checkout) };
    const first = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e',
      `require('node:fs').writeFileSync('.git',${JSON.stringify(`gitdir: ${join(other, '.git')}\n`)})`], '', { cwd: checkout, timeout_ms: 60_000 }));
    expect(first.exitCode, first.output).toBe(0);
    const next = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', observe(`fs.writeFileSync(${JSON.stringify(join(other, '.git', 'config'))},'bad')`)], '', { cwd: checkout, timeout_ms: 60_000 }));
    expect(JSON.parse(next.output)).toEqual({ denied: true, code: 'EACCES' });
    expect(grant.contract.git?.commonDir).toBe(common);
  });

  it('gives a dynamic planner its prepared exact proposal inode without granting sibling run paths', async () => {
    if (!supported()) return;
    const path = join(directory, 'work', 'dispatch.yaml');
    const contract = { ...artifacts, produces: [{ id: 'dispatch', root: 'run' as const, path: 'work/dispatch.yaml', kind: 'file' as const, nonempty: true }] };
    const adapter: Adapter = { sessionKind: 'local', async run(_prompt, _role, opts) {
      return execWithStdin(process.execPath, ['-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(path)},'{"stages":[]}'); let code; try {fs.writeFileSync(${JSON.stringify(join(directory,'work','sibling'))},'bad');}catch(error){code=error.code;} console.log(JSON.stringify({status:'delivered',summary:code,caveats:[],remaining_work:[],blocks:null}));`], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts });
    } };
    const result = await runStage(adapter, { stageId: 'left', role, dependsOn: [], promptTemplate: '', projectDir: project, runId, runDir: directory,
      retries: 0, timeout_ms: 60_000, artifactContract: contract, scope: [], dynamicDispatch: true, outputSchema: stageRecordSchema({}) });
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.output).summary).toBe('EACCES');
    expect(readFileSync(path, 'utf8')).toBe('{"stages":[]}');
  });

  it('keeps an engine-published verdict outside the agent grant while publishing its typed result', async () => {
    if (!supported()) return;
    const path = join(directory, 'work', 'verdict_left.json');
    const contract = { ...artifacts, produces: [{ id: 'verdict', root: 'run' as const, path: 'work/verdict_left.json', kind: 'file' as const, nonempty: false }] };
    const adapter: Adapter = { sessionKind: 'local', async run(_prompt, _role, opts) {
      return execWithStdin(process.execPath, ['-e', `let code; try {require('node:fs').writeFileSync(${JSON.stringify(path)},'forged');}catch(error){code=error.code;} console.log(JSON.stringify({pass:true,reason:code,criteria:{},audit_findings:{version:1,findings:[]}}));`], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts });
    } };
    const result = await runStage(adapter, { stageId: 'left', role, dependsOn: [], promptTemplate: '', projectDir: project, runId, runDir: directory,
      retries: 0, timeout_ms: 60_000, artifactContract: contract, scope: [], isGate: true, outputSchema: stageRecordSchema({ isGate: true }) });
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pass: true, reason: 'EACCES' });
  });

  it('refuses declarations covering another stage, shared run scratch or an engine record', () => {
    if (!supported()) return;
    for (const path of ['work', 'work/stages/right', 'work/scratch', 'engine', 'run.json']) {
      const grant = { ...declaration(), artifacts: { ...artifacts, produces: [{ id: 'escape', root: 'run' as const, path, kind: 'directory' as const, nonempty: false }] } };
      expect(() => prepareWriteGrant(grant, root)).toThrow(WriteGrantError);
    }
  });

  it('refuses an artifact whose authored ancestor aliases outside the project', () => {
    if (!supported()) return;
    mkdirSync(join(project, 'right', 'nested'));
    mkdirSync(join(root, 'outside-artifact', 'nested'), { recursive: true });
    symlinkSync(join(root, 'outside-artifact'), join(project, 'left', 'alias'));
    const grant = { ...declaration(), scope: [], artifacts: { ...artifacts, produces: [{ id: 'product', root: 'project' as const,
      path: 'left/alias/nested/output', kind: 'directory' as const, nonempty: false }] } };
    expect(() => prepareWriteGrant(grant, root)).toThrow(WriteGrantError);
    expect(existsSync(join(root, 'outside-artifact', 'nested', 'output'))).toBe(false);
  });

  it('refuses a live ancestor replacement at publication without creating or granting an outside directory', async () => {
    if (!supported()) return;
    mkdirSync(join(directory, 'work/shared/dir'), { recursive: true });
    const outside = join(root, 'outside'); mkdirSync(outside);
    const target = join(directory, 'work/shared/dir/new');
    const first = actor({ ...declaration(), artifacts: { ...artifacts, produces: [{ id: 'shared', root: 'run', path: 'work/shared', kind: 'directory' }] } }, `fs.renameSync(${JSON.stringify(join(directory, 'work/shared/dir'))},${JSON.stringify(join(directory, 'work/shared/saved'))});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(join(directory, 'work/shared/dir'))});return 'swapped';`);
    let active = true, synchronized = false;
    try {
      const socket = await first.readiness;
      observeEnginePublications(paths => {
        if (active && !synchronized && paths.includes(target)) {
          synchronized = true;
          // The actor event is synchronous with preparation, never a sleep.
          execFileSync(process.execPath, ['-e', `const net=require('node:net');const s=net.connect(${JSON.stringify(socket)},()=>s.write('go'));s.on('end',()=>s.end());`], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, timeout: 30_000 });
        }
        return () => {};
      });
      const second = await withStageWriteGrant({ ...declaration('right'), artifacts: { ...artifacts, produces: [{ id: 'shared', root: 'run', path: 'work/shared/dir/new', kind: 'directory' }] } }, () => execWithStdin(process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(outside, 'new', 'escaped'))},'bad')`], '',
        { cwd: project, timeout_ms: 60_000, execution: { runDir: directory } }));
      expect(second.exitCode).toBe(125);
      expect(second.writeGrantFailure).toMatchObject({ kind: 'unsafe_path' });
      expect(synchronized).toBe(true);
      expect((await first.result).exitCode).toBe(0);
      expect(existsSync(join(outside, 'new'))).toBe(false);
    } finally { active = false; await first.result; }
  });

  it('refuses a live exact run-output file replacement with a directory before agent execution', async () => {
    if (!supported()) return;
    const exact = join(directory, 'work/shared/exact'); mkdirSync(dirname(exact), { recursive: true }); writeFileSync(exact, 'original');
    const first = actor({ ...declaration(), artifacts: { ...artifacts, produces: [{ id: 'shared', root: 'run', path: 'work/shared', kind: 'directory' }] } }, `fs.renameSync(${JSON.stringify(exact)},${JSON.stringify(exact + '.saved')});fs.mkdirSync(${JSON.stringify(exact)});return 'swapped';`);
    const grant = { ...declaration('right'), artifacts: { ...artifacts, produces: [{ id: 'exact', root: 'run' as const, path: 'work/shared/exact', kind: 'file' as const, nonempty: false }] } };
    let active = true, synchronized = false;
    try {
      const socket = await first.readiness;
      observeEnginePublications(paths => {
        if (active && !synchronized && paths.includes(grant.home)) {
          synchronized = true;
          execFileSync(process.execPath, ['-e', `const net=require('node:net');const s=net.connect(${JSON.stringify(socket)},()=>s.write('go'));s.on('end',()=>s.end());`], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, timeout: 30_000 });
        }
        return () => {};
      });
      const second = await withStageWriteGrant(grant, () => execWithStdin(process.execPath,
        ['-e', `console.log('STARTED');require('node:fs').writeFileSync(${JSON.stringify(join(exact, 'descendant'))},'bad')`], '',
        { cwd: project, timeout_ms: 60_000, execution: { runDir: directory } }));
      expect(synchronized).toBe(true);
      expect((await first.result).exitCode).toBe(0);
      expect(second.exitCode).toBe(125);
      expect(second.writeGrantFailure).toEqual({ kind: 'unsafe_path', path: exact });
      expect(second.writeGrantApplied).toBeUndefined();
      expect(second.output).not.toContain('STARTED');
      expect(existsSync(join(exact, 'descendant'))).toBe(false);
    } finally { active = false; await first.result; }
  });

  it('anchors engine-owned home and artifact paths to the physical run when its caller uses an alias', async () => {
    if (!supported()) return;
    const alias = join(root, 'run-alias'); symlinkSync(directory, alias);
    const product = 'work/stages/left/product'; mkdirSync(dirname(join(directory, product)), { recursive: true });
    writeFileSync(join(directory, product), 'old');
    const grant = { ...declaration(), runDir: alias, home: join(alias, relative(directory, declaration().home)),
      artifacts: { ...artifacts, produces: [{ id: 'product', root: 'run' as const, path: product, kind: 'file' as const, nonempty: true }] } };
    const result = await withStageWriteGrant(grant, () => execWithStdin(process.execPath, ['-e', `
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.HOME,'own'),'ok');fs.writeFileSync(${JSON.stringify(join(alias, product))},'new');
{${observe("fs.writeFileSync('right/bad','bad')")}}`], '', { cwd: project, timeout_ms: 60_000, execution: { runDir: alias } }));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.writeGrantApplied?.linkedFileCount).toBe(0);
    expect(parsed(result.output)).toEqual({ denied: false });
    expect(readFileSync(join(directory, product), 'utf8')).toBe('new');
  });

  it('probes once on new admission and never probes again for stage retries or continuation writes', async () => {
    const module = await import('../src/write-grant.js');
    const original = module.admitWriteGrant;
    const query = vi.fn(queryWriteGrantCapability);
    vi.spyOn(module, 'admitWriteGrant').mockImplementation(path => original(path, query));
    const run = createRun(project, 'grant-fixture', 'name: grant-fixture\nstages: []\n', ['left']);
    directory = run.runDirPath; runId = run.runId;
    contract = readRunState(project, runId).writeGrant!;
    expect(query).toHaveBeenCalledOnce();
    await launch('process.exit(0)'); await launch('process.exit(0)');
    updateRunState(project, runId, state => { state.status = 'running'; });
    expect(query).toHaveBeenCalledOnce();
    expect(readRunState(project, runId).writeGrant).toEqual(contract);
  });

  it.each(['author', 'successor-author', 'successor-repair', 'gate', 'isolated-decision'] as const)(
    'preserves admitted external outputs and the shared boundary for a scheduler %s', async kind => {
      if (!supported()) return;
      const { writeBriefCriteriaArtifact } = await import('../src/brief-criteria.js');
      // The fixture's installation, project and output are separate roots,
      // including when all temporary storage lives inside the source checkout.
      const inputs = await import('../src/ship-inputs.js');
      const external = inputs.externalOutputDirectory;
      vi.spyOn(inputs, 'externalOutputDirectory').mockImplementation((declaration, project, fs, context) =>
        external(declaration, project, fs, { engineRoot: join(root, 'engine'), ...context }));
      const output = join(root, 'results'); mkdirSync(output);
      const sharedCache = join(root, 'shared-cache'); mkdirSync(sharedCache);
      mkdirSync(join(project, 'config'), { recursive: true });
      writeFileSync(join(project, 'config/write-grant.json'), JSON.stringify({ shared_caches: [sharedCache] }));
      const brief = `---\noutputs: [{path: ${JSON.stringify(output)}, type: directory}]\n---\nRetain the declared output.`;
      ({ runId, runDirPath: directory } = createRun(project, 'grant-fixture', 'name: grant-fixture\nstages: []\n', ['left', 'right'], brief));
      contract = readRunState(project, runId).writeGrant!;
      writeBriefCriteriaArtifact(directory, brief);
      const isolated = kind === 'isolated-decision', gate = kind === 'gate';
      const author = !isolated && !gate;
      const stage = StageConfigSchema.parse({ id: 'left', role: 'local', scope: ['arbitrary project work note'], artifact_contract: gate ? { ...artifacts, produces: [{ id: 'project', root: 'project', path: 'left', kind: 'directory', nonempty: false }] } : artifacts,
        ...(kind === 'author' || gate ? {} : { decision: { successors: ['right'], default: 'right', ...(isolated ? { kind: 'shape' } : {}) } }),
        ...(gate ? { is_gate: true } : {}),
        ...(kind === 'successor-repair' ? { retry_to: ['right'], depends_on: ['right'] } : {}),
      });
      const review = StageConfigSchema.parse({ id: 'right', role: 'local', scope: [], is_gate: true, artifact_contract: artifacts });
      let child: ExecResult | undefined;
      const adapter: Adapter = { sessionKind: 'local', async run(_prompt, _role, opts) {
        child = await execWithStdin(process.execPath, ['-e', `
const fs=require('node:fs'),path=require('node:path');
const attempt=action=>{try{action();return 'allowed';}catch(error){return error.code;}};
const source=path.join(process.env.HOME,'source');fs.writeFileSync(source,'private');
console.log(JSON.stringify({
 project:attempt(()=>fs.writeFileSync('left/project-result','required project write')),
 cache:attempt(()=>fs.writeFileSync(${JSON.stringify(join(sharedCache, 'entry'))},'retained cache')),
 output:attempt(()=>fs.writeFileSync(${JSON.stringify(join(output, 'result'))},'required output')),
 parent:attempt(()=>fs.writeFileSync(${JSON.stringify(join(root, 'sibling'))},'bad')),
 alias:attempt(()=>fs.linkSync(source,${JSON.stringify(join(output, 'alias'))}))
}));`], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts, captureStreams: true });
        const record = gate ? { pass: true, reason: 'Read-only gate.', criteria: {}, audit_findings: { version: 1, findings: [] } }
          : stage.decision ? { successor: 'right', reason: 'Declared output observed.', ...(isolated ? { assumptions: [] } : {}) }
          : { status: 'delivered', summary: 'Declared output observed.', caveats: [], remaining_work: [], blocks: null };
        return { ...child, output: JSON.stringify(record) };
      } };
      const executed = await executeOrdinaryStage(stage, [stage, review], readRunState(project, runId), project, runId, directory,
        adapter, new Map([['local', role]]), join(import.meta.dirname, '..', 'config', 'agents'), new Map(), new Map(), undefined, brief);
      expect(executed.result.exitCode, executed.result.output).toBe(0);
      expect(child?.exitCode, child?.output).toBe(0);
      expect(child?.writeGrantApplied).toEqual({ abi: contract.capability.kind === 'landlock' ? contract.capability.abi : 0, linkedFileCount: 0 });
      expect(JSON.parse(child!.stdout!)).toEqual({ cache: 'allowed', project: author ? 'allowed' : 'EACCES', output: author ? 'allowed' : 'EACCES', parent: 'EACCES', alias: author ? 'EXDEV' : 'EACCES' });
      expect(existsSync(join(root, 'sibling'))).toBe(false);
      expect(existsSync(join(output, 'alias'))).toBe(false);
      if (author) expect(readFileSync(join(output, 'result'), 'utf8')).toBe('required output');
      else expect(existsSync(join(output, 'result'))).toBe(false);
    });
});
