import { beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Ref } from '../../dist-rewrite/contract/brief.js';
const authoredBytes = vi.hoisted(() => new Map<string, Uint8Array>());
export function evidenceBytes() { return authoredBytes; }
beforeEach(() => authoredBytes.clear());
export function putAuthored(bytes: Uint8Array): Ref {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ref = { path: 'authored/' + sha256, sha256 };
  authoredBytes.set(ref.path, Uint8Array.from(bytes));
  return ref;
}
function readAuthored(ref: Ref) {
  const value = authoredBytes.get(ref.path);
  return value && createHash('sha256').update(value).digest('hex') === ref.sha256
    ? { ok: true as const, value } : { ok: false as const, kind: 'unavailable' as const, detail: 'missing authored evidence' };
}
// SQL/parser tests own bytes; native tests retain the real Git authentication boundary.
vi.mock('../../dist-rewrite/records/evidence.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/records/evidence.js')>(),
  async initializeEvidence() {},
  async putEvidence(_journal: unknown, value: Uint8Array) { return { ok: true, value: putAuthored(value) }; },
  async readEvidence(_journal: unknown, ref: Ref) { return readAuthored(ref); },
  async validateRecordRef(_journal: unknown, ref: Ref) {
    const result = readAuthored(ref);
    return result.ok ? { ok: true, value: ref } : result;
  },
}));
