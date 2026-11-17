import { putAuthored } from './fixtures/rewrite-bytes.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Ref } from '../dist-rewrite/contract/brief.js';
import type { AttemptReceipt, Checkpoint, CommandKey, CommandReceipt, ObservedPath } from '../dist-rewrite/contract/runtime.js';
import { sqlFixture, get, type SqlFixture } from './fixtures/rewrite-sql.js';
import { reserveCommand, commitCommand } from '../dist-rewrite/records/state.js';
import { settle } from '../dist-rewrite/core/settlement.js';
import { decidePublication } from '../dist-rewrite/core/decisions.js';
let observed: ObservedPath[], tree: string;
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
      brief: scope.brief.digest, inputHashes: [], manifest: put('checkpoint'), observed } };
  },
}));
let f: SqlFixture;
beforeEach(() => { tree = 'b'.repeat(64); });
afterEach(async () => { await f.close(); });
it.each([
  ['valid', 'delivered', 'complete'],
  ['dependency-edit', 'invalid_answer', null],
  ['read-and-produced', 'invalid_answer', null],
  ['nonzero', 'invalid_answer', null],
  ['missing-receipt', 'invalid_answer', null],
  ['wrong-context', 'invalid_answer', null],
] as const)('SQL settlement/publication retains the independent source floor: %s', async (fault, ending, status) => {
  const command = { id: 'Evaluate', argv: ['inert-authored-command'], env: {}, inputs: [], required: true };
  const graph = { stages: [{ id: 'gate', purpose: 'gate' as const, role: 'author', after: [], commands: [], instruction: 'Independent review', skills: [] }] };
  f = await sqlFixture({ commands: [command] }, graph);
  await f.admit();
  const before = [ { path: 'dependency.txt', identity: put('original dependency') },
    { path: 'final.json', identity: put('original result') } ];
  const after = before.map(item => ({ ...item }));
  if (fault === 'read-and-produced') after[1] = { ...after[1], identity: put('produced result') };
  observed = after.map(item => ({ ...item }));
  if (fault === 'dependency-edit') observed[0] = { ...observed[0], identity: put('changed dependency') };
  const generation = put('generation');
  const key: CommandKey = { tree: generation.sha256, declaration: 'a'.repeat(64), inputHashes: [], context: 'c'.repeat(64), generation,
    observation: { command: command.id, criterionIds: ['correct'], sources: fault === 'read-and-produced'
      ? ['dependency.txt', 'final.json'] : ['dependency.txt'], products: ['final.json'] } };
  const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
    { charge: 'command', address: { kind: 'setup', run: 'Run' } }));
  const raw = put('direct command evidence');
  const receipt: CommandReceipt = { command: command.id, key, before: generation.sha256, after: tree,
    stdout: raw, stderr: raw, delta: raw, observed: { before, after }, execution: { state: 'complete', exit: fault === 'nonzero' ? 7 : 0 }, spent: { durationMs: 1 } };
  get(await commitCommand(f.execution, (await f.projection()).cursor, reservation, receipt));
  const address = { run: 'Run', stage: 'gate', attempt: 'Attempt', invocation: 1 };
  await f.append(f.execution, [{ type: 'invocation_reserved', invocation: { charge: 'work', address: { kind: 'stage', ...address } } }]);
  const answer = { kind: 'gate' as const, answer: { outcome: 'accepted' as const, reason: 'Authored independent acceptance',
    criteria: { correct: { status: 'pass' as const, evidence: 'Observed result' } }, findings: [], remainingWork: [],
    ...(fault === 'missing-receipt' ? {} : { commandEvidence: [{ command: command.id, context: fault === 'wrong-context' ? 'wrong' : key.context,
      executions: [key.context] }] }) } };
  const attempt: AttemptReceipt = { address, before: tree, after: tree, ending: 'delivered', closure: 'dead', audit: raw,
    evidence: [], usage: { state: 'unknown', raw: [] }, inputChars: 1, answer, answerRef: put(JSON.stringify(answer)) };
  const result = get(await settle(await f.projection(), attempt, f.execution, { journal: f.journal, brief: f.brief } as never));
  expect(result.receipt.ending).toBe(ending);
  expect(result.projection.attempts.at(-1)?.ending).toBe(ending);
  if (status) {
    await f.append(f.execution, [{ type: 'gate_transition', stage: 'gate', attempt: 'Attempt', outcome: 'accepted', next: null, evidence: [attempt.answerRef!] }]);
    expect(get(decidePublication(await f.projection(), result.checkpoint, { preserved: true, artifacts: [], detail: 'retained' })).status).toBe(status);
  } else {
    expect(decidePublication(result.projection, result.checkpoint, { preserved: true, artifacts: [], detail: 'retained' }))
      .toMatchObject({ ok: false, kind: 'invalid' });
  }
});
