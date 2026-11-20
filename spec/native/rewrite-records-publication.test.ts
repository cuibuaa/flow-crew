import { it, expect } from 'vitest';
import { fixture, known } from "../fixtures/rewrite-host.js";
import { recordOperation, reclaimRecordOperations, putEvidence } from "../../dist-rewrite/records/state.js";
import { readEvidence, identifyEvidence, git } from "../../dist-rewrite/records/evidence.js";
const module = new URL("./fixtures/rewrite-publication.mjs", import.meta.url).href;
it('flushes object, object-directory and protected ref before returning an exact authenticated reference', async () => {
  const f = await fixture();
  try {
    const { result, paths } = known(await recordOperation<any>(f.journal, 'construct', { module, method: 'publish', args: [f.journal] }));
    const ref = known(result);
    const objects = paths.findIndex((p: string) => p.endsWith('/objects')),
     reference = paths.findIndex((p: string) => p.includes('/refs/evidence/') && !p.endsWith('/refs/evidence'));
    expect(objects).toBeGreaterThan(0);
    expect(reference).toBeGreaterThan(objects);
    expect(paths.at(-1)).toBe(f.journal.root);
    expect(await f.text(ref)).toBe('durable-publication');
    await f.evidence('publication', { paths, ref });
  }
  finally {
    await f.close();
  }
});
it.each(['/objects', '/refs/evidence'])('durability failure at %s cannot report publication complete', async (cut) => {
  const f = await fixture();
  try {
    const { result } = known(await recordOperation<any>(f.journal, 'construct', { module, method: 'publish', args: [f.journal, cut] }));
    expect(result.ok).toBe(false);
  }
  finally {
    await f.close();
  }
});
it.each(['/objects', '/refs/evidence'])('SIGKILL at %s leaves exact bytes and only already durable refs', async (cut) => {
  const f = await fixture();
  try {
    expect(await recordOperation(f.journal, 'construct', { module, method: 'publish', args: [f.journal, cut, true] })).toMatchObject({
     ok: false, kind: 'unknown' });
    known(await reclaimRecordOperations(f.journal));
    const ref = identifyEvidence(Buffer.from('durable-publication'));
    expect(await f.text(ref)).toBe('durable-publication');
    const exists = await git(f.journal, ['show-ref', '--verify', '--hash', 'refs/evidence/' + ref.sha256]).then(() => true, () => false);
    expect(exists).toBe(cut === '/refs/evidence');
  }
  finally {
    await f.close();
  }
});
it('concurrent identical constructors and packed objects retain the same exact reference', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('packed-evidence'), results = await Promise.all([putEvidence(f.journal, bytes), putEvidence(f.journal, bytes)]);
    const ref = known(results[0]);
    expect(results[1]).toEqual(results[0]);
    await git(f.journal, ['gc']);
    await git(f.journal, ['pack-refs', '--all', '--prune']);
    expect(Buffer.from(known(await readEvidence(f.journal, ref)))).toEqual(bytes);
    expect(await putEvidence(f.journal, bytes)).toEqual(results[0]);
  }
  finally {
    await f.close();
  }
});
