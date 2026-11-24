import { expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { ActivityWindow, INACTIVITY_WINDOW_MS, sampleActivity, authorActivity, quietObservation, type ExecutionActivity } from '../dist-rewrite/host/activity.js';
const native=vi.hoisted(()=>({identity:vi.fn()}));
vi.mock('../dist-rewrite/host/process.js',()=>({identity:native.identity}));
vi.mock('node:fs/promises',()=>({stat:vi.fn()}));
const sample=(stdout=0,stderr=0)=>({stdout,stderr});
it('command stream progress clears silence; unavailable observations remain unknown',()=>{
  const window=new ActivityWindow();
  expect(window.observe(0,sample())).toBe('observing');
  expect(window.observe(INACTIVITY_WINDOW_MS-1,sample())).toBe('observing');
  expect(window.observe(INACTIVITY_WINDOW_MS,sample())).toBe('quiet');
  const recreated=new ActivityWindow(structuredClone(window.sample));
  expect(recreated.observe(INACTIVITY_WINDOW_MS+1,sample())).toBe('quiet');
  expect(recreated.observe(INACTIVITY_WINDOW_MS+2,sample(1))).toBe('progress');
  expect(window.observe(INACTIVITY_WINDOW_MS+1,sample(1))).toBe('progress');
  expect(window.observe(2*INACTIVITY_WINDOW_MS+1,sample(1))).toBe('quiet');
  expect(window.observe(3*INACTIVITY_WINDOW_MS,null)).toBe('unknown');
  expect(window.observe(4*INACTIVITY_WINDOW_MS,sample())).toBe('observing');
  expect(window.observe(3*INACTIVITY_WINDOW_MS,sample())).toBe('unknown');
});
it('a silent author tool stays quiet through unrelated chatter and clears on its next event',()=>{
  const start='2001-01-01T00:00:00.000Z',at=Date.parse(start);
  const unknown:ExecutionActivity={invocation:{charge:'work',address:{kind:'stage',run:'Run',stage:'work',attempt:'Attempt',invocation:1}},
    source:'author',stage:'work',state:'current',lastEventAt:null,lastTool:null,summary:null,toolRunning:false,observation:'unknown'};
  expect(quietObservation(unknown,at)).toBe('unknown');
  expect(authorActivity(unknown,{kind:'message',at:start,summary:'provider chatter'})).toBe(unknown);
  const running=authorActivity(unknown,{kind:'tool-start',at:start,tool:'Bash',summary:'npm test'});
  expect(quietObservation(running,at-1)).toBe('unknown');
  const chatter=authorActivity(running,{kind:'message',at:new Date(at+INACTIVITY_WINDOW_MS).toISOString(),summary:'unrelated message'});
  expect(chatter).toBe(running);
  expect(quietObservation(chatter,at+INACTIVITY_WINDOW_MS-1)).toBe('progress');
  expect(quietObservation(chatter,at+INACTIVITY_WINDOW_MS)).toBe('quiet');
  const ended=authorActivity(chatter,{kind:'tool-end',at:new Date(at+INACTIVITY_WINDOW_MS+1).toISOString(),tool:'Bash',summary:'passed'});
  expect(quietObservation(ended,at+2*INACTIVITY_WINDOW_MS)).toBe('progress');
  expect(authorActivity(ended,{kind:'turn-end',at:start})).toMatchObject({state:'ended',lastEventAt:ended.lastEventAt});
});
it('stream samples require the same owner birth and both files; no CPU/PID liveness establishes progress',async()=>{
  const owner={pid:42,group:42,start:'birth',boot:'boot',authority:'recorded',streams:{stdout:'out',stderr:'err'}};
  native.identity.mockResolvedValue(owner);vi.mocked(stat).mockResolvedValue({size:7,mtimeMs:1234,isFile:()=>true} as any);
  expect(await sampleActivity(owner)).toEqual({...sample(7,7),lastEventAt:new Date(1234).toISOString()});
  vi.mocked(stat).mockRejectedValueOnce(Error('unavailable'));expect(await sampleActivity(owner)).toBeNull();
  native.identity.mockResolvedValue({...owner,start:'another birth'});expect(await sampleActivity(owner)).toBeNull();
});
