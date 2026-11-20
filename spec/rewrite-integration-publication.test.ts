import { putAuthored } from './fixtures/rewrite-bytes.js';
import { commandContext } from '../dist-rewrite/exec/policy.js';
import { commandDeclarationIdentity } from '../dist-rewrite/exec/command.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Ref } from '../dist-rewrite/contract/brief.js';
import { gateReview, type AttemptReceipt, type Checkpoint, type CommandKey, type CommandReceipt } from '../dist-rewrite/contract/runtime.js';
import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { reserveCommand, commitCommand } from '../dist-rewrite/records/state.js';
import { settle } from '../dist-rewrite/core/settlement.js';
import { decidePublication } from '../dist-rewrite/core/decisions.js';
let tree: string;
function put(value: string): Ref { return putAuthored(Buffer.from(value)); }
vi.mock('../dist-rewrite/records/state.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  async putEvidence(_journal: unknown, value: Uint8Array) { return { ok: true, value: put(Buffer.from(value).toString()) }; },
}));
vi.mock('../dist-rewrite/records/content.js', async original => ({
  ...await original<typeof import('../dist-rewrite/records/content.js')>(),
  async settleFrozenInputs() { return { ok: true, value: { state: 'unchanged', inputs: [], evidence: [] } }; },
  async captureCheckpoint(scope: any, address: Checkpoint['address'], parent: string | null, state: Checkpoint['state'], evidence: Ref[]) {
    return { ok: true, value: { id: 'Checkpoint', address, parent, state, evidence, tree,
      brief: scope.brief.digest, inputHashes: [], manifest: put('checkpoint') } };
  },
}));
let f: SqlFixture;
beforeEach(() => { tree = 'b'.repeat(64); });
afterEach(async () => { await f.close(); });
it.each([
  ['valid', 'delivered', 'complete', 'completed'],
  ['dependency-edit', 'delivered', 'incomplete', 'command_missing'],
  ['read-and-produced', 'delivered', 'complete', 'completed'],
  ['uncommitted', 'delivered', 'incomplete', 'command_missing'],
  ['broken-lineage', 'delivered', 'incomplete', 'command_missing'],
  ['output-problem', 'delivered', 'incomplete', 'outputs_unpreserved'],
  ['nonzero', 'delivered', 'incomplete', 'command_nonzero'],
  ['unfinished', 'delivered', 'incomplete', 'command_unfinished'],
  ['signalled', 'delivered', 'incomplete', 'command_unfinished'],
  ['missing-command', 'delivered', 'incomplete', 'command_missing'],
  ['missing-input-receipt', 'invalid_answer', null, null],
  ['stale-input-history', 'invalid_answer', null, null],
] as const)('SQL settlement/publication requires the latest applicable receipt on intact lineage: %s', async (fault, ending, status, reason) => {
  const command = { id: 'Evaluate', argv: ['inert-authored-command'], env: {}, inputs: [], required: true };
  const graph = { stages: [{ id: 'gate', purpose: 'gate' as const, role: 'author', after: [], commands: [] }] };
  f = await sqlFixture({ commands: [command] }, graph);
  await f.admit();
  const address = { run: 'Run', stage: 'gate', attempt: 'Attempt', invocation: 1 };
  const generation = put('generation');
  const key: CommandKey = { tree: generation.sha256, declaration: commandDeclarationIdentity(command), inputHashes: [], context: 'c'.repeat(64), execution:commandContext(f.scope.authority,command,'AuthoredExecution'), generation };
  const reservation = fault === 'missing-command' || fault === 'uncommitted' ? null : get(await reserveCommand(f.execution,
    (await f.projection()).cursor, command.id, key, { charge: 'command', address: fault === 'dependency-edit'
      ? {kind:'stage',...address,attempt:'EarlierTree'} : {kind:'stage',...address} }));
  const raw = put('direct command evidence');
  const receipt: CommandReceipt = { command: command.id, key, before: generation.sha256, after: tree,
    stdout: raw, stderr: raw, delta: raw, execution: fault === 'signalled' ? {state:'unfinished',reason:'signalled',signal:'SIGTERM'} : fault === 'unfinished' ? {state:'unfinished',reason:'closure_unknown'} : { state: 'complete', exit: fault === 'nonzero' ? 7 : 0 }, spent: { durationMs: 1 } };
  if (reservation) get(await commitCommand(f.execution, (await f.projection()).cursor, reservation, receipt));
  if(['broken-lineage','dependency-edit'].includes(fault))tree='d'.repeat(64);
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', ...address } } }]);
  const answer = { kind: 'gate' as const, answer: { outcome: 'accepted' as const, reason: 'Authored independent acceptance',
    criteria: { correct: { status: 'pass' as const, evidence: 'Observed result' } }, findings: [], remainingWork: [],
  } };
  const p = await f.projection();
  const provenance = ['missing-command','uncommitted'].includes(fault) ? [] : [{receipt,sourceTree:receipt.after,
    source:{stage:address.stage,attempt:fault === 'dependency-edit' ? 'EarlierTree' : address.attempt,invocation:address.invocation},
    ...(['valid','read-and-produced','output-problem','missing-input-receipt','stale-input-history'].includes(fault) ? {dependencyIntersection:[]} : {})}];
  const input = put('the gate input');
  const review = put(JSON.stringify(gateReview({commands:fault === 'stale-input-history' ? [] : p.commands,lineage:p.lineage},
    ['missing-input-receipt','missing-command','uncommitted'].includes(fault) ? [] : [receipt],provenance)));
  const audit = put(JSON.stringify({address,input,review}));
  const attempt: AttemptReceipt = { address, before: tree, after: tree, ending: 'delivered', closure: 'dead', audit,
    reusedCommands:provenance,evidence: [input], usage: { state: 'unknown', raw: [] }, inputChars: 1, answer, answerRef: put(JSON.stringify(answer)) };
  const result = get(await settle(await f.projection(), attempt, f.execution, { journal: f.journal, brief: f.brief } as never));
  expect(result.receipt.ending).toBe(ending);
  expect(result.projection.attempts.at(-1)?.ending).toBe(ending);
  if (status) {
    await f.append(f.execution, [{ type: 'gate_transition', stage: 'gate', attempt: 'Attempt', outcome: 'accepted', next: null, evidence: [attempt.answerRef!] }]);
    const p=await f.projection();
    const conclusion=get(await decidePublication(f.journal, fault==='uncommitted'?{...p,commands:[receipt]}:p, result.checkpoint,
      { preserved: fault!=='output-problem', artifacts: [], detail: 'Output missing: final.json' }));
    expect(conclusion).toMatchObject({status,reason});
    if(reason?.startsWith('command_'))expect(conclusion.detail).toContain('Evaluate');
    if(reason==='outputs_unpreserved')expect(conclusion.detail).toContain('Output missing: final.json');
    if(fault==='nonzero') {
      const combined=get(await decidePublication(f.journal, p,result.checkpoint,{preserved:false,artifacts:[],detail:'Output kind mismatch: final.json'}));
      expect(combined.detail).toMatch(/Evaluate.*exit 7.*final.json/);
    }
  } else {
    expect(await decidePublication(f.journal, result.projection, result.checkpoint, { preserved: true, artifacts: [], detail: 'retained' }))
      .toMatchObject({ ok: false, kind: 'invalid' });
  }
});
