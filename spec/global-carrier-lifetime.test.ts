import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { execWithStdin } from '../src/adapters/base.js';
import { engineOwnedGlobalCarriers, isEngineOwnedGlobalPath } from '../src/engine-owned-carriers.js';
import { resourceLeaseRegistryPath } from '../src/resource-leases.js';
import { recordedResourceRegistry, appendRecordedResourceLease } from './test-support/recorded-resource-registry.js';
import { readRunIndexRecords, removeRunIndexFiles } from '../src/run-index.js';
import { captureStageEvidence, createRun, readRunState, RUN_HISTORY_FILE, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { withEngineWriteBoundary } from '../src/write-boundary.js';

const cleanups: Array<() => void> = [];
const carriers = ['resource-leases.v1.sqlite', 'run-index.sqlite'];
const native = process.platform === 'linux' ? it : it.skip;
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-global-carrier-spec-'));
  const projectDir = join(root, 'project'), fc = join(root, 'store'); mkdirSync(projectDir);
  setFcGlobalDir(fc);
  const runId = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['writer']).runId;
  cleanups.push(() => { removeRunIndexFiles(projectDir); rmSync(root, { recursive: true, force: true }); });
  const directory = runDir(projectDir, runId);
  const evidence = captureStageEvidence(projectDir, runId, 1, 'writer', { status: 'complete', retries: 0 });
  updateRunState(projectDir, runId, (state) => { state.stageEvidence = [evidence]; });
  const registry = recordedResourceRegistry(resourceLeaseRegistryPath(fc));
  appendRecordedResourceLease(registry.path, runId);
  return { root, projectDir, runId, runDir: directory, fc, registry, stageId: 'writer' };
}
function contract(root: 'project' | 'run', path: string, kind: 'file' | 'directory' = 'file') {
  return ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'out', root, path, kind }], reads: [], replays: [] });
}
function admission(f: ReturnType<typeof fixture>, artifactContract: ReturnType<typeof contract>) {
  return inspectArtifactDeclarations({ stages: [{ id: 'writer', depends_on: [], artifact_contract: artifactContract }], scopeOwns: () => true, projectDir: f.projectDir, runDir: f.runDir });
}
const roots = ['project', 'run'] as const;

describe('engine-owned global SQLite carrier lifetime', () => {
  it.each(carriers.flatMap((carrier) => roots.map((root) => ({ carrier, root }))))('refuses the existing $carrier hardlink from $root at admission', ({ carrier, root }) => {
    const f = fixture(), file = join(f.fc, carrier), before = readFileSync(file);
    linkSync(file, join(root === 'run' ? f.runDir : f.projectDir, 'declared'));
    expect(admission(f, contract(root, 'declared')).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
    expect(readFileSync(file)).toEqual(before);
    expect(f.registry.read().status).toBe('available');
    expect(readRunIndexRecords(f.projectDir)?.some((row) => row.runId === f.runId)).toBe(true);
  });

  native.each(carriers.flatMap((carrier) => roots.map((root) => ({ carrier, root }))))('denies late links and replacement of $carrier from $root while allowing ordinary publication', async ({ carrier, root }) => {
    const f = fixture(), file = join(f.fc, carrier), directory = join(root === 'run' ? f.runDir : f.projectDir, 'notes'); mkdirSync(directory);
    const before = readFileSync(file), history = readFileSync(join(f.runDir, RUN_HISTORY_FILE));
    const artifactContract = contract(root, 'notes', 'directory');
    const result = await withEngineWriteBoundary({ ...f, artifactContract }, () => execWithStdin(process.execPath, ['-e', `
      const fs=require('node:fs'),out=[];
      function attempt(name,action){try{action();out.push([name,'wrote'])}catch(e){out.push([name,e.code])}}
      attempt('link',()=>fs.linkSync(${JSON.stringify(file)},${JSON.stringify(join(directory, 'alias'))}));
      fs.writeFileSync(${JSON.stringify(join(directory, 'ordinary'))},'ordinary');
      attempt('rename',()=>fs.renameSync(${JSON.stringify(join(directory, 'ordinary'))},${JSON.stringify(file)}));
      attempt('write',()=>fs.writeFileSync(${JSON.stringify(file)},'bad'));
      attempt('history',()=>fs.writeFileSync(${JSON.stringify(join(f.runDir, RUN_HISTORY_FILE))},'bad'));
      console.log(JSON.stringify(out));
    `], '', { cwd: f.projectDir, timeout_ms: 5000 }));
    expect(result.exitCode).toBe(0); expect(result.writeBoundary?.kind).toBe('installed');
    const attempts = JSON.parse(result.output) as Array<[string, string]>;
    expect(attempts).toContainEqual(['link', 'EXDEV']);
    expect(attempts).toContainEqual(['write', 'EACCES']);
    expect(attempts).toContainEqual(['history', 'EACCES']);
    expect(['EACCES', 'EXDEV']).toContain(attempts.find(([name]) => name === 'rename')?.[1]);
    expect(readFileSync(join(directory, 'ordinary'), 'utf8')).toBe('ordinary');
    expect(readFileSync(file)).toEqual(before); expect(readFileSync(join(f.runDir, RUN_HISTORY_FILE))).toEqual(history);
    expect(readRunState(f.projectDir, f.runId).stageEvidence).toHaveLength(1);
  });

  native.each(carriers)('preserves live $carrier WAL/SHM identities and future companion names', async (carrier) => {
    const f = fixture(), main = join(f.fc, carrier), db = new DatabaseSync(main);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      if (carrier.startsWith('resource')) db.exec("UPDATE resource_registry SET data=data||' '");
      else db.exec('UPDATE runs SET updated_at=updated_at+1');
      const companions = ['-wal', '-shm'].map((suffix) => main + suffix);
      expect(companions.every(existsSync)).toBe(true);
      const bytes = companions.map((path) => readFileSync(path));
      const targets = [main, ...companions, main + '-journal', main + '-mj-owned'];
      const artifactContract = contract('run', 'notes', 'directory');
      const result = await withEngineWriteBoundary({ ...f, artifactContract }, () => execWithStdin(process.execPath, ['-e', `
        const fs=require('node:fs');const out=[];for(const name of ${JSON.stringify(targets)}){try{fs.writeFileSync(name,'bad');out.push('wrote')}catch(e){out.push(e.code)}}console.log(JSON.stringify(out));
      `], '', { cwd: f.projectDir, timeout_ms: 5000 }));
      expect(result.exitCode).toBe(0); expect(JSON.parse(result.output)).toEqual(targets.map(() => 'EACCES'));
      expect(companions.map((path) => readFileSync(path))).toEqual(bytes);
      expect(f.registry.read().status).toBe('available');
      expect(readRunIndexRecords(f.projectDir)?.some((row) => row.runId === f.runId)).toBe(true);
    } finally { db.close(); }
  });

  native('protects the real transient rollback journal while its native write transaction is live', async () => {
    const f = fixture(), db = new DatabaseSync(f.registry.path);
    try {
      db.exec("BEGIN IMMEDIATE; UPDATE resource_registry SET data=data||' '");
      const journal = f.registry.path + '-journal'; expect(existsSync(journal)).toBe(true);
      const before = readFileSync(journal);
      linkSync(journal, join(f.projectDir, 'journal-alias'));
      expect(admission(f, contract('project', 'journal-alias')).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
      rmSync(join(f.projectDir, 'journal-alias'));
      const result = await withEngineWriteBoundary({ ...f, artifactContract: contract('run', 'notes', 'directory') }, () => execWithStdin(process.execPath, ['-e', `try{require('node:fs').writeFileSync(${JSON.stringify(journal)},'bad');console.log('wrote')}catch(e){console.log(e.code)}`], '', { cwd: f.projectDir, timeout_ms: 5000 }));
      expect(result.exitCode).toBe(0); expect(result.output.trim()).toBe('EACCES'); expect(readFileSync(journal)).toEqual(before);
      db.exec('COMMIT'); expect(existsSync(journal)).toBe(false); expect(f.registry.read().status).toBe('available');
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  });

  native.each(roots.flatMap((root) => [false, true].map((future) => ({ root, future }))))('refuses a $root directory containing a trusted custom registry (future=$future)', async ({ root, future }) => {
    const f = fixture(), custom = join(root === 'run' ? f.runDir : f.projectDir, 'data', 'custom.sqlite');
    const registry = recordedResourceRegistry(custom, !future);
    const artifactContract = contract(root, 'data', 'directory');
    expect(admission(f, artifactContract).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
    await expect(withEngineWriteBoundary({ ...f, artifactContract }, () => execWithStdin(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(f.projectDir, 'ran'))},'ran')`], '', { cwd: f.projectDir, timeout_ms: 5000 }))).rejects.toThrow('ENGINE_WRITE_BOUNDARY_REFUSED');
    expect(existsSync(join(f.projectDir, 'ran'))).toBe(false);
    if (future) expect(existsSync(custom)).toBe(false);
    else expect(registry.read().status).toBe('available');
  });

  it('reserves registered SQLite companion names without initializing missing databases', () => {
    const f = fixture(), custom = join(f.projectDir, 'future', 'custom.sqlite'); recordedResourceRegistry(custom, false);
    expect(isEngineOwnedGlobalPath(custom + '-mj-owned', f.fc)).toBe(true);
    expect(engineOwnedGlobalCarriers(f.fc)).toContain(f.projectDir);
    expect(existsSync(custom)).toBe(false); expect(existsSync(join(f.projectDir, 'future'))).toBe(false);
    expect(admission(f, contract('project', 'future/custom.sqlite-wal')).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
  });

  it.each(['directory', 'file'])('recognizes future native SQLite targets enrolled through a %s symlink', (kind) => {
    const f = fixture(), target = join(f.projectDir, 'future', 'custom.sqlite');
    const alias = join(f.root, 'registered-alias');
    symlinkSync(kind === 'directory' ? f.projectDir : target, alias);
    recordedResourceRegistry(kind === 'directory' ? join(alias, 'future', 'custom.sqlite') : alias, false);
    expect(isEngineOwnedGlobalPath(target + '-wal', f.fc)).toBe(true);
    expect(admission(f, contract('project', 'future', 'directory')).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(f.projectDir, 'future'))).toBe(false);
  });

  native('preserves acknowledged rows and concurrent parent publication while a confined child reads live SQLite', async () => {
    const f = fixture(), notes = join(f.runDir, 'notes'), started = join(notes, 'started');
    const before = f.registry.read();
    if (before.status !== 'available') throw new Error('missing native registry');
    const artifactContract = contract('run', 'notes', 'directory');
    const running = withEngineWriteBoundary({ ...f, artifactContract }, () => execWithStdin(process.execPath, ['-e', `
      const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
      const names=${JSON.stringify(carriers.map((name) => join(f.fc, name)))};
      fs.writeFileSync(${JSON.stringify(started)},'started');
      let reads=0,denied=0;const until=Date.now()+800;
      function turn(){for(const name of names){
        const db=new DatabaseSync(name,{readOnly:true});
        try{db.exec('PRAGMA busy_timeout=2000');db.prepare(name.includes('resource-leases')?'SELECT data FROM resource_registry':'SELECT run_id FROM runs').all();reads++;}finally{db.close();}
        for(const suffix of ['','-wal','-shm','-journal','-mj-owned']){
          try{fs.writeFileSync(name+suffix,'bad');throw Error('write granted');}catch(e){if(e.code!=='EACCES')throw e;denied++;}
        }
      }if(Date.now()<until)setTimeout(turn,10);else{fs.writeFileSync(${JSON.stringify(join(notes, 'ordinary'))},'ordinary');console.log(JSON.stringify({reads,denied}));}}
      turn();
    `], '', { cwd: f.projectDir, timeout_ms: 5000 }));
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(started) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(existsSync(started)).toBe(true);
      for (let index = 0; index < 8; index++) {
        appendRecordedResourceLease(f.registry.path, f.runId);
        updateRunState(f.projectDir, f.runId, (state) => { state.taskDescription = `concurrent-${index}`; });
      }
      const result = await running;
      expect(result.exitCode, result.output).toBe(0);
      expect(result.writeBoundary?.kind).toBe('installed');
      const counts = JSON.parse(result.output.trim().split('\n').at(-1)!);
      expect(counts.reads).toBeGreaterThan(2);
      expect(counts.denied).toBe(counts.reads * 5);
      expect(readFileSync(join(notes, 'ordinary'), 'utf8')).toBe('ordinary');
      const after = f.registry.read();
      if (after.status !== 'available') throw new Error('missing native registry');
      expect(after.snapshot.leases[0]).toEqual(before.snapshot.leases[0]);
      expect(after.snapshot.history.slice(0, before.snapshot.history.length)).toEqual(before.snapshot.history);
      expect(after.snapshot.leases).toHaveLength(9);
      expect(after.snapshot.revision).toBe(before.snapshot.revision + 8);
      expect(readRunIndexRecords(f.projectDir)?.find((row) => row.runId === f.runId)?.taskDescription).toBe('concurrent-7');
      expect(readRunState(f.projectDir, f.runId).stageEvidence).toHaveLength(1);
    } finally { await running; }
  });
});
