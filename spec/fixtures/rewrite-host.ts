import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as host from '../../dist-rewrite/host/process.js';
import * as state from '../../dist-rewrite/records/state.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import type { Result } from '../../dist-rewrite/contract/brief.js';
export const known = <T>(value: Result<T>): T => { if (!value.ok)
  throw Error(JSON.stringify(value), { cause: value }); return value.value; };
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function wait(test: () => Promise<boolean>, finished?: Promise<unknown> | (() => Promise<unknown | undefined>), signal?: AbortSignal) {
  let ended = false, outcome: unknown;
  const complete = (value: unknown) => { ended = true; outcome = value; };
  if (finished && typeof finished !== 'function') void finished.then(complete, complete);
  while (true) {
  signal?.throwIfAborted();
  if (await test())
    return;
  if (typeof finished === 'function') { const value = await finished(); if (value !== undefined) complete(value); }
  if (ended) throw Error('Operation finished before its expected condition: ' + JSON.stringify(outcome, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, cause: value.cause } : value), { cause: outcome });
  await pause(10);
} }
export async function fixture(workName = 'work') {
  const base = await mkdtemp(join(tmpdir(), 'flowcrew-host-')), work = join(base, workName), records = join(work, 'records'),
   scratch = join(work, 'tmp'), outside = join(base, 'outside'), home = join(base, 'home');
  const caseEvidenceRoot = join(base, 'evidence');
  await mkdir(caseEvidenceRoot, { recursive: true });
  await writeFile(join(caseEvidenceRoot, 'environment.json'), JSON.stringify({ platform: process.platform, node: process.version, arch: process.arch }));
  for (const path of [work, records, scratch, outside, home])
    await mkdir(path, { recursive: true });
  const location = { database: join(home, 'state.sqlite'), storeRoot: records, run: 'host_case' };
  known(state.initializeState(location.database));
  const journal = known(await state.openJournal(location, 'create'));
  const claim = known(await state.claim(join(journal.root, 'control'), null, { database: location.database, holder: journal.root }));
  const writer = known(await state.openWriter(journal, claim, 'control'));
  const ports = { streamRoot: journal.root, scratch,
    operation: <T>(request: any) => state.recordOperation<T>(journal, 'construct', request),
    putEvidence: (bytes: Uint8Array) => state.putEvidence(journal, bytes),
    storeEvidence: (source: () => AsyncIterable<Uint8Array>) => state.storeEvidence(journal, source),
    readEvidence: (ref: any) => readEvidence(journal, ref),
    recordProcess: async (payload: any) => { const events = known(await state.readEvents(journal, 0)); return state.appendEvents(writer,
     events.at(-1)?.seq ?? 0, [payload]); },
  };
  const grant = { writableRoots: [work], protectedRoots: [records] };
  const launch = async (code: string, options: any = {}) => {
    const result = await host.launchInvocation(options.grant ?? grant, { argv: [process.execPath, '-e', code, ...(options.args ?? [])], cwd: work,
      env: { PATH: process.env.PATH!, HOME: home, TMPDIR: scratch, ...options.env },
       writableRoots: (options.grant ?? grant).writableRoots, ...options.program }, ports, options.abort ?? new AbortController().signal);
    if (!result.ok)
      await evidence('launch-refusal', result);
    return known(result);
  };
  const text = async (ref: any) => Buffer.from(known(await readEvidence(journal, ref))).toString();
  const evidence = async (name: string, value: unknown) => {
    const observation = { platform: process.platform, node: process.version, ...value as object };
    process.stderr.write('Native evidence ' + name + ' ' + JSON.stringify(observation) + '\n');
    await writeFile(join(caseEvidenceRoot, name + '.json'), JSON.stringify(observation, null, 2));
  };
  const originalCwd = process.cwd();
  const close = async () => { await host.closeController(); process.chdir(originalCwd);
   known(await state.reclaimRecordOperations(journal)); known(await state.release(claim, 'retire')); await rm(base, { recursive: true,
   force: true }); };
  return { base, work, records, scratch, outside, home, location, journal, writer, ports, grant, launch, text, evidence, close };
}
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
