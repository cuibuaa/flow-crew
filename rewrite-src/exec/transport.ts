import { isAbsolute, resolve } from 'node:path';
import type { Ref, Result } from '../contract/brief.js';
import type { BackendRequest, OwnedProgram, ProcessReceipt, Journal, GrantRequest } from '../contract/runtime.js';
import { launchInvocation, type ProcessPorts } from '../host/process.js';
import { readEvidence } from '../records/evidence.js';

/** Explicit private environment; transport never discovers authentication. */
export interface TransportContext {
  readonly journal: Journal;
  readonly process: ProcessPorts;
  readonly privateEnvironment: Readonly<Record<string, string>>;
}
/** Raw protocol and owned descendant closure. */
export interface NativeReply {
  readonly process: ProcessReceipt;
  readonly raw: readonly Ref[];
}

/** Launch the exact provider program once through required native confinement. */
export async function invokeBackend(request: BackendRequest, program: OwnedProgram, context: TransportContext): Promise<Result<NativeReply>> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const entries = (env: Readonly<Record<string, string>>) => Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  if (typeof request.scratch !== 'string' || !isAbsolute(request.scratch) || resolve(request.scratch) !== request.scratch
    || !request.writableRoots.includes(request.scratch) || !same(program.writableRoots, request.writableRoots) || program.cwd !== request.project
    || !same(program.stdin, request.input) || program.durationMs !== request.durationMs
    || !same(entries(program.env), entries(context.privateEnvironment))
    || program.argv.length === 0 || program.argv.some(value => value.includes('\0')))
    return { ok: false, kind: 'invalid', detail: 'Backend program differs from supplied invocation' };
  const input = await context.process.readEvidence(request.input);
  if (!input.ok) return input;
  // Preserve explicit grant fields; private Git authority is never discovered from paths.
  const grant: GrantRequest = request;
  const process = await launchInvocation({
    aliases: request.aliases, writableRoots: grant.writableRoots,
    ...(grant.git ? { git: grant.git } : {}), protectedRoots: [...new Set([...request.protectedRoots, context.journal.root])]
  },
    { ...program, env: { ...program.env, TMPDIR: request.scratch } }, context.process, request.abort);
  if (!process.ok) return process;
  // Authenticate both streams before exposing any protocol bytes.
  for (const ref of [process.value.stdout, process.value.stderr]) {
    const bytes = await readEvidence(context.journal, ref);
    if (!bytes.ok) return bytes;
  }
  return { ok: true, value: { process: process.value, raw: [process.value.stdout, process.value.stderr] } };
}
