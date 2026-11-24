import './fixtures/rewrite-core-sql.js'; // Register authored effects before importing production consumers.
import { afterEach, expect, it } from 'vitest';
import type { StageAnswer } from '../dist-rewrite/contract/answers.js';
import type { Plan } from '../dist-rewrite/contract/plan.js';
import type { AttemptReceipt } from '../dist-rewrite/contract/runtime.js';
import { parsePlan } from '../dist-rewrite/contract/plan.js';
import { fixedPlan } from '../dist-rewrite/core/admission.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';
import { putEvidence } from '../dist-rewrite/records/state.js';
import { publishRunStatus } from '../dist-rewrite/ops/status.js';
import { currentStatus } from '../dist-rewrite/contract/status.mjs';
import { validStatus } from '../rewrite-src/contract/status.mjs';
import { stateFixture, type StateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { workflowFixture } from './fixtures/rewrite-workflow.js';

let f: StateFixture;
afterEach(async () => { await f.close(); });
async function resetFixture(patch: Parameters<typeof stateFixture>[0] = {}, graph?: Parameters<typeof stateFixture>[1]) {
  await f?.close(); f = await stateFixture(patch, graph); await f.admit();
}
async function answerReceipt(receipt: AttemptReceipt, answer: StageAnswer) {
  return { ...receipt, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) };
}
/** The fixture configures one role; the engine run below binds every stage to it, while role binding is refused or admitted by `admitLaunch` (rewrite-admission). */
const onAuthor = (plan: Plan): Plan => ({ stages: plan.stages.map(stage => ({ ...stage, role: 'author' })) });
const commands = ['Verify', 'Optional'].map(id => ({ id, argv: [process.execPath, '-e', ''], env: {}, inputs: [], required: id === 'Verify' }));
const rejection = (finding: string): StageAnswer => ({ kind: 'gate', answer: { outcome: 'rejected_repairable', reason: 'Rejected: ' + finding,
  criteria: { correct: { status: 'fail', evidence: 'Observed independently.' } }, remainingWork: ['Repair'],
  findings: [{ id: 'finding', paths: [], reason: finding, criterionIds: ['correct'], class: 'criterion_unmet' }] } });
/** Run the fixed graph with a gate that rejects `rejections` times and then accepts. */
async function run(rejections: number) {
  await resetFixture();
  const graph = onAuthor(fixedPlan(f.launch.brief.declaration));
  await resetFixture({}, graph);
  const { ports, seen } = workflowFixture(f), native = ports.attempt;
  let rejected = 0;
  ports.attempt = async (request) => {
    const received = get(await native(request));
    if (request.stage.purpose !== 'gate' || rejected >= rejections) return { ok: true, value: received };
    return { ok: true, value: await answerReceipt(received, rejection('Finding ' + ++rejected)) };
  };
  const result = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  return { result, seen, graph, projection: await f.projection() };
}

it('builds the default graph without a model: one work stage, one gate over the required commands, one repair stage', async () => {
  await resetFixture({ commands });
  const graph = fixedPlan(f.launch.brief.declaration);
  expect(graph).toEqual({ stages: [
    { id: 'work', role: 'work', purpose: 'work', after: [], instruction: expect.any(String) },
    { id: 'gate', role: 'gate', purpose: 'gate', after: ['work'], commands: ['Verify'], repair: { stage: 'repair', returnsTo: 'gate' } },
    { id: 'repair', role: 'work', purpose: 'work', after: [], instruction: expect.any(String) },
  ] });
  expect(Object.hasOwn(graph.stages[1], 'instruction')).toBe(false);
  expect(parsePlan(graph, { roleIds: ['work', 'gate'], commandIds: ['Verify', 'Optional'], checkpointIds: [] }).ok).toBe(true);
});

it('runs only the required command at the gate and shows the optional one as declared but not run', async () => {
  await resetFixture({ commands });
  await resetFixture({ commands }, onAuthor(fixedPlan(f.launch.brief.declaration)));
  const { ports, seen } = workflowFixture(f);
  get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
  const projection = await f.projection();
  const gate = seen.find(request => request.stage.purpose === 'gate')!;
  expect(gate.stage.commands).toEqual(['Verify']);
  expect(gate.brief.declaration.commands.map(command => [command.id, command.required])).toEqual([['Verify', true], ['Optional', false]]);
  expect([...new Set(projection.commands.map(receipt => receipt.command))]).toEqual(['Verify']);
});

it('runs work then the gate and calls no planner', async () => {
  const { result, seen, projection } = await run(0);
  expect(result.status).toBe('complete');
  expect(seen.map(request => request.stage.id)).toEqual(['work', 'gate']);
  expect(seen.some(request => request.stage.purpose === 'plan')).toBe(false);
  expect(projection.revisions).toHaveLength(1);
  expect(Object.hasOwn(seen[1].stage, 'instruction')).toBe(false);
});

it('answers a rejection with repair work that receives the findings, then reviews again', async () => {
  const { result, seen, projection } = await run(1);
  expect(result.status).toBe('complete');
  expect(seen.map(request => request.stage.id)).toEqual(['work', 'gate', 'repair', 'gate']);
  const rejected = projection.attempts.find(receipt => receipt.address.stage === 'gate')!;
  expect(rejected.answer).toMatchObject({ kind: 'gate', answer: { outcome: 'rejected_repairable' } });
  expect(seen[2].evidence).toContainEqual(rejected.answerRef);
});

it('keeps the existing backstop: three consecutive rejections park the run for the operator', async () => {
  const { result, seen } = await run(Infinity);
  expect(result.status).toBe('parked');
  expect(result.reason).toBe('backstop');
  expect(seen.map(request => request.stage.id)).toEqual(['work', 'gate', 'repair', 'gate', 'repair', 'gate']);
});

