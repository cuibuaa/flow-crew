import { expect, it } from 'vitest';
import { interpretAuthority } from '../dist-rewrite/exec/policy.js';
import type { Brief } from '../dist-rewrite/contract/brief.js';
// Literal disposition truth table; wrong-kind observations are independent negative cases.
it.each([
  ['create','absent',true,'absent',false],['create','file',false,'absent',false],
  ['update','absent',false,'present',false],['update','file',true,'present',false],
  ['append','absent',false,'present',true],['append','file',true,'present',true],
  ['replace','absent',true,'either',false],['replace','file',true,'either',false],
] as const)('%s with original %s admitted=%s', (existing,original,admitted,admission,append) => {
  for (const kind of ['file','directory'] as const) {
    const brief: Brief = {criteria:[{id:'correct',text:'Reviewed'}],inputs:[],outputs:[{path:'out',kind,existing}],
      commands:[],results:[],allowBlocked:false,body:'Opaque goal'};
    const runtime = {project:'/synthetic/project',protectedRoots:[],workRoot:'/synthetic/work'};
    const result = interpretAuthority(brief,runtime,[original==='absent'?'absent':kind]);
    expect(result.ok).toBe(admitted);
    if (admitted) expect(result).toMatchObject({ok:true,value:{outputs:[{path:'out',absolute:'/synthetic/project/out',kind,
      admission,original:original==='absent'?'absent':kind,write:'project',baseline:'original-manifest',
      delivery:{original:admission,append,nonempty:false}}]}});
    expect(interpretAuthority(brief,runtime,[kind==='file'?'directory':'file'])).toMatchObject({ok:false,kind:'invalid'});
  }
});
