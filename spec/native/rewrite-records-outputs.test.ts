import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashInputs, preserveOutputs, retainOutputs, verifyRuntime } from "../../dist-rewrite/records/content.js";
import { root, scope, hash, known, declarations, checkpoint, setScope, record } from './fixtures/rewrite-content.js';
describe('records content output preservation and runtime pin', () => {
  it.each(['create', 'update', 'append', 'replace'] as const)('archives %s output and retains current bytes independently of its checkpoint', async (existing) => {
    declarations([], [{ path: 'out', kind: 'file', existing }]);
    if (existing !== 'create') {
      await writeFile(join(scope.layout.project, 'out'), 'old');
      const baselines = known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration,
       inputs: [{ id: 'out', path: 'out', kind: 'file', frozen: false }] } } }));
      setScope({ ...scope, outputBaseline: baselines });
    }
    if (existing === 'create')
      setScope({ ...scope, outputBaseline: known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: {
       ...scope.brief.declaration, inputs: [{ id: 'out', path: 'out', kind: 'file', frozen: false }] } } })) });
    await writeFile(join(scope.layout.project, 'out'), existing === 'append' ? 'old-new' : 'new');
    const cp = await checkpoint();
    const receipt = known(await preserveOutputs(scope, cp));
    expect(receipt.preserved).toBe(true);
    expect(receipt.artifacts).toHaveLength(1);
    await writeFile(join(scope.layout.project, 'out'), 'changed');
    const changed = known(await retainOutputs(scope));
    expect(changed).toMatchObject({preserved: true});
    expect(changed.artifacts).not.toEqual(receipt.artifacts);
    expect(known(await retainOutputs(scope)).artifacts).toEqual(changed.artifacts);
  });
  it('reports absent kind prefix failures with partial successful archives', async () => {
    declarations([], [{ path: 'missing', kind: 'file', existing: 'create' }, { path: 'wrong', kind: 'directory', existing: 'create' }, {
     path: 'prefix', kind: 'file', existing: 'append' }, { path: 'good', kind: 'file', existing: 'create' }]);
    await writeFile(join(scope.layout.project, 'prefix'), 'original');
    setScope({ ...scope, outputBaseline: known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: {
     ...scope.brief.declaration, inputs: scope.brief.declaration.outputs.map((output, index) => ({ id: 'out' + index, path: output.path,
     kind: output.kind, frozen: false })) } } })) });
    for (const name of ['wrong', 'prefix', 'good'])
      await writeFile(join(scope.layout.project, name), 'changed');
    const cp = await checkpoint();
    const receipt = known(await preserveOutputs(scope, cp));
    expect(receipt.preserved).toBe(false);
    expect(receipt.artifacts).toHaveLength(4);
    expect(known(await retainOutputs(scope)).preserved).toBe(false); // the absent output remains partial
  });
  it('verifies the complete run pin and refuses mutable or aliased carriers', async () => {
    const path = join(root, 'runtime', 'program');
    await writeFile(path, 'program');
    await chmod(path, 0o555);
    const ref = { path: 'program', sha256: hash('program'), executable: true };
    const content = JSON.stringify([ref]);
    const manifestPath = join(root, 'runtime', '.pin');
    await writeFile(manifestPath, content);
    await chmod(manifestPath, 0o444);
    const runtime = { path: 'runtime/.pin', sha256: hash(content) };
    expect(known(await verifyRuntime(root, runtime))).toEqual(runtime);
    const retired = JSON.stringify({ version: 1, files: [ref] });
    await chmod(manifestPath, 0o644); await writeFile(manifestPath, retired); await chmod(manifestPath, 0o444);
    expect(await verifyRuntime(root, { ...runtime, sha256: hash(retired) })).toMatchObject({ ok: false, kind: 'invalid',
      detail: expect.stringContaining('Unsupported runtime inventory format') });
    await chmod(manifestPath, 0o644); await writeFile(manifestPath, content); await chmod(manifestPath, 0o444);
    await chmod(path, 0o755);
    expect(await verifyRuntime(root, runtime)).toMatchObject({ ok: false, kind: 'unavailable' });
    await chmod(path, 0o555);
    await rm(path);
    await symlink('.pin', path);
    expect(await verifyRuntime(root, runtime)).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});
// Baselines and checkpoints carry the same exact original filesystem facts.
it.each(['file', 'directory'] as const)('archives a deliberately empty declared external %s without inventing gate acceptance', async (kind) => {
  const path = join(root, 'external');
  declarations([{ id: 'original', path, kind, frozen: false }], [{ path, kind, existing: 'create' }]);
  setScope({ ...scope, outputBaseline: known(await hashInputs(scope)) });
  declarations([], [{ path, kind, existing: 'create' }]);
  if (kind === 'file')
    await writeFile(path, '');
  else
    await mkdir(path);
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
  await writeFile(kind === 'file' ? path : join(path, 'result'), 'authored');
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
});
it('append preserves an empty literal Git directory while allowing it to gain children', async () => {
  const out = join(scope.layout.project, 'out');
  await mkdir(join(out, '.git'), { recursive: true });
  declarations([{ id: 'original', path: 'out', kind: 'directory', frozen: false }], [{ path: 'out', kind: 'directory', existing: 'append' }]);
  const baseline = known(await hashInputs(scope));
  declarations([], [{ path: 'out', kind: 'directory', existing: 'append' }]);
  setScope({ ...scope, outputBaseline: baseline });
  await writeFile(join(out, '.git', 'literal'), 'new child');
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(true);
  await rm(join(out, '.git'), { recursive: true });
  expect(known(await preserveOutputs(scope, await checkpoint())).preserved).toBe(false);
});

it('retention observes frozen-input damage without restoring it or requiring the old baseline',async()=>{
  declarations([{id:'frozen',path:'input',kind:'file',frozen:true}],[{path:'out',kind:'file',existing:'append'}]);
  await writeFile(join(scope.layout.project,'input'),'original frozen');
  await writeFile(join(scope.layout.project,'out'),'original prefix');
  setScope({...scope,inputBaseline:known(await hashInputs(scope))});
  await checkpoint();
  await writeFile(join(scope.layout.project,'input'),'author damage');
  await writeFile(join(scope.layout.project,'out'),'changed prefix retained');
  const retained=known(await retainOutputs({...scope,outputBaseline:[]}));
  expect(retained).toMatchObject({preserved:true});
  expect(await readFile(join(scope.layout.project,'input'),'utf8')).toBe('author damage');
  expect(await readFile(join(scope.layout.project,'out'),'utf8')).toBe('changed prefix retained');
});

it('an unreadable released observation is partial and never blocks another output',async()=>{
  const external=join(root,'external');
  declarations([],[{path:'out',kind:'file',existing:'replace'},{path:external,kind:'file',existing:'replace'}]);
  await writeFile(join(scope.layout.project,'out'),'project bytes');await writeFile(external,'external bytes');
  const receipt=known(await retainOutputs(scope)),externalRef=receipt.artifacts[1];
  await record({type:'outputs_preserved',receipt:{...receipt,artifacts:[externalRef],released:[external]}});
  const evidence=await import('../../dist-rewrite/records/evidence.js'),read=evidence.readEvidence;
  const unavailable=vi.spyOn(evidence,'readEvidence').mockImplementation((journal,ref)=>ref.sha256===externalRef.sha256
    ? Promise.resolve({ok:false,kind:'unavailable',detail:'Unreadable retained observation'}) : read(journal,ref));
  try {expect(known(await retainOutputs(scope))).toMatchObject({preserved:false,artifacts:[receipt.artifacts[0]]});}
  finally {unavailable.mockRestore();}
});

it('output capture remains quiescent while its owning run unit is active',async()=>{
  const {readProjection}=await import('../../dist-rewrite/records/state.js');
  const projection=known(await readProjection(scope.journal));
  await record({type:'run_observed',observation:{unit:projection.launch.unit,state:'active',owner:scope.projectClaim.owner,evidence:[],detail:'Active run'}});
  declarations([],[{path:'out',kind:'file',existing:'create'}]);
  await writeFile(join(scope.layout.project,'out'),'active snapshot');
  expect(known(await retainOutputs(scope))).toMatchObject({preserved:true,artifacts:[expect.any(Object)]});
});
