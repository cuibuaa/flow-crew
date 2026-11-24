import { f, returnedReceipt, stage } from './fixtures/rewrite-core.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { decideNext } from '../../dist-rewrite/core/decisions.js';
import { settle } from '../../dist-rewrite/core/settlement.js';
import { putEvidence } from '../../dist-rewrite/records/state.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';
it.each(['live', 'reused', 'unknown'] as const)('keeps raw %s closure without checkpoint or stage completion', async (closure) => {
  const receipt = { ...await returnedReceipt(), closure };
  expect(await settle(await f.projection(), receipt, f.execution, f.scope)).toMatchObject({ ok: false, kind: 'unknown' });
  const p = await f.projection();
  expect(p.received).toContainEqual(receipt);
  expect(p.attempts).toHaveLength(1);
  expect(p.attempts[0]).toMatchObject({ ...receipt, evidence: expect.arrayContaining(receipt.evidence) });
  const evidence = await import('../../dist-rewrite/records/evidence.js');
  const diagnostics = await Promise.all(p.attempts[0].evidence.map(async ref =>
    evidence.decodeRefusal(get(await evidence.readEvidence(f.journal, ref)))));
  expect(diagnostics).toContainEqual({ ok: false, kind: 'unknown', detail: 'Descendant closure not proven' });
  expect(p.checkpoints).toEqual([]);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
});
it.each(['stale address', 'missing invocation', 'wrong answer bytes'])('retains real settlement refusal for %s', async (fault) => {
  let receipt = await returnedReceipt(fault !== 'missing invocation');
  if (fault === 'stale address')
    receipt = { ...receipt, address: { ...receipt.address, attempt: 'stale' } };
  if (fault === 'wrong answer bytes')
    receipt = { ...receipt, answerRef: get(await putEvidence(f.journal, Buffer.from('{}'))) };
  const result = await settle(await f.projection(), receipt, f.execution, f.scope);
  expect(result.ok).toBe(fault === 'wrong answer bytes');
  const p = await f.projection();
  expect(p.checkpoints).toHaveLength(fault === 'wrong answer bytes' ? 1 : 0);
  expect(p.stageStates.find(s => s.stage === 'work')?.state).not.toBe('settled');
  if (fault === 'wrong answer bytes')
    expect(p.attempts[0].ending).toBe('invalid_answer');
});
it('refuses a second settlement without changing the committed completion or C2 state', async () => {
  const receipt = await returnedReceipt();
  get(await settle(await f.projection(), receipt, f.execution, f.scope));
  const before = await f.projection();
  expect(before.stageStates.find(s => s.stage === 'work')?.completed).toBe(true);
  expect(await settle(before, receipt, f.execution, f.scope)).toMatchObject({ok:false,kind:'conflict'});
  expect(await f.projection()).toEqual(before);
});
it.each(['evidence digest', 'content generation'] as const)('retains the closed raw receipt when %s changes before settlement', async fault => {
    const projection = await f.projection(), next = get(decideNext(projection));
    if (next.kind !== 'stage') throw Error('Expected work frontier');
    const address = { run: 'Run', stage: 'work', attempt: 'Changed', invocation: 1 };
    const invocation = { charge: 'work' as const, address: { kind: 'stage' as const, ...address } };
    await f.append(f.execution, [{ type: 'invocation_reserved', invocation }]);
    let receipt = get(await workflowFixture(f).ports.attempt({ address, invocation, stage: next.stage,
      role: f.configuration.roles[0], brief: f.brief, plan: projection.plan, evidence: [], context: next.context }));
    if (fault === 'evidence digest') receipt = { ...receipt, evidence: [{ ...f.ref, sha256: '0'.repeat(64) }] };
    else await writeFile(join(f.project, 'delivery'), 'Concurrent replacement after the closed author');
    const result = await settle(await f.projection(), receipt, f.execution, f.scope);
    expect(result).toMatchObject({ ok: false, kind: fault === 'evidence digest' ? 'invalid' : 'unknown' });
    const after = await f.projection();
    expect(after.received).toEqual([receipt]);
    expect(after.attempts).toHaveLength(1);
    expect(after.checkpoints).toEqual([]);
    expect(after.stageStates.find(stage => stage.stage === 'work')?.completed).toBe(false);
});
