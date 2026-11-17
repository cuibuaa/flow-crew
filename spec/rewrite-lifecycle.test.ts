import { expect, it } from 'vitest';
import { sqlFixture, get } from './fixtures/rewrite-sql.js';
import { appendEvents, lifecycle, type Lifecycle, type LifecycleFact } from '../dist-rewrite/records/state.js';
import type { JournalPayload, Conclusion } from '../dist-rewrite/contract/runtime.js';
// Independent behavioural specification: null means the append must be refused.
const expected: Record<Lifecycle, Record<LifecycleFact, Lifecycle | null>> = {
  pending:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'pending', observe: 'pending' },
  running:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'running', obligation: 'parked', observe: 'running' },
  parked:    { run: null, park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'parked', observe: 'parked' },
  completed: { run: null, park: null, complete: null, fail: null, cancel: 'completed', resume: null, obligation: 'completed', observe: 'completed' },
  failed:    { run: null, park: null, complete: null, fail: null, cancel: 'failed', resume: null, obligation: 'failed', observe: 'failed' },
  cancelled: { run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'cancelled', observe: 'cancelled' },
};
const endings: Partial<Record<Lifecycle, Conclusion>> = {
  parked:{status:'parked',reason:'attempt_failed',detail:'Paused'},
  completed:{status:'complete',reason:'completed',detail:'Done'},
  failed:{status:'failed',reason:'attempt_failed',detail:'Failed'},
  cancelled:{status:'cancelled',reason:'cancelled',detail:'Cancelled'}
};
it.each((Object.keys(expected) as Lifecycle[]).flatMap(state =>
  (Object.keys(expected[state]) as LifecycleFact[]).map(fact => [state,fact,expected[state][fact]] as const)))('%s × %s through appendEvents and projection', async (state,fact,next) => {
  const f = await sqlFixture();
  try {
    await f.admit();
    if (state === 'running') await f.append(f.execution,[{type:'stage_settled',stage:'work',state:'running',evidence:[]}]);
    else if (endings[state]) await f.append(f.execution,[{type:'lifecycle',conclusion:endings[state]!}]);
    const before = await f.projection();
    expect(lifecycle(before.status)).toBe(state);
    const payloads: Record<LifecycleFact,JournalPayload> = {
      run:{type:'invocation_reserved',invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Attempt',invocation:1}}},
      park:{type:'lifecycle',conclusion:endings.parked!}, complete:{type:'lifecycle',conclusion:endings.completed!},
      fail:{type:'lifecycle',conclusion:endings.failed!},
      cancel:{type:'control_intent',intent:{id:'Cancel',kind:'cancel',run:'Run',unit:f.launch.unit,expectedCursor:before.cursor}},
      resume:{type:'control_intent',intent:{id:'Resume',kind:'resume',run:'Run',unit:f.launch.unit,expectedCursor:before.cursor}},
      obligation:{type:'obligation',open:true,obligation:{kind:'closure-unconfirmed',detail:'Dead activation',members:[]}},
      observe:{type:'run_observed',observation:{unit:f.launch.unit,state:'inactive',owner:null,evidence:[],detail:'Confirmed inactive'}}
    };
    const result = await appendEvents(fact === 'run' || ['park','complete','fail'].includes(fact) ? f.execution : f.control,null,[payloads[fact]]);
    if (next === null) { expect(result).toMatchObject({ok:false,kind:'conflict'}); expect(await f.projection()).toEqual(before); }
    else {
      get(result);
      const projected = await f.projection();
      expect(lifecycle(projected.status)).toBe(next);
      if (state === 'running' && fact === 'obligation') expect(projected.conclusion?.reason).toBe('closure_unconfirmed');
    }
  } finally { await f.close(); }
});
