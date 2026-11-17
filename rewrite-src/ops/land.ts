import { reconcileRun, attendRun } from './reconcile.js';
import { protectedStatePaths, hasBlockingObligations } from '../records/state.js';
import { releaseRunResources, recordOperation, claim, release, isFinal } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { idSchema } from '../contract/brief.js';
import { type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { verifyRuntime, readCheckpoint, preserveOutputs, materializeDelivery } from '../records/content.js';
import { publishRunStatus } from './status.js';
import type { Ref, Result } from '../contract/brief.js';
import { type OutputReceipt, type RunLocation } from '../contract/runtime.js';
import type { ProcessPortsFactory, RunContext } from '../host/process.js';

/** Preservation and reclaim facts independent of product acceptance or any launcher ledger. */
export interface LandReport {
  readonly location: RunLocation;
  readonly state: 'preserved' | 'reclaimed' | 'partial' | 'refused' | 'unknown';
  readonly outputs: OutputReceipt;
  readonly evidence: readonly Ref[];
  readonly delivery?: string;
}

/** Preserve outputs before reclaiming the addressed workspace; closure and the held epoch are prerequisites. */
export async function land(location: RunLocation, mode: 'preserve' | 'reclaim', processFactory: ProcessPortsFactory,
  unitContext: RunContext): Promise<Result<LandReport>> {
  if (!idSchema.safeParse(location.run).success || !['preserve', 'reclaim'].includes(mode)) return refuse('invalid', 'Invalid land request');
  const claims: Claim[] = [];
  let reclaimed = false;
  let cleanupWriter: import('../contract/runtime.js').Writer | undefined;
  const execute = async (): Promise<Result<LandReport>> => {
    const journal = await openJournal(location, 'read');
    if (!journal.ok) return journal;
    const current = await readProjection(journal.value);
    if (!current.ok) return current;
    let projection = current.value;
    if (projection.reclaimed) return { ok: true, value: { location, state: 'reclaimed', outputs: projection.outputs.at(-1)!, evidence: [], delivery: projection.reclaimed.delivery } };
    const unit = projection.launch.unit;
    const control = await claim(join(resolve(location.storeRoot), 'runs', location.run, 'control'), unit, { database: location.database,
      holder: journal.value.root });
    if (!control.ok) return control;
    claims.push(control.value);
    const opened = await openWriter(journal.value, control.value, 'control');
    if (!opened.ok) return opened;
    const writer = opened.value; cleanupWriter = writer;
    const process = processFactory(writer);
    const project = await claim(resolve(projection.launch.project), unit, { database: location.database, holder: journal.value.root });
    if (!project.ok) return project;
    claims.push(project.value);
    const execution = await claim(join(resolve(location.storeRoot), 'runs', location.run, 'execution'), unit, { database: location.database,
      holder: journal.value.root });
    if (!execution.ok) return execution;
    claims.push(execution.value);
    const refreshed = await readProjection(journal.value);
    if (!refreshed.ok) return refreshed;
    projection = refreshed.value;
    if (mode === 'reclaim' && !isFinal(projection.status)) return refuse('conflict',
      'Executable run cannot be reclaimed');
    const observed = await reconcileRun(writer, process, unitContext, claims, false);
    if (!observed.ok) return observed;
    const reconciled = await readProjection(journal.value); if (!reconciled.ok) return reconciled;
    projection = reconciled.value;
    if (hasBlockingObligations(projection.obligations))
      return refuse('unknown', 'Run closure or claims remain unsettled');
    const runtime = await verifyRuntime(location.storeRoot, projection.launch.runtime);
    if (!runtime.ok) return runtime;
    const layout = await validateRecordLayout({
      location, project: projection.launch.project,
      protectedRoots: [journal.value.root, dirname(join(resolve(location.storeRoot), runtime.value.path)),
        ...protectedStatePaths(location.database)], sharedCaches: []
    });
    if (!layout.ok) return layout;
    const selected = projection.checkpoints.at(-1);
    if (!selected || selected.state !== 'safe') return refuse('conflict', 'No identified safe delivery checkpoint');
    const checkpoint = await readCheckpoint(journal.value, selected.id);
    if (!checkpoint.ok) return checkpoint;
    if (!projection.authority) return refuse('invalid', 'Missing prepared run authority');
    const outputs = await preserveOutputs({
      journal: journal.value, layout: layout.value, brief: projection.brief,
      inputBaseline: projection.launch.setup.inputs, outputBaseline: projection.launch.setup.outputs, authority: projection.authority,
        projectClaim: project.value
    }, checkpoint.value);
    if (!outputs.ok) return outputs;
    const fresh = await readEvents(journal.value, 0);
    if (!fresh.ok) return fresh;
    const appended = await appendEvents(writer, fresh.value.at(-1)?.seq ?? 0, [{ type: 'outputs_preserved', receipt: outputs.value }]);
    if (!appended.ok) return appended;
    const latest = await readProjection(journal.value);
    if (!latest.ok) return latest;
    const published = await publishRunStatus(location, new Date().toISOString(), null);
    if (!published.ok) return published;
    let state: LandReport['state'] = outputs.value.preserved ? 'preserved' : 'partial';
    if (mode === 'reclaim' && outputs.value.preserved) {
      const path = resolve(projection.launch.project);
      if (await fs.realpath(path) !== path) return refuse('invalid', 'Aliased project cannot be reclaimed');
      const deleted = await recordOperation(journal.value, 'gc', { module: import.meta.url, method: 'reclaimTask', args: [journal.value, path, dirname(join(resolve(location.storeRoot), projection.launch.runtime.path)),
        outputs.value.artifacts, join(resolve(location.storeRoot), 'deliveries', location.run),
        join(resolve(location.storeRoot), 'work', location.run)] });
      if (!deleted.ok) return deleted;
      state = 'reclaimed'; reclaimed = true;
      const cursor = await readEvents(journal.value, 0); if (!cursor.ok) return cursor;
      const recorded = await appendEvents(writer, cursor.value.at(-1)?.seq ?? 0, [{ type: 'run_reclaimed',
        at: new Date().toISOString(), delivery: join(resolve(location.storeRoot), 'deliveries', location.run) }]);
      if (!recorded.ok) return recorded;
      const snapshot = publishRunStatus(location, new Date().toISOString(), null); if (!snapshot.ok) return snapshot;
    }
    return { ok: true, value: { location, state, outputs: outputs.value, evidence: reclaimed ? [] : [...observed.value.evidence, checkpoint.value.manifest],
      ...(reclaimed ? { delivery: join(resolve(location.storeRoot), 'deliveries', location.run) } : {}) } };
  };
  let result: Result<LandReport>;
  try { result = await execute(); }
  catch (error) { result = refuse('unknown', error instanceof Error ? error.message : String(error)); }
  if (cleanupWriter) { const attended = await attendRun(cleanupWriter, result); if (!attended.ok) result = attended; }
  for (const held of claims.reverse()) {
    const released = await release(held, reclaimed ? 'retire' : 'handoff');
    if (!released.ok) { result = released; if (cleanupWriter) { const attended = await attendRun(cleanupWriter, released, true);
      if (!attended.ok) result = attended; } }
  }
  return result;
}
function refuse(kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }

export async function reclaimTask(journal: import('../contract/runtime.js').Journal, path: string, pin: string,
  artifacts: readonly Ref[], delivery: string, workRoot: string): Promise<Result<true>> {
  try {
    const retained = await materializeDelivery(journal, artifacts, delivery); if (!retained.ok) return retained;
    await fs.rm(path, { recursive: true });
    await fs.rm(pin, { recursive: true });
    // Sync the workspace deletion while its parent still exists, before reclaiming the enclosing work root.
    const parent = await fs.open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
    await fs.rm(workRoot, { recursive: true, force: true });
    // All raw evidence lives beneath the addressed journal; SQLite history and its status view stay.
    for (const name of await fs.readdir(journal.root)) if (name !== 'status.json') await fs.rm(join(journal.root, name), { recursive: true });
    return releaseRunResources(journal);
  } catch (error) { return refuse('unknown', 'Partial reclaim requires reconciliation: ' + String(error)); }
}
