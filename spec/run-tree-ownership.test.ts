import { afterEach, beforeEach, expect, it } from 'vitest';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { stageSessionHome } from '../src/adapter-session.js';
import { createInvocationScratch, retireRunScratch } from '../src/invocation-scratch.js';
import { artifactDeclarationFindings } from '../src/artifact-declarations.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import * as engineFs from '../src/engine-fs.js';
import { engineDirectory, stageWorkPath, runRecordPath, pathInTree } from '../src/run-layout.js';
import { buildStagePrompt } from '../src/handoff.js';
import { runStage } from '../src/worker.js';
import { fcGlobalDir, setFcGlobalDir, runsRoot, ensureGlobalRunsDir } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, run: string, runId: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
const role = { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' };
const input = () => ({ projectDir: project, runDir: run, stageId: 'work', artifactContract: contract });
const child = (code: string) => execWithStdin(process.execPath, ['-e', code], '', { cwd: project, timeout_ms: 5000 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'run-tree-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  ({ runDirPath: run, runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']));
});
afterEach(() => { retireRunScratch(run); setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

it('retires a work symlink without changing or voiding its engine target', async () => {
  const target = runRecordPath(run, 'record'), alias = stageWorkPath(run, 'alias');
  writeFileSync(target, 'trusted'); symlinkSync(target, alias);
  await withEngineIntegrity(input(), async () => { engineFs.unlinkSync(alias); });
  expect(readFileSync(target, 'utf8')).toBe('trusted');
  expect(existsSync(alias)).toBe(false);
});

it('publishes through an engine directory alias using its physical record locations', async () => {
  const directory = runRecordPath(run, 'records'), alias = runRecordPath(run, 'alias');
  mkdirSync(directory); symlinkSync(directory, alias);
  writeFileSync(join(directory, 'source'), 'source');
  symlinkSync(join(directory, 'source'), join(directory, 'carrier'));
  await withEngineIntegrity(input(), async () => {
    engineFs.writeFileSync(join(alias, 'new-record'), 'parent');
    engineFs.mkdirSync(join(alias, 'new-directory'));
    engineFs.copyFileSync(join(alias, 'new-record'), join(alias, 'carrier'));
    engineFs.unlinkSync(join(alias, 'new-record'));
  });
  expect(readFileSync(join(directory, 'source'), 'utf8')).toBe('parent');
  expect(fs.statSync(join(directory, 'new-directory')).isDirectory()).toBe(true);
  expect(existsSync(join(directory, 'new-record'))).toBe(false);
});

it.each(['mkdirSync', 'mkdtempSync', 'rmSync', 'chmodSync', 'symlinkSync', 'cpSync'] as const)('keeps the %s namespace intent when a child substitutes a record before acknowledgement', async method => {
  const target = runRecordPath(run, 'namespace-target'), source = runRecordPath(run, 'namespace-source');
  mkdirSync(source); writeFileSync(join(source, 'record'), 'source record');
  if (method === 'rmSync' || method === 'chmodSync') writeFileSync(target, 'trusted');
  const native = fs[method], mutable = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  let created = target, armed = true;
  mutable[method] = (...args) => {
    const result = Reflect.apply(native, fs, args);
    const actualTarget = method === 'symlinkSync' || method === 'cpSync' ? args[1] : args[0];
    if (armed && actualTarget === target) {
      armed = false;
      if (method === 'mkdtempSync') created = String(result);
      const forged = method === 'mkdirSync' || method === 'mkdtempSync' ? join(created, 'child-only-record')
        : method === 'cpSync' ? join(target, 'record') : target;
      execFileSync(process.execPath, ['-e', `const fs=require('node:fs'),p=${JSON.stringify(forged)};
        if(${JSON.stringify(method)}==='symlinkSync')fs.unlinkSync(p);fs.writeFileSync(p,'counterfeit');`],
      { cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'store') }, timeout: 5000, stdio: 'ignore' });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await expect(withEngineIntegrity(input(), async () => {
      if (method === 'mkdirSync') engineFs.mkdirSync(target);
      else if (method === 'mkdtempSync') engineFs.mkdtempSync(target);
      else if (method === 'rmSync') engineFs.rmSync(target);
      else if (method === 'chmodSync') engineFs.chmodSync(target, 0o600);
      else if (method === 'symlinkSync') engineFs.symlinkSync(join(source, 'record'), target);
      else engineFs.cpSync(source, target, { recursive: true });
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  } finally { mutable[method] = native; syncBuiltinESMExports(); }
  if (method === 'rmSync') expect(existsSync(target)).toBe(false);
  else if (method === 'mkdirSync' || method === 'mkdtempSync') {
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(existsSync(join(created, 'child-only-record'))).toBe(false);
  } else if (method === 'chmodSync') {
    expect(readFileSync(target, 'utf8')).toBe('trusted');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  } else expect(readFileSync(method === 'cpSync' ? join(target, 'record') : target, 'utf8')).toBe('source record');
});

it.each(['writeFileSync', 'appendFileSync', 'openSync', 'writeSync', 'ftruncateSync', 'copyFileSync', 'linkSync'] as const)('keeps the trusted %s bytes when a child replaces them before acknowledgement', async method => {
  const carrier = runRecordPath(run, 'future-record');
  writeFileSync(carrier, 'trusted');
  const source = runRecordPath(run, 'publication-source');
  writeFileSync(source, 'parent publication');
  if (method === 'linkSync') unlinkSync(carrier);
  let targetFd: number | undefined;
  const native = fs[method];
  const mutable = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  mutable[method] = (...args) => {
    const result = Reflect.apply(native, fs, args);
    const target = method === 'copyFileSync' || method === 'linkSync' ? args[1] : args[0];
    if ((target === carrier || targetFd !== undefined && target === targetFd) && (method !== 'openSync' || String(args[1]).includes('w'))) execFileSync(process.execPath, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(carrier)}, 'child overwrite')`],
    { cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'store') }, timeout: 5000, stdio: 'ignore' });
    return result;
  };
  syncBuiltinESMExports();
  try {
    await expect(withEngineIntegrity(input(), async () => {
      if (method === 'copyFileSync' || method === 'linkSync') engineFs[method](source, carrier);
      else if (method === 'openSync') engineFs.closeSync(engineFs.openSync(carrier, 'w'));
      else if (method === 'writeSync' || method === 'ftruncateSync') {
        targetFd = engineFs.openSync(carrier, 'r+');
        try {
          if (method === 'writeSync') engineFs.writeSync(targetFd, 'parent publication');
          else engineFs.ftruncateSync(targetFd, 3);
        } finally { engineFs.closeSync(targetFd); targetFd = undefined; }
      } else engineFs[method](carrier, 'parent publication');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  } finally { mutable[method] = native; syncBuiltinESMExports(); }
  expect(readFileSync(carrier, 'utf8')).toBe(method === 'appendFileSync' ? 'trustedparent publication'
    : method === 'openSync' ? '' : method === 'ftruncateSync' ? 'tru' : 'parent publication');
});

it.each(['write', 'append'] as const)('hashes the previous content before a trusted %s despite restored timestamps', async publication => {
  const carrier = runRecordPath(run, 'future-record');
  writeFileSync(carrier, 'trusted');
  fs.utimesSync(carrier, 1, 1);
  let published = false;
  await expect(withEngineIntegrity(input(), async () => {
    const forged = await child(`const fs=require('node:fs'),p=${JSON.stringify(carrier)},s=fs.statSync(p);
      fs.writeFileSync(p,'forgery');fs.utimesSync(p,s.atime,s.mtime);`);
    expect(forged.exitCode).toBe(0);
    if (publication === 'write') engineFs.writeFileSync(carrier, 'parent publication');
    else engineFs.appendFileSync(carrier, 'parent publication');
    published = true;
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(published, 'a parent publication cannot hide counterfeit predecessor bytes').toBe(false);
  expect(readFileSync(carrier, 'utf8')).toBe('trusted');
});

it('catches an arbitrary engine carrier under a home-looking directory', async () => {
  const home = stageSessionHome(run, 'work');
  expect(pathInTree(stageWorkPath(run), home)).toBe(true);
  expect(pathInTree(engineDirectory(run), home)).toBe(false);
  const carrier = join(engineDirectory(run), 'never_registered_home', 'arbitrary-record');
  mkdirSync(dirname(carrier), { recursive: true }); writeFileSync(carrier, 'trusted');
  await expect(withEngineIntegrity(input(), () => child(`require('node:fs').writeFileSync(${JSON.stringify(carrier)}, 'forged')`)))
    .rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(readFileSync(carrier, 'utf8')).toBe('trusted');
});

it('accepts a gate writing its own work verdict and publishes only its validated answer', async () => {
  const answer = { pass: true, reason: 'Inspected the fixture.', audit_findings: { version: 1, findings: [] }, remaining_work: [] };
  const verdict = stageWorkPath(run, 'verdict_review.json');
  const adapter: Adapter = { async run() {
    writeFileSync(verdict, JSON.stringify(answer));
    return { output: JSON.stringify(answer), exitCode: 0, duration_ms: 1 };
  } };
  const result = await runStage(adapter, { stageId: 'review', isGate: true, projectDir: project, runDir: run, runId,
    role, dependsOn: [], promptTemplate: 'Judge the fixture.', timeout_ms: 10000, retries: 0,
    artifactContract: { ...contract, produces: [{ root: 'run', path: 'work/verdict_review.json', id: 'verdict', kind: 'file' }] },
    outputSchema: { type: 'object', required: ['pass', 'reason', 'audit_findings', 'remaining_work'], properties: {
      pass: { type: 'boolean' }, reason: { type: 'string' }, audit_findings: { type: 'object' }, remaining_work: { type: 'array', items: { type: 'string' } },
    }, additionalProperties: false } });
  expect(result.exitCode, result.friendlyError ?? result.output).toBe(0);
  expect(existsSync(runRecordPath(run, 'verdict_review.json')), 'schema-validated verdict is engine-published').toBe(true);
  expect(JSON.parse(readFileSync(runRecordPath(run, 'verdict_review.json'), 'utf8'))).toEqual(answer);
  expect(JSON.parse(readFileSync(stageWorkPath(run, 'stages', 'review', 'result.json'), 'utf8'))).toEqual(answer);
  const audit = JSON.parse(readFileSync(runRecordPath(run, 'stages', 'review', 'artifact_contract.json'), 'utf8'));
  expect(audit.observations).toContainEqual(expect.objectContaining({ path: verdict, fresh: true, sha256: createHash('sha256').update(readFileSync(runRecordPath(run, 'verdict_review.json'))).digest('hex') }));
});

it('gives stages a work location where probes and evidence do not void the result', async () => {
  const workspace = buildStagePrompt({ projectDir: project, runId, runDir: run, stageId: 'work', dependsOn: [], promptTemplate: '{run_dir}' }, '').trim();
  const probe = runRecordPath(workspace, 'stage_evidence', 'probe', 'observed.txt');
  await withEngineIntegrity(input(), () => child(`const fs=require('node:fs'),p=${JSON.stringify(probe)};fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,'observed')`));
  expect(workspace).toBe(stageWorkPath(run));
  expect(readFileSync(probe, 'utf8')).toBe('observed');
  expect(existsSync(runRecordPath(run, 'stage_evidence', 'probe', 'observed.txt'))).toBe(false);
});

it('keeps a latched guard error with its run while another run publishes', async () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const carrier = runRecordPath(run, 'run.json'), trusted = readFileSync(carrier, 'utf8');
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const failing = withEngineIntegrity(input(), async () => {
    writeFileSync(carrier, 'forged');
    try { engineFs.writeFileSync(carrier, 'engine must not hide the forgery'); } catch { /* retain the first guard error */ }
    ready(); await released;
  });
  const refused = expect(failing).rejects.toThrow('ENGINE_STATE_TAMPERED');
  await entered;
  try {
    await withEngineIntegrity({ ...input(), runDir: other }, async () => {
      engineFs.mkdirSync(runsRoot(), { recursive: true });
      engineFs.atomicWrite(runRecordPath(other, 'new-engine-fact'), 'other run');
    });
    expect(readFileSync(runRecordPath(other, 'new-engine-fact'), 'utf8')).toBe('other run');
  } finally { release(); }
  await refused;
  expect(readFileSync(carrier, 'utf8')).toBe(trusted);
});

it('does not publish a schema-invalid gate answer from the work tree', async () => {
  const adapter: Adapter = { async run() { return { output: '{"pass":"yes"}', exitCode: 0, duration_ms: 1 }; } };
  const result = await runStage(adapter, { stageId: 'review', isGate: true, projectDir: project, runDir: run, runId,
    role, dependsOn: [], promptTemplate: 'Judge the fixture.', timeout_ms: 10000, retries: 0, artifactContract: contract,
    outputSchema: { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' } }, additionalProperties: false } });
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(runRecordPath(run, 'verdict_review.json'))).toBe(false);
});

it.each(['before', 'during'] as const)('refuses a work directory redirected to another engine tree %s execution', async timing => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const workspace = stageWorkPath(run, 'stages', 'review');
  const redirect = () => {
    rmSync(workspace, { recursive: true, force: true });
    symlinkSync(engineDirectory(other), workspace, 'dir');
  };
  if (timing === 'before') redirect();
  const answer = { pass: true, reason: 'Inspected.', audit_findings: { version: 1, findings: [] }, remaining_work: [] };
  const adapter: Adapter = { async run() {
    if (timing === 'during') redirect();
    return { output: JSON.stringify(answer), exitCode: 0, duration_ms: 1 };
  } };
  const outcome = await runStage(adapter, { stageId: 'review', isGate: true, projectDir: project, runDir: run, runId,
    role, dependsOn: [], promptTemplate: 'Judge.', timeout_ms: 10000, retries: 0, artifactContract: contract,
    outputSchema: { type: 'object', required: ['pass', 'reason', 'audit_findings', 'remaining_work'], properties: {
      pass: { type: 'boolean' }, reason: { type: 'string' }, audit_findings: { type: 'object' }, remaining_work: { type: 'array', items: { type: 'string' } },
    }, additionalProperties: false } }).then(result => result.exitCode, () => 125);
  expect(outcome, 'an engine alias cannot become a stage result destination').not.toBe(0);
  expect(existsSync(runRecordPath(other, 'result.json')), 'no trusted write through a stage alias').toBe(false);
  expect(existsSync(runRecordPath(run, 'verdict_review.json'))).toBe(false);
});

it('does not allocate invocation scratch through an alias into another engine tree', () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  symlinkSync(engineDirectory(other), stageWorkPath(run, 'scratch'), 'dir');
  expect(() => createInvocationScratch(run)).toThrow('stage write resolves outside its work tree');
  expect(existsSync(runRecordPath(other, '.tmpdir'))).toBe(false);
});

it('keeps scratch coordination in engine storage and ignores a stage-authored locator', async () => {
  const first = createInvocationScratch(run);
  const locator = runRecordPath(run, 'scratch', '.tmpdir');
  expect(pathInTree(engineDirectory(run), locator)).toBe(true);
  expect(existsSync(locator), 'the engine owns scratch coordination').toBe(true);
  const trusted = readFileSync(locator, 'utf8');
  const redirected = join(project, basename(dirname(first.path)));
  await withEngineIntegrity(input(), async () => {
    writeFileSync(stageWorkPath(run, 'scratch', '.tmpdir'), redirected);
    expect(dirname(createInvocationScratch(run).path)).toBe(dirname(first.path));
  });
  expect(existsSync(redirected)).toBe(false);
  await expect(withEngineIntegrity(input(), () => child(`require('node:fs').writeFileSync(${JSON.stringify(locator)}, 'forged')`)))
    .rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(readFileSync(locator, 'utf8')).toBe(trusted);
});

it.each(['future-name', 'staging.tmp.123', 'recovery.integrity-restore', 'another_home/record'])('guards every engine-tree spelling: %s', async local => {
  const carrier = join(engineDirectory(run), local);
  await expect(withEngineIntegrity(input(), () => child(`const fs=require('node:fs'),p=${JSON.stringify(carrier)};fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,'forged')`)))
    .rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(existsSync(carrier)).toBe(false);
});

it('does not infer the new layout from an authored engine directory in an old run', async () => {
  const legacy = join(root, 'legacy'); mkdirSync(join(legacy, 'engine'), { recursive: true });
  writeFileSync(join(legacy, 'run.json'), JSON.stringify({ runId: 'legacy', projectDir: project, status: 'complete', stages: {} }));
  writeFileSync(runRecordPath(legacy, 'workflow.yaml'), 'legacy workflow');
  expect(runRecordPath(legacy, 'workflow.yaml')).toBe(join(legacy, 'workflow.yaml'));
  await expect(withEngineIntegrity({ ...input(), runDir: legacy }, async () => {})).rejects.toThrow('RUN_LAYOUT_INCOMPATIBLE');
});


it('refuses a redirected run alias before publishing into another engine tree', async () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const alias = join(root, 'stage_home'); symlinkSync(run, alias, 'dir');
  await expect(withEngineIntegrity({ ...input(), runDir: alias }, async () => {
    unlinkSync(alias); symlinkSync(other, alias, 'dir');
    engineFs.atomicWrite(runRecordPath(alias, 'never-registered'), 'counterfeit');
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(existsSync(runRecordPath(other, 'never-registered'))).toBe(false);
});

it('keeps an unscannable failed guard out of another run publication', async () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const failing = withEngineIntegrity(input(), async () => {
    writeFileSync(runRecordPath(run, 'run.json'), 'forged');
    try { engineFs.writeFileSync(runRecordPath(run, 'run.json'), 'cannot adopt'); } catch { /* latched */ }
    symlinkSync(project, runRecordPath(run, 'unscannable-alias'), 'dir');
    ready(); await released;
  });
  const refused = expect(failing).rejects.toThrow('ENGINE_STATE_TAMPERED');
  await entered;
  try {
    await withEngineIntegrity({ ...input(), runDir: other }, async () => {
      engineFs.mkdtempSync(join(runsRoot(), 'peer-'));
      engineFs.atomicWrite(runRecordPath(other, 'healthy-publication'), 'intact');
    });
    expect(readFileSync(runRecordPath(other, 'healthy-publication'), 'utf8')).toBe('intact');
  } finally { release(); }
  await refused;
});

it.each(['run', 'project'] as const)('refuses %s outputs aliasing an idle peer run engine record', outputRoot => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const carrier = runRecordPath(other, 'arbitrary-record');
  writeFileSync(carrier, 'trusted peer record');
  for (const kind of ['file', 'directory'] as const) for (const aliasKind of ['hardlink', 'symlink'] as const) {
    const base = outputRoot === 'run' ? stageWorkPath(run) : project;
    const name = `${kind}-${aliasKind}`;
    const output = join(base, name);
    if (kind === 'directory') mkdirSync(output);
    const alias = kind === 'directory' ? join(output, 'ordinary-result') : output;
    if (aliasKind === 'hardlink') fs.linkSync(carrier, alias);
    else symlinkSync(carrier, alias);
    const artifactContract = { ...contract, produces: [{ id: 'result', root: outputRoot,
      path: outputRoot === 'run' ? `work/${name}` : name, kind }] };
    const findings = artifactDeclarationFindings({ projectDir: project, runDir: run,
      stages: [{ id: 'work', depends_on: [], artifact_contract: artifactContract }] });
    expect(findings, `${outputRoot} ${kind} ${aliasKind}`).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH'),
    }));
    expect(readFileSync(carrier, 'utf8')).toBe('trusted peer record');
  }
});

it('keeps ordinary hardlinked work outputs admissible across runs', () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const source = stageWorkPath(other, 'ordinary-source');
  writeFileSync(source, 'stage-owned bytes');
  const directory = stageWorkPath(run, 'results'); mkdirSync(directory);
  fs.linkSync(source, join(directory, 'ordinary-result'));
  const stage = { id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
    { id: 'file', root: 'run' as const, path: 'work/results/ordinary-result', kind: 'file' as const },
    { id: 'directory', root: 'run' as const, path: 'work/results', kind: 'directory' as const },
  ] } };
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [stage] })).toEqual([]);
});

it('keeps a project output writable when a legacy archive symlink refers to it', () => {
  const output = join(project, 'ordinary-result.md'); writeFileSync(output, 'stage-owned result');
  const legacy = join(runsRoot(), 'legacy');
  mkdirSync(join(legacy, 'declared_outputs'), { recursive: true });
  writeFileSync(join(legacy, 'run.json'), JSON.stringify({ runId: 'legacy', projectDir: project, status: 'complete', stages: {} }));
  symlinkSync(output, join(legacy, 'declared_outputs', 'ordinary-result.md'));
  const stage = { id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
    { id: 'result', root: 'project' as const, path: 'ordinary-result.md', kind: 'file' as const },
  ] } };
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [stage] })).toEqual([]);
});


it.each(['run', 'project'] as const)('refuses %s hardlink outputs with an engine alias in another configured store', outputRoot => {
  const store = fcGlobalDir();
  let other: string;
  try {
    setFcGlobalDir(join(root, 'other-store'));
    other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  } finally { setFcGlobalDir(store); }
  const carrier = runRecordPath(other!, 'workflow.yaml');
  const trusted = readFileSync(carrier, 'utf8');
  for (const kind of ['file', 'directory'] as const) {
    const base = outputRoot === 'run' ? stageWorkPath(run) : project;
    const output = join(base, `other-store-${kind}`);
    if (kind === 'directory') mkdirSync(output);
    fs.linkSync(carrier, kind === 'directory' ? join(output, 'ordinary-result') : output);
    const findings = artifactDeclarationFindings({ projectDir: project, runDir: run,
      stages: [{ id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
        { id: 'result', root: outputRoot, path: `${outputRoot === 'run' ? 'work/' : ''}other-store-${kind}`, kind },
      ] } }] });
    expect(findings, `${outputRoot} ${kind}`).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH'),
    }));
    expect(readFileSync(carrier, 'utf8')).toBe(trusted);
  }
});

it('admits an ordinary output when a terminal peer disappears during its identity read', async () => {
  const other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  const output = stageWorkPath(run, 'ordinary-result'); writeFileSync(output, 'ordinary output');
  const native = fs.statSync;
  let removed = false, invoked = false;
  fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
    if (!removed && String(args[0]) === stageWorkPath(other)) {
      removed = true;
      rmSync(other, { recursive: true, force: true });
    }
    return Reflect.apply(native, fs, args);
  }) as typeof fs.statSync;
  syncBuiltinESMExports();
  try {
    const result = await runStage({ async run() {
      invoked = true;
      return { exitCode: 0, duration_ms: 1, output: '{}' };
    } }, { stageId: 'work', projectDir: project, runDir: run, runId, role, dependsOn: [],
      promptTemplate: 'Read the ordinary result.', timeout_ms: 10000, retries: 0, outputSchema: { type: 'object' },
      artifactContract: { ...contract, produces: [{ id: 'result', root: 'run', path: 'work/ordinary-result', kind: 'file' }] } });
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(invoked).toBe(true);
    expect(removed).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('ordinary output');
    expect(existsSync(run)).toBe(true);
  } finally { fs.statSync = native; syncBuiltinESMExports(); }
});


it('does not count an engine record reached through a peer work symlink as a writable hardlink', () => {
  const store = fcGlobalDir();
  let other: string;
  try {
    setFcGlobalDir(join(root, 'other-store'));
    other = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  } finally { setFcGlobalDir(store); }
  const carrier = runRecordPath(other!, 'workflow.yaml');
  const peer = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  rmSync(stageWorkPath(peer), { recursive: true, force: true });
  symlinkSync(engineDirectory(other!), stageWorkPath(peer), 'dir');
  fs.linkSync(carrier, stageWorkPath(run, 'ordinary-result'));
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
    id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
      { id: 'result', root: 'run', path: 'work/ordinary-result', kind: 'file' },
    ] },
  }] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
});

it.each([1, 2] as const)('refuses foreign layout-%s engine grants inside the project through every output route', async layout => {
  const peerProject = join(root, 'peer-project');
  mkdirSync(peerProject);
  // Creation occurs in a real second engine process with a different FC_HOME.
  // The admitting process never selects or ensures this store.
  const other = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { ensureGlobalRunsDir } from './src/store.ts';
    import { createRun } from './spec/test-support/create-run.ts';
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    ensureGlobalRunsDir();
    let other;
    if (${layout} === 1) {
      other = join(process.env.FC_HOME, 'runs', 'legacy-fixture'); mkdirSync(other);
      const record = JSON.parse(readFileSync(${JSON.stringify(join(run, 'run.json'))}, 'utf8'));
      delete record.storageLayout;
      writeFileSync(join(other, 'run.json'), JSON.stringify({ ...record, runId: 'legacy-fixture', projectDir: ${JSON.stringify(peerProject)} }));
    } else other = createRun(${JSON.stringify(peerProject)}, 'fixture', 'name: fixture\\nstages: []\\n', ['work']).runDirPath;
    process.stdout.write(other);
  `], { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: join(project, 'alternate-store') }, encoding: 'utf8' });
  // Select the actual historical carrier, not runRecordPath's positive layout
  // cache: the independent replay also creates it with the exact base build.
  const carrier = join(other!, ...(layout === 2 ? ['engine'] : []), 'workflow.yaml');
  writeFileSync(carrier, 'trusted peer workflow');
  for (const route of ['direct', 'symlink', 'hardlink', 'directory-hardlink', 'ancestor', 'future'] as const) {
    let output = carrier, outputRoot: 'run' | 'project' = 'project', kind: 'file' | 'directory' = 'file';
    if (route === 'symlink') {
      output = join(project, `layout-${layout}-alias`); symlinkSync(carrier, output);
    } else if (route === 'hardlink' || route === 'directory-hardlink') {
      outputRoot = 'run'; output = stageWorkPath(run, `layout-${layout}-${route}`);
      if (route === 'directory-hardlink') { kind = 'directory'; mkdirSync(output); }
      fs.linkSync(carrier, kind === 'directory' ? join(output, 'ordinary-result') : output);
    } else if (route === 'ancestor') { output = dirname(other!); kind = 'directory'; }
    else if (route === 'future') output = join(dirname(carrier), 'future-record');
    const artifactContract = { ...contract, produces: [{ id: 'result', root: outputRoot,
      path: relative(outputRoot === 'run' ? run : project, output), kind }] };
    expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [
      { id: 'work', depends_on: [], artifact_contract: artifactContract },
    ] }), route).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
    let invoked = false;
    const result = await runStage({ async run() {
      invoked = true;
      writeFileSync(carrier, 'counterfeit admitted plan');
      return { exitCode: 0, duration_ms: 1, output: '{}' };
    } }, { stageId: 'work', projectDir: project, runDir: run, runId, role, dependsOn: [],
      promptTemplate: 'Write the declared result.', timeout_ms: 10000, retries: 0,
      artifactContract, outputSchema: { type: 'object' } });
    expect(result.exitCode, route).toBe(125);
    expect(invoked, route).toBe(false);
    expect(readFileSync(carrier, 'utf8'), route).toBe('trusted peer workflow');
  }
});

it('admits ordinary outputs and proven work hardlinks beside a foreign run envelope', () => {
  const store = fcGlobalDir(), peerProject = join(root, 'peer-project'); mkdirSync(peerProject);
  let other: string;
  try {
    setFcGlobalDir(join(project, 'alternate-store'));
    other = createRun(peerProject, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
  } finally { setFcGlobalDir(store); }
  const source = stageWorkPath(other!, 'ordinary-source'); writeFileSync(source, 'stage-owned result');
  const result = stageWorkPath(run, 'ordinary-result'); fs.linkSync(source, result);
  const ordinary = join(project, 'engine'); mkdirSync(ordinary);
  writeFileSync(join(ordinary, 'run.json'), JSON.stringify({ runId: 'unbound', projectDir: peerProject }));
  const stages = [{ id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
    { id: 'alias', root: 'run' as const, path: 'work/ordinary-result', kind: 'file' as const },
    { id: 'source', root: 'project' as const, path: relative(project, source), kind: 'file' as const },
    { id: 'ordinary', root: 'project' as const, path: 'engine', kind: 'directory' as const },
  ] } }];
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages })).toEqual([]);
  expect(readFileSync(result, 'utf8')).toBe('stage-owned result');
});


it.each(['project', 'run'] as const)('lets successive stages use captured run metadata in %s outputs', async outputRoot => {
  const base = outputRoot === 'run' ? stageWorkPath(run) : project;
  // Matching the captured runId as well as an arbitrary evidence name must
  // remain stage data: neither record contents nor directory spelling owns it.
  const directories = ['evidence-case', runId].map(name => join(base, name));
  const options = { projectDir: project, runDir: run, runId, role, timeout_ms: 10000,
    retries: 0, outputSchema: { type: 'object' }, promptTemplate: 'Use the captured evidence.' };
  const capture = await runStage({ async run() {
    const result = await child(`const fs=require('node:fs'),path=require('node:path');
      for(const dir of ${JSON.stringify(directories)}) {
        fs.mkdirSync(dir); fs.copyFileSync(${JSON.stringify(join(run, 'run.json'))},path.join(dir,'run.json'));
        fs.writeFileSync(path.join(dir,'observation.txt'),'observed');
      }`);
    return { ...result, output: '{}' };
  } }, { ...options, stageId: 'work', dependsOn: [], artifactContract: contract });
  expect(capture.exitCode, capture.friendlyError).toBe(0);
  const captured = directories.map(directory => readFileSync(join(directory, 'run.json')));
  for (const record of captured) expect(JSON.parse(record.toString())).toMatchObject({ runId, storageLayout: 2 });
  const observations = directories.map(directory => join(directory, 'observation.txt'));
  for (const observation of observations) expect(fs.statSync(observation).nlink).toBe(1);
  const artifactContract = { ...contract, produces: directories.flatMap((directory, index) => [
    { id: `observation_${index}`, root: outputRoot, path: relative(outputRoot === 'run' ? run : project, join(directory, 'observation.txt')), kind: 'file' as const },
    { id: `metadata_${index}`, root: outputRoot, path: relative(outputRoot === 'run' ? run : project, join(directory, 'run.json')), kind: 'file' as const },
  ]) };
  const findings = artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [
    { id: 'review', depends_on: ['work'], artifact_contract: artifactContract },
    { id: 'work', depends_on: [], artifact_contract: contract },
  ] });
  let invoked = false;
  const review = await runStage({ async run() {
    invoked = true;
    const result = await child(`const fs=require('node:fs');
      for(const file of ${JSON.stringify(observations)}) fs.appendFileSync(file,' and reused');`);
    return { ...result, output: '{}' };
  } }, { ...options, stageId: 'review', dependsOn: ['work'], artifactContract });
  expect({ captureExit: capture.exitCode, reviewExit: review.exitCode, invoked }, review.friendlyError)
    .toEqual({ captureExit: 0, reviewExit: 0, invoked: true });
  expect(findings).toEqual([]);
  for (const [index, directory] of directories.entries()) {
    expect(readFileSync(join(directory, 'run.json'))).toEqual(captured[index]);
    expect(readFileSync(join(directory, 'observation.txt'), 'utf8')).toBe('observed and reused');
  }
});

it('refuses a genuine alternate store namespace before a run record exists', () => {
  const store = fcGlobalDir();
  try {
    setFcGlobalDir(join(project, 'alternate-store'));
    createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  } finally { setFcGlobalDir(store); }
  const artifactContract = { ...contract, produces: [{ id: 'result', root: 'project' as const,
    path: 'alternate-store/runs/future-run/future-record', kind: 'file' as const }] };
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [
    { id: 'work', depends_on: [], artifact_contract: artifactContract },
  ] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
});


it('refuses a foreign engine hardlink inside the project without discovering its records', () => {
  const foreign = join(project, 'independent-store', 'runs');
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { ensureGlobalRunsDir } from './src/store.ts'; ensureGlobalRunsDir();"],
  { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: dirname(foreign) } });
  const carrier = join(foreign, 'record'); engineFs.writeFileSync(carrier, 'trusted foreign record');
  fs.linkSync(carrier, stageWorkPath(run, 'foreign-alias'));
  for (const outputRoot of ['run', 'project'] as const) {
    const output = outputRoot === 'run' ? 'work/foreign-alias' : 'independent-store/runs/record';
    expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [
      { id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [
        { id: 'result', root: outputRoot, path: output, kind: 'file' },
      ] } },
    ] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
  }
  expect(readFileSync(carrier, 'utf8')).toBe('trusted foreign record');
});


it.each(['project', 'run'] as const)('admits a stage file hardlinked across project and work through the %s declaration', outputRoot => {
  const source = join(project, 'ordinary-stage-file'); writeFileSync(source, 'stage data');
  fs.linkSync(source, stageWorkPath(run, 'ordinary-stage-file'));
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
    id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
      id: 'result', root: outputRoot, path: outputRoot === 'run' ? 'work/ordinary-stage-file' : 'ordinary-stage-file', kind: 'file',
    }] },
  }] })).toEqual([]);
});

it.each(['project', 'run'] as const)('refuses a stage file with an unaccounted foreign hardlink through the %s declaration', outputRoot => {
  const source = join(project, 'ordinary-stage-file'); writeFileSync(source, 'stage data');
  fs.linkSync(source, stageWorkPath(run, 'ordinary-stage-file'));
  fs.linkSync(source, join(root, 'foreign-link'));
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
    id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
      id: 'result', root: outputRoot, path: outputRoot === 'run' ? 'work/ordinary-stage-file' : 'ordinary-stage-file', kind: 'file',
    }] },
  }] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
});


it('refuses a separately created store nested inside the current stage work tree', () => {
  const nested = stageWorkPath(run, 'nested-store');
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { ensureGlobalRunsDir } from './src/store.ts'; ensureGlobalRunsDir();"],
  { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: nested } });
  const carrier = join(nested, 'runs', 'record'); writeFileSync(carrier, 'nested engine record');
  expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
    id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
      id: 'result', root: 'run', path: relative(run, carrier), kind: 'file',
    }] },
  }] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
});

it.each(['file', 'directory'] as const)('refuses a %s grant containing the private engine registry inside a project', kind => {
  const previousRegistry = process.env.FC_STORE_REGISTRY;
  const container = join(project, 'registry-container');
  process.env.FC_STORE_REGISTRY = join(container, 'registry');
  try {
    ensureGlobalRunsDir();
    const record = fs.readdirSync(process.env.FC_STORE_REGISTRY).find(name => name.endsWith('.json'))!;
    const output = kind === 'directory' ? container : join(process.env.FC_STORE_REGISTRY, record);
    expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
      id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
        id: 'result', root: 'project', path: relative(project, output), kind,
      }] },
    }] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
  } finally {
    if (previousRegistry === undefined) delete process.env.FC_STORE_REGISTRY;
    else process.env.FC_STORE_REGISTRY = previousRegistry;
  }
});


it('admits independent engine store registration while a stage is running', async () => {
  const independent = join(root, 'concurrent-store');
  await expect(withEngineIntegrity(input(), async () => {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import { ensureGlobalRunsDir } from './src/store.ts'; ensureGlobalRunsDir();"],
    { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: independent } });
    return 'stage result';
  })).resolves.toBe('stage result');
  expect(fs.statSync(join(independent, 'runs')).isDirectory()).toBe(true);
});


it('refuses foreign engine store namespaces outside runs without reading their contents', () => {
  const independent = join(project, 'alternate-store');
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { ensureGlobalRunsDir } from './src/store.ts'; ensureGlobalRunsDir();"],
  { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: independent } });
  const carrier = join(independent, 'control-ledger');
  writeFileSync(carrier, 'engine-owned bytes');
  for (const output of [carrier, join(independent, 'future-namespace', 'record')]) {
    expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
      id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
        id: 'result', root: 'project', path: relative(project, output), kind: 'file',
      }] },
    }] })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
  }
  expect(readFileSync(carrier, 'utf8')).toBe('engine-owned bytes');
});
