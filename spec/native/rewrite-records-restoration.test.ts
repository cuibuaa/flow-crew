import { expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashInputs, materializeCheckpoint, preserveOutputs } from "../../dist-rewrite/records/content.js";
import { readEvents } from "../../dist-rewrite/records/state.js";
import { putEvidence } from "../../dist-rewrite/records/evidence.js";
import { root, scope, writer, manifest, known, declarations, checkpoint, setScope } from './fixtures/rewrite-content.js';
const restorationCases = (['create', 'update', 'append', 'replace'] as const).flatMap(existing =>
  (['file', 'directory'] as const).map(kind => ({ existing, kind, present: true, modeChanged: true })));
it.each(restorationCases)('restores exact output baseline $existing/$kind/present=$present/modeChanged=$modeChanged', async ({ existing,
 kind, present, modeChanged }) => {
  const path = join(scope.layout.project, 'out');
  if (present) {
    if (kind === 'file')
      await writeFile(path, 'original');
    else {
      await mkdir(path);
      await writeFile(join(path, 'child'), 'original');
      await chmod(join(path, 'child'), 0o640);
    }
    await chmod(path, kind === 'file' ? 0o751 : 0o750);
  }
  declarations([{ id: 'original', path: 'out', kind, frozen: false }], [{ path: 'out', kind, existing }]);
  const baselineRefs = known(await hashInputs(scope));
  const baseline = await manifest(baselineRefs[0]);
  expect(baseline.path).toBe('out');
  expect(baseline.snapshot.kind !== 'absent').toBe(present);
  if (present)
    expect(baseline.snapshot).toMatchObject({ kind, mode: kind === 'file' ? 0o751 : 0o750 });
  declarations([], [{ path: 'out', kind, existing }]);
  setScope({ ...scope, outputBaseline: baselineRefs });
  const cp = await checkpoint();
  await rm(path, { force: true, recursive: true });
  // Change type as well as content; mode changes are independent table inputs.
  if (kind === 'file')
    await mkdir(path);
  else
    await writeFile(path, 'changed');
  if (modeChanged)
    await chmod(path, 0o700);
  expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
  if (!present)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  else {
    const stat = await lstat(path);
    expect(stat.isFile()).toBe(kind === 'file');
    expect(stat.mode & 0o7777).toBe(kind === 'file' ? 0o751 : 0o750);
    expect(await readFile(kind === 'file' ? path : join(path, 'child'), 'utf8')).toBe('original');
    if (kind === 'directory')
      expect((await lstat(join(path, 'child'))).mode & 0o7777).toBe(0o640);
  }
  expect(known(await readEvents(scope.journal, 0)).some(event => event.payload.type === 'outputs_preserved' &&
   event.payload.receipt.artifacts.length === 1)).toBe(true);
  // Delivery, including replace/create, must authenticate the baseline's declared path.
  if (present) {
    const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...baseline, path: 'different' }))));
    setScope({ ...scope, outputBaseline: [wrong] });
    const altered = await checkpoint();
    expect(known(await preserveOutputs(scope, altered)).preserved).toBe(false);
  }
});
it('restores nested external original absence through its single declared containing root', async () => {
  const parent = join(root, 'external-parent'), child = join(parent, 'nested', 'child');
  const outputs = [{ path: parent, kind: 'directory' as const, existing: 'create' as const }, { path: child, kind: 'file' as const,
   existing: 'create' as const }];
  declarations(outputs.map((output, i) => ({ id: 'original_' + i, path: output.path, kind: output.kind, frozen: false })), outputs);
  const baseline = known(await hashInputs(scope));
  declarations([], outputs);
  setScope({ ...scope, outputBaseline: baseline });
  const cp = await checkpoint();
  await mkdir(join(parent, 'nested'), { recursive: true });
  await writeFile(child, 'later authored output');
  expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
  await expect(lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  const retained = known(await readEvents(scope.journal, 0)).findLast(event => event.payload.type === 'outputs_preserved');
  expect(retained?.payload).toMatchObject({ type: 'outputs_preserved', receipt: { artifacts: expect.any(Array) } });
  expect(retained?.payload.type === 'outputs_preserved' && retained.payload.receipt.artifacts.length).toBe(2);
});
