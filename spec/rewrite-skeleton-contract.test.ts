import {wireStatus} from './fixtures/rewrite-status.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { answerSchema } from '../rewrite-src/contract/answers.js';
import { parsePlan } from '../rewrite-src/contract/plan.js';
import { parseRunStatusFile } from '../rewrite-src/contract/runtime.js';
import { progressPlan, progressContext, progressAnswerContext, progressAnswer } from './fixtures/rewrite-progress-gate.js';
it('represents a non-last progress gate without adding another stage purpose or relying on array order', () => {
  expect(parsePlan(progressPlan, progressContext).ok).toBe(true);
  const schema = answerSchema(progressAnswerContext);
  expect(schema.parse(progressAnswer).ok).toBe(true);
  expect(z.fromJSONSchema(schema.json).safeParse(progressAnswer).success).toBe(true);
  expect(answerSchema({ ...progressAnswerContext, final: true }).parse(progressAnswer).ok).toBe(false);
  expect(schema.parse({ ...progressAnswer, answer: { ...progressAnswer.answer, result: 'delivered' } }).ok).toBe(false);
});
const status = {...wireStatus('run_a'),currentStage:'delivery_work',gates:[{stage:'progress_gate',attempt:'attempt_a',scope:'progress',outcome:'accepted',answer:{path:'evidence/gate.json',sha256:'a'.repeat(64)},cursor:4}]};
it.each([
  ['complete/cancelled', { status: 'complete', stopReason: 'cancelled', currentStage: null }],
  ['cancelled/completed', { status: 'cancelled', stopReason: 'completed', currentStage: null }],
  ['running/completed', { status: 'running', stopReason: 'completed' }],
  ['terminal without reason', { status: 'complete', stopReason: null, currentStage: null }],
  ['pending with stop', { status: 'pending', stopReason: 'recovery_unknown', currentStage: null }],
  ['parked without reason', { status: 'parked', stopReason: null }],
  ['parked unfinished command', { status: 'parked', stopReason: 'command_unfinished',
    attention: { reason: 'command_unfinished', detail: 'Interrupted request', condition: null } }],
  ['failed/completed', { status: 'failed', stopReason: 'completed', currentStage: null }],
  ['incomplete/gate rejection', { status: 'incomplete', stopReason: 'gate_irreparable', currentStage: null }],
  ['terminal with current stage', { status: 'complete', stopReason: 'completed' }],
  ['malformed time', { publishedAt: 'yesterday' }],
  ['missing time', { publishedAt: undefined }],
  ['progress result', { gates: [{ ...status.gates[0], result: 'delivered' }] }],
  ['unknown scope', { gates: [{ ...status.gates[0], scope: 'finalish' }] }],
])('refuses inconsistent public status: %s', (_label, patch) => {
  expect(parseRunStatusFile({ ...status, ...patch }).ok).toBe(false);
});
it.each([
  ['pending', null], ['running', null], ['parked', 'attempt_failed'], ['parked', 'recovery_unknown'],
  ['complete', 'completed'], ['accepted_blocked', 'accepted_blocked'],
  ...['command_missing', 'command_nonzero', 'command_unfinished', 'outputs_unpreserved'].map(reason => ['incomplete', reason]),
  ...['gate_irreparable', 'attempt_failed', 'contract_refused', 'isolation_refused'].map(reason => ['failed', reason]),
  ['escalated', 'recovery_unknown'], ['cancelled', 'cancelled'],
])('admits the declared status/reason pair %s/%s', (state, reason) => {
  expect(parseRunStatusFile({ ...status, status: state, stopReason: reason, currentStage: null, attention:reason === null ? null : {reason,detail:'opaque',condition:null} }).ok).toBe(true);
});

it('decodes additive stage/plan metadata and historical files without it at the canonical boundary', () => {
  const stage = {id:'work',purpose:'work' as const,role:'author',after:[],goal:'Short goal',instruction:'Full instruction',commands:[],
    revision:'Revision',state:'pending' as const,attempts:0,lastEnding:null,verdict:null,startedAt:null,settledAt:null};
  const pending = {id:'work',purpose:'work' as const,role:'author',after:[],instruction:'Full instruction',skills:[]};
  const emitted = {...wireStatus('Run','pending'),host:{interpretation:wireStatus().host.interpretation},version:3 as const,stages:[stage],plan:{revision:'Revision',pending:{stages:[pending]}}};
  expect(parseRunStatusFile(emitted).ok).toBe(true);
  expect(parseRunStatusFile({...emitted,stages:[{...stage,state:'unrecognized'}]}).ok).toBe(false);
  expect(parseRunStatusFile({...emitted,plan:{...emitted.plan,pending:{stages:[{id:'MissingDefinition'}]}}}).ok).toBe(false);
  const {stages,plan,...legacy} = emitted;
  expect(parseRunStatusFile(legacy).ok).toBe(true);
  expect(parseRunStatusFile({...legacy,version:2,host:{...legacy.host,readiness:'applied'}}).ok).toBe(true);
});
