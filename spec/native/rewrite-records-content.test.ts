import { describe, expect, it } from 'vitest';
import { chmod, lstat, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Input, Ref } from "../../dist-rewrite/contract/brief.js";
import { captureCheckpoint, changedTreePaths, frozenInputsMatch, validateRecordLayout, captureTree, hashInputs, settleFrozenInputs } from "../../dist-rewrite/records/content.js";
import { putEvidence } from "../../dist-rewrite/records/evidence.js";
import { recordOperation } from "../../dist-rewrite/records/state.js";
import { root, scope, hash, manifest, known, declarations, setScope } from './fixtures/rewrite-content.js';
it.each([
  { declared: false, change: 'replace', kind: 'conflict' },
  { declared: true, change: 'replace', kind: 'output_changed' },
  { declared: false, change: 'none', kind: 'invalid' },
  { declared: true, change: 'none', kind: 'invalid' },
  { declared: true, change: 'appear', kind: 'output_changed' },
] as const)('Git capture failures preserve the observed fact (declared=$declared, change=$change)', async ({ declared, change, kind }) => {
  // The appearing output has no initial stamp; check its name as well as the
  // changed project stamp when classifying the independently failing index.
  const target = join(scope.layout.project, change === 'appear' ? 'new-output' : 'input');
  if (change !== 'appear') await writeFile(target, 'original');
  else await writeFile(join(scope.layout.project, 'source'), 'stable');
  declarations([], declared ? [{ path: target, kind: 'file', existing: change === 'appear' ? 'create' : 'replace' }] : []);
  const observed = known(await recordOperation<{
    result: Awaited<ReturnType<typeof captureTree>>;
    injected: boolean;
    gitFailure: { exit: number; stderr: string };
  }>(scope.journal, 'construct', {
    module: new URL('./fixtures/rewrite-capture-race.mjs', import.meta.url).href,
    method: 'captureGitFailure', args: [scope, target, change],
  }));
  expect(observed.injected).toBe(true);
  expect(observed.gitFailure.exit).not.toBe(0);
  expect(observed.gitFailure.stderr.length).toBeGreaterThan(0);
  expect(observed.result).toMatchObject({ ok: false, kind });
  if (observed.result.ok) throw Error('Failed Git step exposed a generation');
  if (change === 'none') {
    expect(observed.result.detail).toContain('RuntimeError: ' + observed.gitFailure.stderr);
    expect(observed.result.detail).not.toContain('Content changed during Git capture: ');
  } else {
    expect(observed.result.detail).toContain('Content changed during Git capture: ');
    if (declared) expect(observed.result.detail).toBe('Content changed during Git capture: ' + target + '\n');
  }
});
describe('records content frozen identities', () => {
  it('hashes observed file/directory/external inputs without re-deciding admission', async () => {
    await writeFile(join(scope.layout.project, 'input'), 'original');
    await mkdir(join(scope.layout.project, 'dir'));
    await writeFile(join(scope.layout.project, 'dir', '.ignored'), 'ignored');
    await writeFile(join(root, 'external'), 'external');
    declarations([{ id: 'file', path: 'input', kind: 'file', frozen: true }, { id: 'directory', path: 'dir', kind: 'directory',
     frozen: true }, { id: 'external', path: join(root, 'external'), kind: 'file', frozen: false }]);
    const refs = known(await hashInputs(scope));
    expect(refs).toHaveLength(3);
    expect((await manifest(refs[0])).snapshot.sha256).toBe(hash('original'));
    declarations([{ id: 'wrong', path: 'input', kind: 'directory', frozen: true, sha256: hash('different') }]);
    const wrongKind = await hashInputs(scope); expect(wrongKind.ok).toBe(true);
    expect((await manifest(known(wrongKind)[0])).snapshot.kind).toBe('file');

  });
  it('quarantines missing/corrupt baselines and changed external frozen inputs', async () => {
    await writeFile(join(scope.layout.project, 'input'), 'tampered');
    declarations([{ id: 'input', path: 'input', kind: 'file', frozen: true }]);
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    const missing: Ref = { path: 'blobs/' + hash('missing'), sha256: hash('missing') };
    setScope({ ...scope, inputBaseline: [missing] });
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    await writeFile(join(root, 'external'), 'original');
    declarations([{ id: 'input', path: join(root, 'external'), kind: 'file', frozen: true }]);
    setScope({ ...scope, inputBaseline: known(await hashInputs(scope)) });
    await writeFile(join(root, 'external'), 'changed');
    expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
    expect(await readFile(join(root, 'external'), 'utf8')).toBe('changed');
  });
});
it('captures frozen and external alias bytes without a second content-owned hardlink inventory', async () => {
  const file = join(scope.layout.project, 'frozen');
  await writeFile(file, 'original');
  const outside = join(root, 'outside');
  await link(file, outside);
  await link(file, join(scope.layout.project, 'project-alias'));
  const directory = join(scope.layout.project, 'frozen-directory');
  await mkdir(directory);
  await writeFile(join(directory, 'a'), 'frozen');
  await link(join(directory, 'a'), join(directory, 'b'));
  declarations([{ id: 'frozen', path: 'frozen', kind: 'file', frozen: true },
    { id: 'directory', path: 'frozen-directory', kind: 'directory', frozen: true }]);
  expect((await hashInputs(scope)).ok).toBe(true);
  expect((await captureTree(scope)).ok).toBe(true);
  declarations([{ id: 'frozen', path: 'frozen', kind: 'file', frozen: true },
    { id: 'directory', path: 'frozen-directory', kind: 'directory', frozen: true }], [{ path: outside, kind: 'file', existing: 'replace' }]);
  expect((await hashInputs(scope)).ok).toBe(true);
  expect((await captureTree(scope)).ok).toBe(true);
});
it.each((['file', 'directory'] as const).flatMap(kind => [false, true].flatMap(present => [false, true].map(modeChanged => ({ kind, present,
 modeChanged }))).filter(row => row.present || !row.modeChanged)))('restores frozen baseline $kind/present=$present/modeChanged=$modeChanged', async ({ kind, present, modeChanged }) => {
  const path = join(scope.layout.project, 'input');
  if (present) {
    if (kind === 'file')
      await writeFile(path, 'original');
    else {
      await mkdir(path);
      await writeFile(join(path, 'child'), 'original');
    }
    await chmod(path, 0o750);
  }
  declarations([{ id: 'frozen', path: 'input', kind, frozen: true }]);
  setScope({ ...scope, inputBaseline: known(await hashInputs(scope)) });
  if (present && modeChanged)
    await chmod(path, 0o700);
  else {
    await rm(path, { recursive: true, force: true });
    if (kind === 'file')
      await mkdir(path);
    else
      await writeFile(path, 'mutation');
  }
  const settled = known(await settleFrozenInputs(scope));
  expect(settled.state).toBe('restored');
  expect(settled.evidence).toHaveLength(1);
  expect(known(await settleFrozenInputs(scope)).state).toBe('unchanged');
  if (present) {
    expect((await lstat(path)).mode & 0o7777).toBe(0o750);
    expect((await lstat(path)).isFile()).toBe(kind === 'file');
    expect(await readFile(kind === 'file' ? path : join(path, 'child'), 'utf8')).toBe('original');
  }
  else
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('quarantines a valid baseline manifest belonging to a different declared path', async () => {
  const path = join(scope.layout.project, 'input');
  await writeFile(path, 'original');
  declarations([{ id: 'frozen', path: 'input', kind: 'file', frozen: true }]);
  const captured = known(await hashInputs(scope))[0];
  const baseline = await manifest(captured);
  const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...baseline, path: 'other' }))));
  setScope({ ...scope, inputBaseline: [wrong] });
  await writeFile(path, 'changed');
  expect(known(await settleFrozenInputs(scope)).state).toBe('quarantined');
  expect(await readFile(path, 'utf8')).toBe('changed');
});

it.each([false, true])('pairs frozen inputs by manifest identity when frozen bytes changed=%s', async changed => {
    const mutablePath = join(root, 'mutable'), frozenPath = join(root, 'frozen');
    await writeFile(mutablePath, 'mutable original');
    await writeFile(frozenPath, 'frozen original');
    const inputs: Input[] = [{id:'mutable',path:mutablePath,kind:'file',frozen:false},
      {id:'frozen',path:frozenPath,kind:'file',frozen:true}];
    declarations(inputs);
    const baseline = known(await hashInputs(scope));
    setScope({...scope,inputBaseline:[...baseline].reverse()});
    await writeFile(mutablePath, 'mutable changed');
    if (changed) await writeFile(frozenPath, 'frozen changed');
    const settled = known(await settleFrozenInputs(scope));
    expect(settled.state).toBe(changed ? 'quarantined' : 'unchanged');
    expect(await frozenInputsMatch(scope.journal, scope.brief, settled.inputs, baseline)).toBe(!changed);
    // Every list can be independently reordered; no list position carries input identity.
    expect(await frozenInputsMatch(scope.journal, scope.brief, [...settled.inputs].reverse(), [...baseline].reverse())).toBe(!changed);
    const cp = known(await captureCheckpoint(scope,{run:'Run',stage:'work',attempt:'InputIdentity',invocation:1},null,
      changed ? 'quarantined' : 'safe', [], settled.inputs));
    expect(cp.state).toBe(changed ? 'quarantined' : 'safe');
  });

it('names changed modes, symlinks, empty directories and external output files from retained generations', async () => {
  const project = scope.layout.project, external = join(root, 'artifact');
  await writeFile(join(project, 'mode.txt'), 'same bytes');
  await chmod(join(project, 'mode.txt'), 0o644);
  await mkdir(join(project, 'empty'));
  await symlink('mode.txt', join(project, 'link'));
  await writeFile(external, 'before');
  await mkdir(join(project,'.git'));
  await writeFile(join(project,'.git','config'),'before');
  await writeFile(join(project,'.fcrw-literal'),'before');
  declarations([], [{ path: external, kind: 'file', existing: 'replace' }]);
  const before = known(await captureTree(scope));
  await chmod(join(project, 'mode.txt'), 0o600);
  await rm(join(project, 'empty'), { recursive: true });
  await rm(join(project, 'link'));
  await symlink('different.txt', join(project, 'link'));
  await writeFile(external, 'after');
  await writeFile(join(project,'.git','config'),'after');
  await writeFile(join(project,'.fcrw-literal'),'after');
  const after = known(await captureTree(scope));
  expect(known(await changedTreePaths(scope.journal, before, after))).toEqual([external, 'empty', 'link', 'mode.txt', '.git/config', '.fcrw-literal'].sort());
});

// SQLite owns transient WAL/SHM names. Their inode lifetimes may overlap a
// layout observation without the paths ever being aliases.
it('keeps physical identity comparisons valid while protected files are replaced', async () => {
  const paths=[join(root,'transient-a'),join(root,'transient-b')];
  let running=true;
  const churn=(async()=>{while(running){for(const path of paths){
    await rm(path,{force:true});await writeFile(path,'new file lifetime');
  }}})();
  try {
    for(let index=0;index<100;index++) {
      const result=await validateRecordLayout({...scope.layout,protectedRoots:[...scope.layout.protectedRoots,...paths]});
      expect(result,JSON.stringify(result)).toMatchObject({ok:true});
    }
  } finally {running=false;await churn;}
});
