import './fixtures/rewrite-core-sql.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { retiredLateReclassification, retiredAdmitRelations } from './native/fixtures/public-cli.mjs';
import { putAuthored } from './fixtures/rewrite-bytes.js';
import { stateFixture } from './fixtures/rewrite-core-sql.js';
import { get } from './fixtures/rewrite-sql.js';
import { workflowFixture } from './fixtures/rewrite-workflow.js';
import { runWorkflow } from '../dist-rewrite/core/loop.js';

let temporary: string | undefined;
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
it.each([false, true])('the exact retired block preserves current settlement with bootstrap=%s', async bootstrap => {
  temporary = await mkdtemp(join(process.cwd(), 'dist-rewrite/core/g1b-control-'));
  const source = await readFile(new URL('../dist-rewrite/core/settlement.js', import.meta.url), 'utf8');
  const restored = transformSync(retiredLateReclassification + retiredAdmitRelations, {loader:'ts',format:'esm'}).code;
  const blockEnd = restored.indexOf('function admitRelations');
  const body = restored.slice(0, blockEnd), helper = restored.slice(blockEnd);
  const relocate = (text: string) => text.replace(/from (["'])\.\.\//g, 'from $1../../').replace(/from (["'])\.\//g, 'from $1../');
  const module = relocate(source).replace('// Publication alone owns', body + '\n// Publication alone owns') + '\n' + helper;
  await writeFile(join(temporary, 'settlement.mjs'), "import {planStageStates} from '../../records/state.js';\nimport {dispatchableFrontier} from '../decisions.js';\n" + module);
  const loop = relocate(await readFile(new URL('../dist-rewrite/core/loop.js', import.meta.url), 'utf8'))
    .replace("'../settlement.js'", "'./settlement.mjs'").replace('"../settlement.js"', '"./settlement.mjs"');
  expect(loop).toContain('./settlement.mjs');
  await writeFile(join(temporary, 'loop.mjs'), loop);
  const mutant = await import(pathToFileURL(join(temporary,'loop.mjs')).href);
  const commands = Array.from({length:16},(_,i)=>({id:'Check_'+i,argv:['inert',String(i)],env:{},inputs:[],required:false}));
  const stages = [
    {id:'work',purpose:'work',role:'author',after:[],instruction:'Deliver'},
    {id:'gate',purpose:'gate',role:'author',after:['work'],commands:commands.map(c=>c.id)},
  ];
  const results = [];
  for (const workflow of [runWorkflow, mutant.runWorkflow]) {
    const f = await stateFixture({commands}, bootstrap ? 'bootstrap' : {stages} as never);
    try {
      await f.admit();
      const {ports} = workflowFixture(f);
      const native = ports.attempt;
      if (bootstrap) ports.attempt = async request => {
        const result = await native(request);
        if (!result.ok || request.stage.purpose !== 'plan') return result;
        const answer = {kind:'plan',answer:{baseRevision:request.plan.revision,plan:{stages}}};
        return {ok:true,value:{...result.value,answer,answerRef:putAuthored(Buffer.from(JSON.stringify(answer)))}} as never;
      };
      expect(get(await workflow({writer:f.execution,scope:f.scope,ports,abort:new AbortController().signal})).status).toBe('complete');
      const p = await f.projection();
      expect(p.attempts.every(receipt=>receipt.ending==='delivered')).toBe(true);
      expect(p.commands).toHaveLength(16);
      results.push({endings:p.attempts.map(receipt=>receipt.ending),commands:p.commands.length,states:p.stageStates.map(row=>row.state)});
    } finally { await f.close(); }
  }
  expect(results[1]).toEqual(results[0]);
});
