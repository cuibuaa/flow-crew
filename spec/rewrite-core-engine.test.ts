import { expect,it } from 'vitest';
import type { AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { admitPlan } from '../dist-rewrite/core/admission.js';
import { decideNext,decidePublication } from '../dist-rewrite/core/decisions.js';
import { decideRetry,outcomeFacts } from '../dist-rewrite/core/retry.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';
const f = { brief: coreProjection().brief, ref: {path:'authored/ref',sha256:'a'.repeat(64)}, plan: coreProjection().plan.plan,
  projection: async () => coreProjection() };
const stage = (id: string, purpose: 'plan' | 'work' | 'gate' = 'work', after: string[] = []) => ({ id, role:'author', purpose, after,
 instruction:'Finite declared obligation', skills:[], ...(purpose === 'gate' ? {commands:[]} : {}) });
function completedDecisionFixture() { return coreProjection(true); }
const endings: Array<[
  AttemptReceipt['ending'],
  string,
  string?
]> = [
  ['delivered', 'settled'], ['invalid_answer', 'retry', 'correction'], ['invalid_plan', 'retry', 'correction'], ['work_failed', 'retry', 'work'],
  ['technical_failure', 'retry', 'technical'], ['auth', 'stop', 'attempt_failed'], ['refused', 'stop', 'attempt_failed'],
  ['input_too_large', 'park', 'attempt_failed'], ['quota', 'park', 'attempt_failed'], ['duration', 'park', 'attempt_failed'],
  ['cancelled', 'stop', 'cancelled'], ['isolation_failure', 'stop', 'isolation_refused'], ['closure_unknown', 'park', 'recovery_unknown'],
   ['provider_unknown', 'park', 'recovery_unknown'],
];
it.each(endings)('preserves the pure retry decision for %s', async (ending, kind, detail) => {
  const p = await f.projection();
  const receipt: AttemptReceipt = { address: { run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 }, ending,
   before: 'a'.repeat(64), after: 'a'.repeat(64), audit: f.ref, closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [],
   inputChars: 1, resetAt: '2030-01-01T00:00:00Z' };
  const result = decideRetry({ projection: p, receipt });
  expect(result.kind).toBe(kind);
  if (result.kind === 'retry')
    expect(result.charge).toBe(detail);
  if (result.kind === 'park' || result.kind === 'stop')
    expect(result.conclusion.reason).toBe(detail);
});
it.each(['no-gate', 'ambiguous-gates', 'orphan', 'unknown-role', 'unsafe-base',
 'missing-repair-return'])('retains pure admission refusal for %s', async (kind) => {
  const work = { id: 'work', role: 'author', purpose: 'work' as const, after: [], instruction: 'Work', skills: [] }, gate = { id: 'gate',
   role: 'author', purpose: 'gate' as const, after: ['work'], instruction: 'Review', skills: [], commands: [] };
  const proposals = {
    'no-gate': { stages: [work] }, 'ambiguous-gates': { stages: [work, gate, { ...gate, id: 'other' }] },
    orphan: { stages: [work, gate, { ...work, id: 'orphan' }] }, 'unknown-role': { stages: [{ ...work, role: 'unknown' }, gate] },
    'unsafe-base': { stages: [{ ...work, baseCheckpoint: 'quarantined' }, gate] },
    'missing-repair-return': { stages: [work, { ...gate, repair: { stage: 'work', returnsTo: 'unknown' } }] }
  };
  expect(admitPlan(proposals[kind as keyof typeof proposals], 'next', await f.projection())).toMatchObject({ ok: false, kind: 'invalid' });
});
it('keeps a pending gate graph fixed until independent review', async () => {
  const p = await f.projection();
  expect(admitPlan(f.plan, 'next', p).ok).toBe(true);
  expect(admitPlan({ stages: f.plan.stages.filter(s => s.id !== 'repair').map(s => s.purpose === 'gate' ? { ...s, repair: { stage: 'work',
   returnsTo: 'gate' } } : s) }, 'next', p).ok).toBe(false);
});
it.each(['safe', 'quarantined'] as const)('retains admission of only %s checkpoint bases', async (state) => {
  const p = await f.projection(), checkpoint = { id: 'Checkpoint', address: { run: 'Run', stage: 'work', attempt: 'Attempt',
   invocation: 1 }, parent: null, state, manifest: f.ref, tree: 'a'.repeat(64), brief: f.brief.digest, inputHashes: [], evidence: [] };
  expect(admitPlan({ stages: f.plan.stages.map(s => s.id === 'work' ? { ...s, baseCheckpoint: 'Checkpoint' } : s) }, 'next', { ...p,
   revisions: [], checkpoints: [checkpoint] }).ok).toBe(state === 'safe');
});
it('retains duplicate gate-transition and undeclared-blocked refusal', async () => {
  const p = await completedDecisionFixture(), checkpoint = p.checkpoints.at(-1)!;
  expect(decideNext({ ...p, transitions: [...p.transitions, p.transitions[0]] })).toMatchObject({ ok: false, kind: 'invalid' });
  const changed = { ...p, attempts: p.attempts.map(r => r.answer?.kind === 'gate' ? { ...r, answer: { kind: 'gate' as const, answer: {
   ...r.answer.answer, outcome: 'accepted_blocked' as const } } } : r) };
  expect(decidePublication(changed, checkpoint, { preserved: true, artifacts: [], detail: '' }).ok).toBe(false);
});
it('a finite bootstrap graph may retain a dormant planner owned by a future independent repair return', async () => {
  const graph = { stages: [stage('work'), { ...stage('gate', 'gate', ['work']), purpose: 'gate' as const, commands: [], repair: {
   stage: 'repair_plan', returnsTo: 'gate' } }, stage('repair_plan', 'plan')] };
  const base = coreProjection(), planner = stage('planner', 'plan');
  const p = { ...base, launch: { ...base.launch, plan: undefined },
    plan: { ...base.plan, plan: { stages: [planner] } }, revisions: [{ ...base.plan, plan: { stages: [planner] } }],
    stageStates: [{ stage: 'planner', state: 'pending' as const, obligation: 'Revision:0', completed: false }] };
  expect(admitPlan(graph, 'Finite', p, 'planner')).toMatchObject({ ok: true });
});
it('a completed gate obligation cannot clear later failures through another pass', async () => {
  const p = coreProjection(true), receipt = p.attempts.at(-1)!, stage = p.stageStates.find(s => s.stage === receipt.address.stage)!;
  expect(stage.completed).toBe(true);
  const current = { ...p, backstop: { ...p.backstop, failureSuffix: 3 } };
  const facts = outcomeFacts(current, receipt, stage, true);
  expect(facts[0]).toMatchObject({ type: 'outcome_settled', completed: false, backstop: { failureSuffix: 3 } });
});
