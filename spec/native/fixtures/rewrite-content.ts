import { fixtureAuthority } from "../../fixtures/rewrite-authority.js";
import { afterEach, beforeEach } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Input, Output, Ref, Result } from "../../../dist-rewrite/contract/brief.js";
import type { Checkpoint, JournalPayload, Writer } from "../../../dist-rewrite/contract/runtime.js";
import { captureCheckpoint, settleFrozenInputs, type ContentScope } from "../../../dist-rewrite/records/content.js";
import { appendEvents, readEvents } from "../../../dist-rewrite/records/state.js";
import { readEvidence } from "../../../dist-rewrite/records/evidence.js";
import { stateFixture } from "../../fixtures/rewrite-state.js";
export const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export async function manifest(ref: Ref): Promise<any> { return JSON.parse(Buffer.from(known(await readEvidence(scope.journal, ref))).toString()); }
export function known<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(result.kind + ': ' + result.detail); return result.value; }
export let root: string;
export let scope: ContentScope;
export let writer: Writer;
export async function record(payload: JournalPayload) { known(await appendEvents(writer, known(await readEvents(scope.journal, 0)).length, [payload])); }
export function declarations(inputs: readonly Input[] = [], outputs: readonly Output[] = []) {
  scope = { ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, inputs, outputs } } };
  scope.authority = fixtureAuthority(scope);
}
export async function checkpoint(state: Checkpoint['state'] = 'safe') {
  const cp = known(await captureCheckpoint(scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, state, [], known(await settleFrozenInputs(scope)).inputs));
  await record({ type: 'checkpoint', checkpoint: cp });
  return cp;
}
let f: Awaited<ReturnType<typeof stateFixture>>;
beforeEach(async () => {
  f = await stateFixture({}, { stages: [{ id: 'work', purpose: 'work', role: 'author', after: [], instruction: 'Work',  }] });
  await f.admit();
  root = f.root;
  scope = f.scope;
  writer = f.execution;
  await mkdir(join(root, 'runtime'));
});
afterEach(async () => { await f.close(); });
export function setScope(value: ContentScope) { scope = value; }
