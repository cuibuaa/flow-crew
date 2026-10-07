/** Read-only legacy registry projection. No new run acquires or reconciles leases.
 * The state command consumes archived reservations; retaining only this reader
 * preserves recorded rendering without retaining resource scheduling.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fcGlobalDir } from './store.js';
import { registerEngineOwnedSqlitePath, RESOURCE_LEASE_REGISTRY_FILENAME } from './engine-owned-carriers.js';

const nonempty = z.string().min(1);
const timestamp = nonempty.refine((value) => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp');
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OwnerSchema = z.object({
  runId: nonempty,
  stageId: nonempty.regex(/^[a-z_][a-z0-9_]{0,63}$/),
  attemptIndex: quantity.positive(),
  attemptStartedAt: timestamp,
  generation: nonempty,
  bootId: nonempty.optional(),
  pid: quantity.positive(),
  processStart: z.object({ kind: z.enum(['linux', 'posix-lstart']), value: nonempty }).strict().optional(),
}).strict();

const DiskSchema = z.object({
  path: nonempty,
  filesystemId: nonempty,
  availableBytes: quantity,
  observedAt: timestamp,
}).strict();
const LeaseSchema = z.object({
  leaseId: nonempty,
  fence: quantity.positive(),
  requestId: nonempty,
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  owner: OwnerSchema,
  acquiredAt: timestamp,
  status: z.enum(['active', 'released']),
  gpuCards: z.array(nonempty),
  gpuObservedAt: timestamp.optional(),
  disk: z.array(DiskSchema.extend({ bytes: quantity.positive(), minimumFreeBytes: quantity })),
  release: z.object({ at: timestamp, kind: z.enum(['attempt_finished', 'owner_dead']), evidence: nonempty }).strict().optional(),
}).strict();
export type ResourceLease = z.infer<typeof LeaseSchema>;
const EventSchema = z.object({
  revision: quantity.positive(),
  at: timestamp,
  kind: z.enum(['acquired', 'refused', 'released', 'retained']),
  requestId: nonempty.optional(),
  leaseId: nonempty.optional(),
  reason: nonempty,
}).strict();
const SnapshotSchema = z.object({
  version: z.literal(1),
  revision: quantity,
  nextFence: quantity.positive(),
  leases: z.array(LeaseSchema),
  history: z.array(EventSchema),
}).strict();
export type ResourceLeaseSnapshot = z.infer<typeof SnapshotSchema>;
export type ResourceLeaseRegistryRead =
  | { status: 'absent'; path: string; reason: string }
  | { status: 'available'; path: string; snapshot: ResourceLeaseSnapshot; sha256: string };
export class ResourceLeaseError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ResourceLeaseError';
  }
}

function hash(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : entry;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function resourceLeaseRegistryPath(storeRoot = fcGlobalDir()): string {
  return join(resolve(storeRoot), RESOURCE_LEASE_REGISTRY_FILENAME);
}

function sqliteConstructor(): typeof import('node:sqlite').DatabaseSync {
  try { return createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch (error) {
    throw new ResourceLeaseError('RESOURCE_REGISTRY_UNAVAILABLE', 'this runtime must provide node:sqlite to arbitrate leases; no reservation was granted', { cause: error });
  }
}

function readSnapshot(db: DatabaseSync): ResourceLeaseSnapshot {
  try {
    const row = db.prepare('SELECT data FROM resource_registry WHERE id = 1').get();
    const snapshot = SnapshotSchema.parse(JSON.parse(String(row?.data)));
    const ids = snapshot.leases.map((lease) => lease.leaseId);
    const fences = snapshot.leases.map((lease) => lease.fence);
    const requests = snapshot.leases.map((lease) => lease.requestId);
    const activeCards = snapshot.leases.filter((lease) => lease.status === 'active').flatMap((lease) => lease.gpuCards);
    if (new Set(ids).size !== ids.length || new Set(fences).size !== fences.length || new Set(requests).size !== requests.length || new Set(activeCards).size !== activeCards.length
      || fences.some((fence) => fence >= snapshot.nextFence)
      || snapshot.history.length !== snapshot.revision
      || snapshot.history.some((event, index) => event.revision !== index + 1)
      || snapshot.leases.some((lease) => (lease.status === 'released') !== Boolean(lease.release))) {
      throw new Error('inconsistent fence, release or history lineage');
    }
    return snapshot;
  } catch (error) {
    throw new ResourceLeaseError('RESOURCE_REGISTRY_INVALID', 'registry schema/history is malformed; reservations were not discarded', { cause: error });
  }
}

/** No initialization, reconciliation or writes during a query. */
export function readResourceLeaseRegistry(path: string): ResourceLeaseRegistryRead {
  const resolved = resolve(path);
  registerEngineOwnedSqlitePath(resolved);
  if (!existsSync(resolved)) return { status: 'absent', path: resolved, reason: 'no engine resource registry has been recorded' };
  const db = new (sqliteConstructor())(resolved, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const snapshot = readSnapshot(db);
    return { status: 'available', path: resolved, snapshot, sha256: hash(snapshot) };
  } finally { db.close(); }
}

