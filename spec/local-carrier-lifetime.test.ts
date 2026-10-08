import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execWithStdin } from '../src/adapters/base.js';
import { ArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { captureStageArtifactContractPreimages, inspectStageArtifactContract, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { createRun, captureStageEvidence, readRunState, RUN_HISTORY_FILE, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { engineChildAdapterHome, execEngineChildSync, spawnEngineChild, withEngineCommandBoundary, withEngineWriteBoundary } from '../src/write-boundary.js';
import { resolveCodexCapabilityIdentity, writeCodexConfig } from '../src/adapters/codex.js';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { runValidationCommand } from '../src/project-validation.js';
import { runAllChecks } from '../src/reality-gate/index.js';
import { generateRunSummary } from '../src/run-summary.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-local-carrier-spec-')); roots.push(root);
  const projectDir = join(root, 'project'); mkdirSync(projectDir);
  setFcGlobalDir(join(root, 'store'));
  const runId = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['writer']).runId;
  const directory = runDir(projectDir, runId);
  const evidence = captureStageEvidence(projectDir, runId, 1, 'writer', { status: 'complete', retries: 0 });
  updateRunState(projectDir, runId, (state) => { state.stageEvidence = [evidence]; });
  const artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'notes', root: 'run', path: 'notes', kind: 'directory' }], reads: [], replays: [] });
  return { root, projectDir, runId, runDir: directory, stageId: 'writer', artifactContract };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const native = process.platform === 'linux' ? it : it.skip;
const roleStage = (artifactContract: ReturnType<typeof ArtifactContractSchema.parse>) => ({ id: 'writer', depends_on: [], artifact_contract: artifactContract });
const child = (body: string) => `const fs=require('node:fs');const path=require('node:path');${body}`;

describe('engine-owned local carrier lifetime', () => {
  it.each(['canonical', 'symlink', 'future_symlink', 'hardlink'])('refuses scheduler identity through %s at declaration admission', (route) => {
    const f = fixture(), identity = join(f.runDir, 'scheduler.identity.json'), path = route === 'canonical' ? 'scheduler.identity.json' : 'alias';
    if (route !== 'future_symlink') writeFileSync(identity, '{}');
    if (route.includes('symlink')) symlinkSync('scheduler.identity.json', join(f.runDir, path));
    if (route === 'hardlink') linkSync(identity, join(f.runDir, path));
    const contract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'out', root: 'run', path }], reads: [], replays: [] });
    expect(inspectArtifactDeclarations({ stages: [roleStage(contract)], scopeOwns: () => true, projectDir: f.projectDir, runDir: f.runDir }).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
  });

  native('denies fresh alias, hardlink, rename and unlink routes after native acknowledgement; permits legitimate directory publication', async () => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE);
    let ready = false;
    const execution = withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`
      const run=${JSON.stringify(f.runDir)}, project=${JSON.stringify(f.projectDir)};
      fs.writeFileSync(path.join(run,'notes/tmp'),'ordinary');fs.renameSync(path.join(run,'notes/tmp'),path.join(run,'notes/result'));
      console.log('ready');const poll=setInterval(()=>{if(!fs.existsSync(path.join(project,'continue')))return;clearInterval(poll);
        const attempts=[];for(const [name,fn] of [
          ['symlink',()=>{fs.symlinkSync(${JSON.stringify(history)},path.join(run,'notes/link'));fs.writeFileSync(path.join(run,'notes/link'),'bad')}],
          ['hardlink',()=>fs.linkSync(${JSON.stringify(history)},path.join(run,'notes/hard'))],
          ['rename',()=>fs.renameSync(path.join(run,'notes/result'),${JSON.stringify(history)})],
          ['unlink',()=>fs.unlinkSync(${JSON.stringify(history)})]
        ]){try{fn();attempts.push({name,refused:false})}catch(e){attempts.push({name,refused:true,code:e.code})}}
        console.log(JSON.stringify({attempts,history:fs.readFileSync(${JSON.stringify(history)},'utf8')}));
      },10);
    `)], '', { cwd: f.projectDir, timeout_ms: 10_000, onStdout: (text) => { if (text.includes('ready')) ready = true; } }));
    const deadline = Date.now() + 7_000;
    while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toBe(true);
    const evidence = captureStageEvidence(f.projectDir, f.runId, 2, 'writer', { status: 'complete', retries: 0 });
    updateRunState(f.projectDir, f.runId, (state) => { state.stageEvidence!.push(evidence); });
    const acknowledged = readFileSync(history, 'utf8');
    writeFileSync(join(f.projectDir, 'continue'), 'go');
    const result = await execution;
    expect(result.exitCode).toBe(0); expect(result.writeBoundary?.kind).toBe('installed');
    const observed = JSON.parse(result.output.trim().split('\n').at(-1)!);
    expect(observed.attempts).toHaveLength(4); expect(observed.attempts.every((x: { refused: boolean }) => x.refused)).toBe(true);
    expect(observed.attempts.find((x: { name: string }) => x.name === 'hardlink').code).toBe('EXDEV');
    expect(observed.history).toBe(acknowledged); expect(readFileSync(history, 'utf8')).toBe(acknowledged);
    expect(readRunState(f.projectDir, f.runId).stageEvidence).toHaveLength(2);
    expect(readFileSync(join(f.runDir, 'notes/result'), 'utf8')).toBe('ordinary');
  });

  native('refuses unknown writable hard-link closure before the executable runs', async () => {
    const f = fixture(), source = join(f.projectDir, 'linked'), ran = join(f.projectDir, 'ran');
    writeFileSync(source, 'unknown'); linkSync(source, join(f.root, 'outside'));
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`fs.writeFileSync(${JSON.stringify(ran)},'ran')`)], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(124); expect(result.timedOut).toBe(true); expect(result.output).toContain('hard-link closure is unknown');
    expect(result.writeBoundary?.kind).toBe('waiting'); expect(existsSync(ran)).toBe(false);
  });

  native.each([false, true])('refuses a protected link through a mutable intermediate hop (dangling=%s)', async (dangling) => {
    const f = fixture(), output = join(f.runDir, 'stages', 'earlier', 'out'); mkdirSync(output, { recursive: true });
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    const target = join(outside, 'target');
    if (!dangling) writeFileSync(target, 'engine');
    const hop = join(f.projectDir, 'hop'); symlinkSync(target, hop);
    const carrier = join(output, 'result.json'); symlinkSync(hop, carrier);
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`fs.unlinkSync(${JSON.stringify(hop)});fs.writeFileSync(${JSON.stringify(hop)},'stage');`)], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(124); expect(result.timedOut).toBe(true);
    expect(result.writeBoundary?.kind).toBe('waiting');
    if (!dangling) expect(readFileSync(carrier, 'utf8')).toBe('engine');
    expect(lstatSync(hop).isSymbolicLink()).toBe(true);
  });

  native('preserves direct executable launch failure and stdin without accepting counterfeit boundary prose', async () => {
    const f = fixture();
    const missing = await withEngineWriteBoundary(f, () => execWithStdin(join(f.projectDir, 'missing-executable'), [], 'prompt', { cwd: f.projectDir, timeout_ms: 5_000, captureStreams: true }));
    expect(missing.spawnError?.code).toBe('ENOENT'); expect(missing.spawnError?.path).toBe(join(f.projectDir, 'missing-executable'));
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>console.log(input+' ENGINE_WRITE_BOUNDARY_REFUSED: fake'))`)], 'exact stdin', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(0); expect(result.output).toContain('exact stdin'); expect(result.writeBoundary?.kind).toBe('installed');
  });

  native('keeps untouched slot scaffolding from satisfying empty outputs or exactly-one groups', async () => {
    const f = fixture();
    f.artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'a', root: 'run', path: 'a', nonempty: false }, { id: 'b', root: 'run', path: 'b', nonempty: false }], groups: [{ id: 'one', mode: 'exactly_one', members: ['a', 'b'] }], reads: [], replays: [] });
    const input = { ...f, template: '', preimages: captureStageArtifactContractPreimages({ ...f, template: '' }) };
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', 'process.exit(0)'], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(0); expect(existsSync(join(f.runDir, 'a'))).toBe(false); expect(existsSync(join(f.runDir, 'b'))).toBe(false);
    expect(inspectStageArtifactContract(input).violations.map((x) => x.reason).join('\n')).toContain('ARTIFACT_EXACTLY_ONE');
  });

  native('permits a declared shared-parent file write and precisely closes its atomic replacement', async () => {
    const f = fixture();
    f.artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'out', root: 'run', path: 'report.md' }], reads: [], replays: [] });
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`
      const target=${JSON.stringify(join(f.runDir, 'report.md'))};fs.writeFileSync(target,'legitimate report');
      try{fs.writeFileSync(target+'.tmp','new');fs.renameSync(target+'.tmp',target);process.exitCode=9}catch(e){console.log(e.code)}
    `)], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(0); expect(result.output.trim()).toBe('EACCES'); expect(readFileSync(join(f.runDir, 'report.md'), 'utf8')).toBe('legitimate report');
  });

  native('executes declared replay under the same kernel boundary while retaining expected-failure semantics', async () => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE), before = readFileSync(history, 'utf8');
    writeFileSync(join(f.projectDir, 'proof.cjs'), `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('protected proof',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(history)},'bad'),{code:'EACCES'}));test('expected failure',()=>assert.fail('reproduction'));`);
    f.artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [], reads: [{ id: 'proof', root: 'project', path: 'proof.cjs', source: { kind: 'input' } }], replays: [{ id: 'proof', runner: 'node_test', targets: ['proof'], argv: [], expected: { exit_code: 1, failures: [{ artifact: 'proof', test: 'expected failure' }] } }] });
    const audit = await verifyStageArtifactContract({ ...f, template: '' }, { remainingMs: () => 8_000 });
    expect(audit.violations).toEqual([]); expect(audit.replayExecutions[0].status).toBe('passed'); expect(readFileSync(history, 'utf8')).toBe(before);
  });

  native('retains gate verdict authority through replay without modifying its authored failing verdict', async () => {
    const f = fixture(), verdict = join(f.runDir, 'verdict_writer.json');
    writeFileSync(verdict, '{"pass":false,"reason":"reproduced"}\n');
    writeFileSync(join(f.projectDir, 'proof.cjs'), `const test=require('node:test');const assert=require('node:assert/strict');test('expected failure',()=>assert.fail('reproduction'));`);
    f.artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_writer.json' }], reads: [{ id: 'proof', root: 'project', path: 'proof.cjs', source: { kind: 'input' } }], replays: [{ id: 'proof', runner: 'node_test', targets: ['proof'], argv: [], expected: { exit_code: 1, failures: [{ artifact: 'proof', test: 'expected failure' }] } }] });
    const audit = await verifyStageArtifactContract({ ...f, isGate: true, template: '', writes: ['run:verdict_writer.json'] }, { remainingMs: () => 8_000 });
    expect(audit.violations).toEqual([]); expect(audit.replayExecutions[0].status).toBe('passed'); expect(JSON.parse(readFileSync(verdict, 'utf8')).pass).toBe(false);
  });

  native('cannot weaken carrier protection through a directory view in the writable project', async () => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE), before = readFileSync(history, 'utf8');
    symlinkSync(f.runDir, join(f.projectDir, 'view'), 'dir');
    const result = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', child(`try{fs.writeFileSync(${JSON.stringify(join(f.projectDir, 'view', RUN_HISTORY_FILE))},'bad');process.exitCode=9}catch(e){console.log(e.code)}`)], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(result.exitCode).toBe(0); expect(result.output.trim()).toBe('EACCES'); expect(readFileSync(history, 'utf8')).toBe(before);
  });

  it('retains known corrupt scheduler identity as unknown consumer fate', async () => {
    const f = fixture();writeFileSync(join(f.runDir, 'scheduler.pid'), String(process.pid));writeFileSync(join(f.runDir, 'scheduler.identity.json'), '{');
    const { inspectRunScheduler } = await import('../src/run-lock.js');expect(inspectRunScheduler(f.runId, f.runDir).kind).toBe('corrupt');
  });

  native('never launches the adapter binary to learn its version inside a stage boundary', async () => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE), before = readFileSync(history, 'utf8'), executable = join(f.projectDir, 'version-probe'), ran = join(f.projectDir, 'ran');
    writeFileSync(executable, `#!${process.execPath}\n${child(`fs.writeFileSync(${JSON.stringify(ran)},'ran');try{fs.writeFileSync(${JSON.stringify(history)},'bad')}catch{};console.log('version')`)}`); chmodSync(executable, 0o755);
    const identity = () => resolveCodexCapabilityIdentity({ model: 'fixture', reasoning_effort: 'low' }, { executable }).version;
    const versions = await withEngineWriteBoundary(f, async () => [identity(), identity()]);
    expect(versions[0]).toMatch(/^fingerprint:/); expect(versions[1]).toBe(versions[0]);
    expect(existsSync(ran)).toBe(false); expect(readFileSync(history, 'utf8')).toBe(before);
    expect(existsSync(join(f.runDir, 'stages', f.stageId, 'write_boundary_attempt_0.jsonl'))).toBe(false);
    expect(identity()).toBe('version'); rmSync(ran);
    expect(await withEngineWriteBoundary(f, async () => identity())).toBe('version');
    expect(existsSync(ran)).toBe(false);
    writeFileSync(executable, `${readFileSync(executable, 'utf8')}\n// replaced binary`);
    const replaced = await withEngineWriteBoundary(f, async () => identity());
    expect(replaced).toMatch(/^fingerprint:/); expect(replaced).not.toBe(versions[0]); expect(existsSync(ran)).toBe(false);
  });

  native('gives observer calls read-only project access and private adapter state without request authority', async () => {
    const f = fixture();
    await withEngineWriteBoundary({ ...f, stageId: '_supervisor', authority: 'observer', artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [], reads: [], replays: [] }) }, async () => {
      const result = await execWithStdin(process.execPath, ['-e', child(`
        const refused=[];for(const name of ${JSON.stringify([join(f.projectDir, 'unexpected'), join(f.runDir, RUN_HISTORY_FILE), join(f.runDir, 'knowledge_graph.json'), join(f.runDir, 'stages/_supervisor/approval_request.json')])}){try{fs.writeFileSync(name,'bad');refused.push(false)}catch(e){refused.push(e.code==='EACCES')}}
        fs.writeFileSync(${JSON.stringify(join(f.runDir, 'stages/_supervisor/codex_home/private'))},'private');console.log(JSON.stringify(refused));
      `)], '', { cwd: f.projectDir, timeout_ms: 5_000 });
      expect(result.exitCode).toBe(0); expect(result.writeBoundary?.kind).toBe('installed'); expect(JSON.parse(result.output)).toEqual([true, true, true, true]);
    });
  });

  native('refuses a timed-out synchronous probe and stops its owned descendant group', async () => {
    const f = fixture(), delayed = join(f.projectDir, 'delayed-write'), started = join(f.projectDir, 'probe-started');
    await withEngineWriteBoundary(f, async () => {
      expect(() => execEngineChildSync(process.execPath, ['-e', `
        require('node:fs').writeFileSync(${JSON.stringify(started)},'started');
        require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayed)},'late'),1000)`)}]);
        setTimeout(()=>{},5000);
      `], 300)).toThrow('ENGINE_WRITE_BOUNDARY_UNVERIFIED');
      expect(existsSync(started)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(existsSync(delayed)).toBe(false);
    });
  });

  native('hydrates mutable private Codex caches while keeping shared cache bytes read-only', async () => {
    const f = fixture(), shared = join(f.root, 'shared-cache'), sourceHome = join(f.root, 'source-home');mkdirSync(shared);mkdirSync(sourceHome);writeFileSync(join(shared, 'asset'), 'shared');
    try {
      vi.stubEnv('CODEX_HOME', sourceHome);
      vi.stubEnv('CODEX_PLUGINS_CACHE', shared);
      vi.stubEnv('CODEX_SKILLS_CACHE', shared);
      await withEngineWriteBoundary(f, async () => {
        const home = engineChildAdapterHome()!;
        mkdirSync(join(home, '.tmp'));symlinkSync(shared, join(home, '.tmp/plugins'));symlinkSync(shared, join(home, 'skills'));
        writeCodexConfig(home, { name: 'fixture', description: 'fixture', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'fixture' });
        expect(lstatSync(join(home, 'skills')).isSymbolicLink()).toBe(false);
        const result = await execWithStdin(process.execPath, ['-e', child(`fs.writeFileSync(${JSON.stringify(join(home, '.tmp/plugins/asset'))},'private');fs.writeFileSync(${JSON.stringify(join(home, 'skills/asset'))},'private');`)], '', { cwd: f.projectDir, timeout_ms: 5_000 });
        expect(result.exitCode).toBe(0); expect(readFileSync(join(shared, 'asset'), 'utf8')).toBe('shared');
      });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('auxiliary command carrier boundaries', () => {

  native.each(['validation', 'reality'])('confines actual %s execution while permitting configured project output', async (route) => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE), prefix = readFileSync(history, 'utf8');
    const code = child(`try{fs.writeFileSync(${JSON.stringify(history)},'bad');process.exitCode=9}catch(e){if(e.code!=='EACCES')throw e}fs.writeFileSync('generated','legitimate')`);
    if (route === 'validation') {
      const result = await runValidationCommand({ role: 'test', command: process.execPath, args: ['-e', code], display: 'owned', cwd: f.projectDir, runDir: f.runDir });
      expect(result.error).toBeUndefined(); expect(result.exitCode).toBe(0);
    } else {
      const script = join(f.projectDir, 'probe.cjs'); writeFileSync(script, code);
      const result = await runAllChecks([{ name: 'owned', type: 'exec-script-exit-zero', reads: [], params: { script: `'${process.execPath}' '${script}'`, timeout_seconds: 5 } }], { projectDir: f.projectDir, taskDir: f.runDir });
      expect(result.pass).toBe(true);
    }
    expect(readFileSync(join(f.projectDir, 'generated'), 'utf8')).toBe('legitimate');
    expect(readFileSync(history, 'utf8')).toBe(prefix); expect(readRunState(f.projectDir, f.runId).stageEvidence).toHaveLength(1);
  });

  native.each(['summary'])('binds actual %s adapter calls with the appropriate output authority', async (route) => {
    const f = fixture(), history = join(f.runDir, RUN_HISTORY_FILE), prefix = readFileSync(history, 'utf8');
    updateRunState(f.projectDir, f.runId, (state) => { state.status = 'complete'; });
    const writable = route === 'scout';
    const code = child(`let historyDenied=false,projectDenied=false;try{fs.writeFileSync(${JSON.stringify(history)},'bad')}catch(e){historyDenied=e.code==='EACCES'}try{fs.writeFileSync('literature_scan.md','legitimate')}catch(e){projectDenied=e.code==='EACCES'}if(!historyDenied||projectDenied===${writable})process.exitCode=9;console.log(JSON.stringify({new_directions:['owned'],next_direction:'owned'}))`);
    const adapter = { run: () => execWithStdin(process.execPath, ['-e', code], '', { cwd: f.projectDir, timeout_ms: 5_000 }) } as unknown as Adapter;
    if (route === 'summary') expect(await generateRunSummary(f.projectDir, f.runId, adapter)).toContain('"new_directions":["owned"]');
    expect(existsSync(join(f.projectDir, 'literature_scan.md'))).toBe(writable);
    expect(readFileSync(history, 'utf8')).toBe(prefix); expect(readRunState(f.projectDir, f.runId).stageEvidence).toHaveLength(1);
  });

  native('refuses an unknown validation hard-link closure before executing project code', async () => {
    const f = fixture(), path = join(f.projectDir, 'linked'); writeFileSync(path, 'unknown'); linkSync(path, join(f.root, 'external'));
    mkdirSync(join(f.projectDir, 'config'));
    writeFileSync(join(f.projectDir, 'config', 'defaults.yaml'), 'default_validation_timeout_ms: 800\n');
    const result = await runValidationCommand({ role: 'test', command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('ran','ran')"], display: 'owned', cwd: f.projectDir, runDir: f.runDir });
    expect(result.exitCode).toBeNull(); expect(result.error).toContain('ENGINE_WRITE_BOUNDARY_WAITING:');
    expect(result.error).toContain('hard-link closure is unknown'); expect(existsSync(join(f.projectDir, 'ran'))).toBe(false);
  });

  native('gives project commands no request or knowledge-graph publication rights', async () => {
    const f = fixture();
    await withEngineCommandBoundary({ projectDir: f.projectDir, runDir: f.runDir, stageId: '_validation' }, async () => {
      const result = await execWithStdin(process.execPath, ['-e', child(`for(const p of ${JSON.stringify([join(f.runDir, 'knowledge_graph.json'), join(f.runDir, 'stages/_validation/approval_request.json')])}){try{fs.writeFileSync(p,'bad');process.exitCode=9}catch(e){if(e.code!=='EACCES')throw e}}`)], '', { cwd: f.projectDir, timeout_ms: 5_000 });
      expect(result.exitCode).toBe(0); expect(result.writeBoundary?.kind).toBe('installed');
    });
  });

  native('authenticates raw launch authority and stops its owned leftover descendants', async () => {
    const f = fixture(), delayed = join(f.projectDir, 'delayed');
    expect(() => spawnEngineChild(process.execPath, [], { cwd: f.projectDir })).toThrow('requires runtime authority');
    await withEngineCommandBoundary({ projectDir: f.projectDir, runDir: f.runDir, stageId: '_validation' }, () => new Promise<void>((resolve, reject) => {
      const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayed)},'late'),600)`)}],{stdio:'ignore'}).unref()`;
      const launch = spawnEngineChild(process.execPath, ['-e', code], { cwd: f.projectDir });
      launch.child.once('error', reject); launch.child.once('close', (code) => { expect(code).toBe(0); expect(launch.boundaryError()).toBeUndefined(); resolve(); });
    }));
    await new Promise((resolve) => setTimeout(resolve, 800)); expect(existsSync(delayed)).toBe(false);
  });
});
