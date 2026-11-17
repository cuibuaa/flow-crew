import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sqlFixture } from './rewrite-sql.js';
import { putAuthored } from './rewrite-bytes.js';
const tree = 'b'.repeat(64);
vi.mock('../../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/records/state.js')>(),
  async putEvidence(_journal: unknown, value: Uint8Array) { return {ok:true,value:putAuthored(value)}; },
}));
// These tests exercise real SQL settlement. Native content/authentication has
// separate end-to-end consumers, including the retained high-water workflow.
vi.mock('../../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/records/content.js')>(),
  async captureTree() { return {ok:true,value:tree}; },
  async settleFrozenInputs() { return {ok:true,value:{state:'unchanged',inputs:[],evidence:[]}}; },
  async captureCheckpoint(scope: any, address: any, parent: any, state: any, evidence: any) {
    return {ok:true,value:{id:'cp_'+randomUUID(),address,parent,state,evidence,tree,brief:scope.brief.digest,inputHashes:[],
      manifest:putAuthored(Buffer.from('authored checkpoint'))}};
  },
  async preserveOutputs() { return {ok:true,value:{preserved:true,artifacts:[],detail:'Authored output effect'}}; },
}));
export async function stateFixture(...args: Parameters<typeof sqlFixture>) {
  const f = await sqlFixture(...args);
  putAuthored(Buffer.from('---\n'+JSON.stringify((({body,...rest})=>rest)(f.brief.declaration))+'\n---\n'+f.brief.declaration.body));
  const ref = putAuthored(Buffer.from('authored audit'));
  return {...f,ref,scope:{...f.scope,journal:f.journal,brief:f.brief},tree:async()=>tree};
}
export type StateFixture = Awaited<ReturnType<typeof stateFixture>>;
