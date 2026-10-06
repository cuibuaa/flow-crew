import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { processStartToken, type ProcessStartToken } from './run-lock.js';
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
export type ResourceLeaseOwner = z.infer<typeof OwnerSchema>;

const RequestSchema = z.object({
  version: z.literal(1),
  requestId: nonempty,
  owner: OwnerSchema,
  gpuCards: z.array(nonempty).default([]),
  disk: z.array(z.object({
    path: nonempty.refine(isAbsolute, 'expected an absolute disk path'),
    bytes: quantity.positive(),
    minimumFreeBytes: quantity.default(0),
  }).strict()).default([]),
}).strict();
export type ResourceLeaseRequest = z.input<typeof RequestSchema>;

const DiskSchema = z.object({
  path: nonempty,
  filesystemId: nonempty,
  availableBytes: quantity,
  observedAt: timestamp,
}).strict();
export type DiskHeadroom = z.infer<typeof DiskSchema>;
export interface GpuInventory { cardIds: string[]; observedAt: string }
export type ResourceOwnerObservation =
  | { kind: 'live'; reason: string }
  | { kind: 'dead'; reason: string }
  | { kind: 'unknown'; reason: string };
export type ResourceConsumerClosure = { kind: 'closed' | 'unknown'; evidence: string };

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
export interface ResourceLeaseHandle { leaseId: string; fence: number; owner: ResourceLeaseOwner }
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
export type ResourceLeaseDecision =
  | { ok: true; lease: ResourceLease; handle: ResourceLeaseHandle; replayed: boolean }
  | { ok: false; code: string; reason: string; blockingLeaseIds: string[] };
export type ResourceLeaseReleaseProof =
  | { kind: 'attempt_finished'; runDirectory: string }
  | { kind: 'owner_dead' };

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

export function readHostBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}

/** Capture a holder, not an expiring reservation. Missing identity stays missing. */
export function captureResourceLeaseOwner(
  execution: Pick<ResourceLeaseOwner, 'runId' | 'stageId' | 'attemptIndex' | 'attemptStartedAt' | 'generation'>,
): ResourceLeaseOwner {
  return OwnerSchema.parse({ ...execution, pid: process.pid, bootId: readHostBootId(), processStart: processStartToken(process.pid) });
}

/** Read-only process evidence; never signal a holder or infer death from age. */
export function observeResourceLeaseOwner(owner: ResourceLeaseOwner): ResourceOwnerObservation {
  const bootId = readHostBootId();
  if (owner.bootId && bootId && owner.bootId !== bootId) return { kind: 'dead', reason: 'holder belongs to a previous host boot' };
  if (!owner.bootId || !bootId || !owner.processStart) return { kind: 'unknown', reason: 'boot or process-start identity is unavailable' };
  if (process.platform !== 'linux') return { kind: 'unknown', reason: 'process absence cannot be proven by the available platform probe' };
  try {
    const raw = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
    const current: ProcessStartToken = { kind: 'linux', value: fields[19] ?? '' };
    if (!/^\d+$/.test(current.value) || owner.processStart.kind !== current.kind) return { kind: 'unknown', reason: 'process-start identity cannot be compared' };
    if (owner.processStart.value !== current.value) return { kind: 'unknown', reason: 'controller PID was reused; delegated resource-consumer fate is unproven' };
    if (fields[0] === 'Z' || fields[0] === 'X') return { kind: 'unknown', reason: 'controller exited; delegated resource-consumer fate is unproven' };
    return { kind: 'live', reason: 'boot and process-start identities match a live holder' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'unknown', reason: 'controller process is absent on the same boot; delegated resource-consumer fate is unproven' }
      : { kind: 'unknown', reason: 'process identity is unreadable' };
  }
}

/** Physical filesystem identity groups aliases; this is an observation, not a quota. */
export function readDiskHeadroom(path: string, observedAt = new Date().toISOString()): DiskHeadroom {
  const canonical = realpathSync(path);
  const stats = statfsSync(canonical, { bigint: true });
  const available = stats.bavail * stats.bsize;
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) throw new ResourceLeaseError('DISK_QUANTITY_UNREPRESENTABLE', `available bytes cannot be represented safely for ${canonical}`);
  return DiskSchema.parse({ path: canonical, filesystemId: String(statSync(canonical, { bigint: true }).dev), availableBytes: Number(available), observedAt });
}

function emptySnapshot(): ResourceLeaseSnapshot {
  return { version: 1, revision: 0, nextFence: 1, leases: [], history: [] };
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

export interface ResourceLeaseRegistryOptions {
  registryPath: string;
  gpuInventory?: () => GpuInventory;
  diskHeadroom?: (path: string) => DiskHeadroom;
  observeOwner?: (owner: ResourceLeaseOwner) => ResourceOwnerObservation;
  /** Trusted engine proof of ALL delegated consumers, not just controller exit.
   * Without this verifier, an attempt status alone cannot release a lease. */
  verifyAttemptClosure?: (lease: ResourceLease, runDirectory: string) => ResourceConsumerClosure;
  now?: () => string;
  busyTimeoutMs?: number;
  maximumObservationAgeMs?: number;
}

/** All cooperating runs on a host must use the same engine-owned registry. */
export class ResourceLeaseRegistry {
  readonly path: string;
  private readonly now: () => string;
  private readonly observeOwner: (owner: ResourceLeaseOwner) => ResourceOwnerObservation;
  private readonly busyTimeoutMs: number;
  private readonly maximumObservationAgeMs: number;

  constructor(private readonly options: ResourceLeaseRegistryOptions) {
    if (!isAbsolute(options.registryPath)) throw new ResourceLeaseError('RESOURCE_REGISTRY_PATH_REQUIRED', 'declare an absolute engine-store registryPath');
    this.path = resolve(options.registryPath);
    registerEngineOwnedSqlitePath(this.path);
    this.now = options.now ?? (() => new Date().toISOString());
    this.observeOwner = options.observeOwner ?? observeResourceLeaseOwner;
    this.busyTimeoutMs = quantity.max(30_000).parse(options.busyTimeoutMs ?? 2_000);
    this.maximumObservationAgeMs = quantity.parse(options.maximumObservationAgeMs ?? 30_000);
  }

  read(): ResourceLeaseRegistryRead { return readResourceLeaseRegistry(this.path); }

  private transaction<T>(mutate: (snapshot: ResourceLeaseSnapshot, at: string) => T): T {
    const Sqlite = sqliteConstructor();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Sqlite(this.path);
    let active = false;
    try {
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}; PRAGMA synchronous = FULL; BEGIN IMMEDIATE`);
      active = true;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length === 0) {
        db.exec('CREATE TABLE resource_registry (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
        db.prepare('INSERT INTO resource_registry (id, data) VALUES (1, ?)').run(JSON.stringify(emptySnapshot()));
      } else if (tables.length !== 1 || tables[0].name !== 'resource_registry') {
        throw new ResourceLeaseError('RESOURCE_REGISTRY_INVALID', 'unsupported registry tables; existing data was preserved');
      }
      const snapshot = readSnapshot(db);
      const result = mutate(snapshot, timestamp.parse(this.now()));
      SnapshotSchema.parse(snapshot);
      db.prepare('UPDATE resource_registry SET data = ? WHERE id = 1').run(JSON.stringify(snapshot));
      db.exec('COMMIT');
      active = false;
      return result;
    } catch (error) {
      if (active) { try { db.exec('ROLLBACK'); } catch { /* retain original error */ } }
      throw error;
    } finally { db.close(); }
  }

  private event(snapshot: ResourceLeaseSnapshot, event: Omit<ResourceLeaseSnapshot['history'][number], 'revision'>): void {
    if (event.kind === 'refused' || event.kind === 'retained') {
      for (let index = snapshot.history.length - 1; index >= 0; index--) {
        const previous = snapshot.history[index];
        if (event.requestId ? previous.requestId !== event.requestId : previous.leaseId !== event.leaseId) continue;
        // Waiting is observable through worker boundary events. Repeated
        // identical polls are observations, rather than new state transitions.
        if (previous.kind === event.kind && previous.reason === event.reason) return;
        break;
      }
    }
    snapshot.revision += 1;
    snapshot.history.push({ ...event, revision: snapshot.revision });
  }

  acquire(input: ResourceLeaseRequest): ResourceLeaseDecision {
    const request = RequestSchema.parse(input);
    if (new Set(request.gpuCards).size !== request.gpuCards.length || new Set(request.disk.map((entry) => resolve(entry.path))).size !== request.disk.length
      || request.gpuCards.length + request.disk.length === 0) {
      throw new ResourceLeaseError('RESOURCE_REQUEST_INVALID', 'declare distinct GPU cards/disk paths and at least one resource');
    }
    request.gpuCards.sort();
    request.disk.sort((a, b) => a.path.localeCompare(b.path));
    const requestDigest = hash(request);
    return this.transaction((snapshot, at) => {
      const previous = snapshot.leases.find((lease) => lease.requestId === request.requestId);
      if (previous) {
        if (previous.requestDigest !== requestDigest || previous.status !== 'active') throw new ResourceLeaseError('RESOURCE_REQUEST_CONFLICT', 'requestId already names a different or released lease; declare a new requestId');
        return { ok: true, lease: previous, handle: this.handle(previous), replayed: true };
      }
      const refuse = (code: string, reason: string, blockingLeaseIds: string[] = []): ResourceLeaseDecision => {
        this.event(snapshot, { at, kind: 'refused', requestId: request.requestId, reason: `${code}: ${reason}${blockingLeaseIds.length ? `; holders=${[...blockingLeaseIds].sort().join(',')}` : ''}` });
        return { ok: false, code, reason, blockingLeaseIds };
      };
      const fresh = (observedAt: string): boolean => {
        const age = Date.parse(timestamp.parse(this.now())) - Date.parse(timestamp.parse(observedAt));
        return age >= 0 && age <= this.maximumObservationAgeMs;
      };
      const active = snapshot.leases.filter((lease) => lease.status === 'active');
      let gpuObservedAt: string | undefined;
      if (request.gpuCards.length) {
        if (!this.options.gpuInventory) return refuse('GPU_INVENTORY_REQUIRED', 'declare an engine GPU identity inventory; devices are never guessed');
        const inventory = z.object({ cardIds: z.array(nonempty), observedAt: timestamp }).strict().parse(this.options.gpuInventory());
        if (new Set(inventory.cardIds).size !== inventory.cardIds.length) return refuse('GPU_INVENTORY_INVALID', 'GPU identities are not unique');
        if (!fresh(inventory.observedAt)) return refuse('RESOURCE_OBSERVATION_STALE', 'GPU inventory observation is stale or from the future');
        if (request.gpuCards.some((card) => !inventory.cardIds.includes(card))) return refuse('GPU_UNKNOWN', 'requested GPU identity is absent from the declared inventory');
        const holders = active.filter((lease) => lease.gpuCards.some((card) => request.gpuCards.includes(card)));
        if (holders.length) return refuse('GPU_BUSY', 'requested GPU is reserved; age is not release evidence', holders.map((lease) => lease.leaseId));
        gpuObservedAt = inventory.observedAt;
      }
      const disk = request.disk.map((entry) => ({ ...DiskSchema.parse((this.options.diskHeadroom ?? readDiskHeadroom)(entry.path)), bytes: entry.bytes, minimumFreeBytes: entry.minimumFreeBytes }));
      for (const measurement of disk) {
        if (!fresh(measurement.observedAt)) return refuse('RESOURCE_OBSERVATION_STALE', 'disk headroom observation is stale or from the future');
      }
      for (const filesystemId of new Set(disk.map((entry) => entry.filesystemId))) {
        const requested = disk.filter((entry) => entry.filesystemId === filesystemId);
        const holders = active.filter((lease) => lease.disk.some((entry) => entry.filesystemId === filesystemId));
        const reservations = holders.flatMap((lease) => lease.disk.filter((entry) => entry.filesystemId === filesystemId));
        const total = [...reservations, ...requested].reduce((sum, entry) => sum + entry.bytes, 0);
        const floor = Math.max(0, ...[...reservations, ...requested].map((entry) => entry.minimumFreeBytes));
        const available = Math.min(...requested.map((entry) => entry.availableBytes));
        if (!Number.isSafeInteger(total) || total > available - floor) return refuse('DISK_HEADROOM', `filesystem ${filesystemId}: available ${available} bytes, requested/reserved ${total} bytes, minimum free ${floor} bytes`, holders.map((lease) => lease.leaseId));
      }
      const fence = snapshot.nextFence++;
      const lease: ResourceLease = { leaseId: `lease_${fence}`, fence, requestId: request.requestId, requestDigest, owner: request.owner, acquiredAt: at, status: 'active', gpuCards: request.gpuCards, ...(gpuObservedAt ? { gpuObservedAt } : {}), disk };
      snapshot.leases.push(lease);
      this.event(snapshot, { at, kind: 'acquired', leaseId: lease.leaseId, requestId: request.requestId, reason: 'all requested resources atomically reserved' });
      return { ok: true, lease, handle: this.handle(lease), replayed: false };
    });
  }

  private handle(lease: ResourceLease): ResourceLeaseHandle {
    return { leaseId: lease.leaseId, fence: lease.fence, owner: lease.owner };
  }

  private finishedEvidence(owner: ResourceLeaseOwner, runDirectory: string): string {
    if (basename(resolve(runDirectory)) !== owner.runId) throw new ResourceLeaseError('LEASE_RELEASE_UNPROVEN', 'completion directory does not bind the lease run');
    const run = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as { runId?: unknown };
    const statusPath = join(runDirectory, 'stages', owner.stageId, 'status.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as { attempts?: Array<Record<string, unknown>> };
    const attempt = status.attempts?.find((entry) => entry.index === owner.attemptIndex && entry.startedAt === owner.attemptStartedAt);
    if (run.runId !== owner.runId || !attempt || !['complete', 'failed', 'suspended'].includes(String(attempt.status))
      || typeof attempt.completedAt !== 'string' || !Number.isFinite(Date.parse(attempt.completedAt))
      || !Number.isInteger(attempt.exitCode)) throw new ResourceLeaseError('LEASE_RELEASE_UNPROVEN', 'matching settled attempt with child exit evidence is required');
    return `${statusPath}#sha256=${hash(attempt)}`;
  }

  release(handle: ResourceLeaseHandle, proof: ResourceLeaseReleaseProof): ResourceLease {
    OwnerSchema.parse(handle.owner);
    return this.transaction((snapshot, at) => {
      const lease = snapshot.leases.find((entry) => entry.leaseId === handle.leaseId);
      if (!lease || lease.fence !== handle.fence || hash(lease.owner) !== hash(handle.owner)) throw new ResourceLeaseError('LEASE_FENCE_MISMATCH', 'lease owner and fence must match exactly');
      if (lease.status === 'released') return lease;
      let evidence: string;
      if (proof.kind === 'attempt_finished') {
        const statusEvidence = this.finishedEvidence(lease.owner, proof.runDirectory);
        const closure = this.options.verifyAttemptClosure?.(lease, proof.runDirectory);
        if (closure?.kind !== 'closed' || !closure.evidence) throw new ResourceLeaseError('LEASE_RELEASE_UNPROVEN', 'declare a consumer-closure verifier proving all delegated consumers stopped; a stage exit alone is insufficient');
        evidence = `${statusEvidence}; ${closure.evidence}`;
      }
      else if (proof.kind === 'owner_dead') {
        const observation = this.observeOwner(lease.owner);
        if (observation.kind !== 'dead' || !observation.reason) throw new ResourceLeaseError('LEASE_RELEASE_UNPROVEN', 'live or unknown owner remains reserved');
        evidence = observation.reason;
      } else throw new ResourceLeaseError('LEASE_RELEASE_UNPROVEN', 'unsupported release proof');
      lease.status = 'released';
      lease.release = { at, kind: proof.kind, evidence };
      this.event(snapshot, { at, kind: 'released', leaseId: lease.leaseId, reason: evidence });
      return lease;
    });
  }

  reconcile(): Array<{ leaseId: string; observation: ResourceOwnerObservation; released: boolean }> {
    return this.transaction((snapshot, at) => snapshot.leases.filter((lease) => lease.status === 'active').map((lease) => {
      const observation = this.observeOwner(lease.owner);
      if (!['live', 'dead', 'unknown'].includes(observation.kind) || !observation.reason) throw new ResourceLeaseError('LEASE_OBSERVATION_INVALID', 'owner probe returned no valid process evidence');
      const released = observation.kind === 'dead';
      if (released) {
        lease.status = 'released';
        lease.release = { at, kind: 'owner_dead', evidence: observation.reason };
      }
      this.event(snapshot, { at, kind: released ? 'released' : 'retained', leaseId: lease.leaseId, reason: observation.reason });
      return { leaseId: lease.leaseId, observation, released };
    }));
  }
}
