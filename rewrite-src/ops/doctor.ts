import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkReadiness, performOperation, type ProcessPorts } from '../host/process.js';
import type { Ref, Result } from '../contract/brief.js';
import type { GrantReceipt } from '../contract/runtime.js';

/** Ephemeral diagnostic, using the real launch primitive and its host-owned reason + fix. */
export async function doctor(environment: Readonly<Record<string, string>>, abort: AbortSignal): Promise<GrantReceipt> {
  const scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'flowcrew-doctor-')));
  const blobs = new Map<string, Uint8Array>(); let cursor = 0;
  const put = async (bytes: Uint8Array): Promise<Result<Ref>> => {
    const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes);
    return { ok: true, value: { path: 'probe/' + sha256, sha256 } };
  };
  const ports: ProcessPorts = { operation: performOperation, scratch, streamRoot: scratch, putEvidence: put,
    readEvidence: async ref => blobs.has(ref.sha256) ? { ok: true, value: blobs.get(ref.sha256)! }
      : { ok: false, kind: 'unavailable', detail: 'Diagnostic stream unavailable' },
    storeEvidence: async source => { const parts: Uint8Array[] = []; for await (const bytes of source()) parts.push(bytes);
      return put(Buffer.concat(parts)); }, recordProcess: async () => ({ ok: true, value: ++cursor }) };
  try {
    return await checkReadiness({ writableRoots: [scratch], protectedRoots: [] }, {
      writableRoots: [scratch], argv: [process.execPath, '-e', 'process.exit(0)'], cwd: scratch,
      env: { PATH: environment.PATH ?? '', TMPDIR: scratch }, stdin: (await put(new Uint8Array()) as { ok: true; value: Ref }).value
    }, ports, abort);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
