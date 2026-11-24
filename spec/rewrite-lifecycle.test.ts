import { expect, it } from 'vitest';
import { isFinal, lifecycle, nextLifecycle, type Lifecycle, type LifecycleFact } from '../dist-rewrite/records/state.js';
import { currentStatus, parsePublicRunStatus, withCurrentBoot } from '../rewrite-src/contract/status.mjs';
import { wireStatus } from './fixtures/rewrite-status.js';
// Independent behavioural specification: null means the append must be refused.
const expected: Record<Lifecycle, Record<LifecycleFact, Lifecycle | null>> = {
  preparing: { run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'preparing', observe: 'preparing' },
  refused: { run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'refused', observe: 'refused' },
  pending:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'pending', observe: 'pending' },
  running:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'running', obligation: 'parked', observe: 'running' },
  parked:    { run: null, park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'parked', observe: 'parked' },
  completed: { run: null, park: null, complete: null, fail: null, cancel: 'completed', resume: null, obligation: 'completed', observe: 'completed' },
  failed:    { run: null, park: null, complete: null, fail: null, cancel: 'failed', resume: null, obligation: 'failed', observe: 'failed' },
  cancelled: { run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'cancelled', observe: 'cancelled' },
};
it.each((Object.keys(expected) as Lifecycle[]).flatMap(state =>
  (Object.keys(expected[state]) as LifecycleFact[]).map(fact => [state,fact,expected[state][fact]] as const)))('%s × %s at nextLifecycle', (state,fact,next) => {
  expect(nextLifecycle(state,fact)).toBe(next);
});

it.each([
  ['complete','completed'],['accepted_blocked','completed'],['incomplete','failed'],['escalated','failed']
] as const)('maps public %s to lifecycle %s', (status,state) => { expect(lifecycle(status)).toBe(state); });
it.each([
  ['pending',true],['running',true],['parked',true],['complete',false],['accepted_blocked',false],
  ['incomplete',false],['failed',false],['escalated',false],['cancelled',false]
] as const)('prior boot exposes resume only for %s when eligible=%s', (state,eligible) => {
  const {readiness,...host}=wireStatus().host;
  const snapshot = {...wireStatus('Run',state),version:4 as const,host:{...host,boot:'prior'}};
  const observed = withCurrentBoot(snapshot,'current');
  expect(observed.interruption).toEqual(eligible?{detail:'interrupted by restart',resume:'flowcrew resume Run'}:undefined);
  expect(observed.status).toBe(eligible?'interrupted':state);
  expect(observed.journalStatus ?? observed.status).toBe(state);
  expect(withCurrentBoot(snapshot,'prior').interruption).toBeUndefined();
  expect(withCurrentBoot({...snapshot,reclaimed:{at:'2030-01-01T00:00:00.000Z',delivery:'/synthetic/delivery'}},'current').interruption).toBeUndefined();
});

it.each([['active','pending'],['inactive','interrupted'],['unknown','unknown']] as const)(
  'pending activation observes %s before the first invocation', (state,expected) => {
    const base=wireStatus('Run','pending');
    const snapshot={...base,version:3 as const,host:{interpretation:base.host.interpretation,boot:'boot',activation:{state,checkedAt:null,
      owner:{pid:42,group:42,start:'birth',boot:'boot',authority:'bound'}}}};
    const observed=currentStatus(snapshot);
    expect(observed.status).toBe(expected);expect(observed.journalStatus).toBe('pending');
    expect(parsePublicRunStatus(observed).ok).toBe(true);
    const unstarted={...snapshot,host:{...snapshot.host,activation:{state:'unknown' as const,checkedAt:null,owner:null}}};
    expect(currentStatus(unstarted).status).toBe('pending');
  });

it.each([['preparing', false], ['refused', true], ['pending', false], ['running', false], ['parked', false],
  ['complete', true], ['failed', true], ['cancelled', true]] as const)('%s finality comes from the lifecycle table', (status, final) => {
  expect(isFinal(status)).toBe(final);
});
