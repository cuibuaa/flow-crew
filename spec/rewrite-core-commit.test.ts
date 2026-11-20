import { afterEach, expect, it, vi } from 'vitest';
import { commitDecision } from '../dist-rewrite/core/commit.js';
import { appendEvents, readProjection } from '../dist-rewrite/records/state.js';
vi.mock('../dist-rewrite/records/state.js',()=>({appendEvents:vi.fn(),readProjection:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it.each([3,2])('a cursor refusal without strictly increasing progress returns at cursor %i',async cursor=>{
  vi.mocked(readProjection).mockResolvedValueOnce({ok:true,value:{cursor:3}} as any)
    .mockResolvedValue({ok:true,value:{cursor}} as any);
  vi.mocked(appendEvents).mockResolvedValue({ok:false,kind:'conflict',detail:'authored CAS refusal',staleCursor:true});
  const decide=vi.fn(()=>({ok:true as const,value:{value:null,records:[{type:'accounting_interrupted' as const}]}}));
  expect(await commitDecision({journal:{}} as any,decide)).toMatchObject({ok:false,kind:'conflict',detail:'Decision conflict without journal progress'});
  expect(decide).toHaveBeenCalledTimes(1);
  expect(appendEvents).toHaveBeenCalledTimes(1);
});
