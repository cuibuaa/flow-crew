import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ActivityKind, LiveHooks } from '../contract/live.js';
import type { Ref, Result } from '../contract/brief.js';
import type { BackendRequest, OwnedProgram, ProcessReceipt, Journal } from '../contract/runtime.js';
import { launchInvocation, type ProcessPorts, type InvocationIO } from '../host/process.js';
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
  readonly malformed: boolean;
}

/** A line is assembled once, even when a provider fragments a large event across many writes. */
export function protocolDecoder(event: (event: Record<string, unknown>) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hash = createHash('sha256');
  let parts: string[] = [], malformed = false;
  const line = (text: string) => {
    if (!text.trim()) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { malformed = true; return; }
    event(value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
  };
  const text = (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
      parts.push(chunk.slice(start, end)); line(parts.join('')); parts = []; start = end + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  };
  return {
    write(bytes: Uint8Array) {
      hash.update(bytes);
      let decoded: string;
      try { decoded = decoder.decode(bytes, { stream: true }); } catch { malformed = true; return; }
      text(decoded);
    },
    finish() {
      let tail = '';
      try { tail = decoder.decode(); } catch { malformed = true; }
      text(tail);
      if (parts.length) line(parts.join('')); parts = [];
      return { malformed, sha256: hash.digest('hex') };
    }
  };
}

export interface ProviderStream extends Pick<InvocationIO, 'input' | 'onReady'> {
  readonly event: (event: Record<string, unknown>) => void;
}

/** Activity is advisory; consumer failures cannot interrupt authoritative decoding. */
export function observeActivity(live: LiveHooks | undefined, kind: ActivityKind, tool?: string): void {
  try {
    live?.onActivity?.({ at: new Date().toISOString(), kind, ...(tool ? { tool } : {}),
      summary: kind === 'message' ? 'Assistant message' : kind === 'turn-end' ? 'Turn ended' : 'Provider tool ' + kind });
  } catch { /* The retained native stream remains authoritative. */ }
}

/** Launch the exact provider program once with its invocation context. */
export async function invokeBackend(request: BackendRequest, program: OwnedProgram, context: TransportContext, stream?: ProviderStream): Promise<Result<NativeReply>> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const entries = (env: Readonly<Record<string, string>>) => Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  if (typeof request.scratch !== 'string' || !isAbsolute(request.scratch) || resolve(request.scratch) !== request.scratch
    || program.cwd !== request.project
    || !same(program.stdin, request.input) || program.durationMs !== request.durationMs
    || !same(entries(program.env), entries(context.privateEnvironment))
    || program.argv.length === 0 || program.argv.some(value => value.includes('\0')))
    return { ok: false, kind: 'invalid', detail: 'Backend program differs from supplied invocation' };
  const input = await context.process.readEvidence(request.input);
  if (!input.ok) return input;
  const decoder = protocolDecoder(stream?.event ?? (() => {}));
  const process = await launchInvocation({ git: request.git },
    { ...program, env: { TMPDIR: request.scratch, ...program.env } }, context.process, request.abort, { ...stream, onStdout: bytes => decoder.write(bytes) });
  if (!process.ok) return process;
  const decoded = decoder.finish();
  // Provisional observations are unauthenticated; final acceptance authenticates both retained streams.
  for (const ref of [process.value.stdout, process.value.stderr]) {
    const bytes = await readEvidence(context.journal, ref);
    if (!bytes.ok) return bytes;
  }
  if (decoded.sha256 !== process.value.stdout.sha256)
    return { ok: false, kind: 'conflict', detail: 'Observed provider stream differs from retained evidence' };
  return { ok: true, value: { process: process.value, raw: [process.value.stdout, process.value.stderr], malformed: decoded.malformed } };
}
