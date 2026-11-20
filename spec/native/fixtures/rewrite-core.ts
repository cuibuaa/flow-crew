import { afterEach, beforeEach, vi } from 'vitest';
import type { StageAnswer } from '../../../dist-rewrite/contract/answers.js';
import type { AttemptReceipt,AttemptRequest } from '../../../dist-rewrite/contract/runtime.js';
import { decideNext } from '../../../dist-rewrite/core/decisions.js';
import * as host from '../../../dist-rewrite/host/process.js';
import { putEvidence } from '../../../dist-rewrite/records/state.js';
import { get,stateFixture,type StateFixture } from '../../fixtures/rewrite-state.js';
import { workflowFixture } from '../../fixtures/rewrite-workflow.js';
export let f: StateFixture;
beforeEach(async () => {
  f = await stateFixture(); await f.admit();
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null,
    evidence: [], detail: 'Manager fixture' } });
});
afterEach(async () => { await f.close(); });
export async function returnedReceipt(invocation = true) {
  const p = await f.projection(), next = get(decideNext(p));
  if (next.kind !== 'stage')
    throw new Error('Expected work frontier');
  const address = { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, paid = { charge: 'work' as const, address: {
   kind: 'stage' as const, ...address } };
  if (invocation)
    await f.append(f.execution, [{ type: 'invocation_reserved', invocation: paid }]);
  const request: AttemptRequest = { address, invocation: paid, stage: next.stage, role: f.configuration.roles[0], brief: f.brief,
   plan: p.plan, evidence: [], context: next.context };
  return get(await workflowFixture(f).ports.attempt(request));
}
export async function answerReceipt(receipt: AttemptReceipt, answer: StageAnswer) { return { ...receipt, answer,
 answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) }; }
export async function resetFixture(patch: Parameters<typeof stateFixture>[0] = {}, graph?: Parameters<typeof stateFixture>[1]) { await f.close();
 f = await stateFixture(patch, graph); await f.admit(); }
export const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role: 'author', purpose, after,
 ...(purpose === 'gate' ? { commands: [] } : { instruction: 'Finite declared obligation' }) });
vi.mock('../../../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../../../dist-rewrite/host/process.js')>(),
 observeRun: vi.fn(), startRun: vi.fn() }));
export const repairGraph = () => ({ stages: [stage('work'), { ...stage('progress', 'gate', ['work']), purpose: 'gate' as const, commands: [],
 repair: { stage: 'planner', returnsTo: 'progress' } }, stage('later', 'work', ['progress']), { ...stage('gate', 'gate', ['later']),
 purpose: 'gate' as const, commands: [] }, stage('planner', 'plan')] });
