import { reconcileRun, attendRun } from './reconcile.js';
import { protectedStatePaths } from '../records/state.js';
import { recordOperation, claim, release, isFinal } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { idSchema, executionBoundary } from '../contract/brief.js';
import { type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { rawEvidence, reclaimTargets } from '../records/held.js';
import { retainOutputs } from '../records/content.js';
import { publishRunStatus } from './status.js';
import type { Ref, Result } from '../contract/brief.js';
import { type OutputReceipt, type RunLocation } from '../contract/runtime.js';
import type { ProcessPortsFactory, RunContext } from '../host/process.js';

/** Landing facts independent of product acceptance or any launcher ledger. `partial` means preservation failed and nothing was deleted. */
export interface LandReport {
  readonly location: RunLocation;
  readonly state: 'reclaimed' | 'partial' | 'refused' | 'unknown';
  readonly outputs: OutputReceipt;
  readonly executionBoundary: string;
  readonly evidence: readonly Ref[];
  readonly delivery?: string;
}

/** The only landing operation: preserve the declared outputs, then reclaim the run's bytes. A run must be terminal, closed
 * and held under its epochs; a preservation failure deletes nothing. */
export async function land(location: RunLocation, processFactory: ProcessPortsFactory,
  unitContext: RunContext): Promise<Result<LandReport>> {
  if (!idSchema.safeParse(location.run).success) return refuse('invalid', 'Invalid land request');
  const claims: Claim[] = [];
  let reclaimed = false;
  let cleanupWriter: import('../contract/runtime.js').Writer | undefined;
  const execute = async (): Promise<Result<LandReport>> => {
    const journal = await openJournal(location, 'read');
    if (!journal.ok) return journal;
    const current = await readProjection(journal.value);
    if (!current.ok) return current;
    let projection = current.value;
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
    if (!isFinal(projection.status)) return refuse('conflict',
      `Run is ${projection.status}, not finished; run flowcrew cancel ${location.run} first, then land it`);
    const observed = await reconcileRun(writer, process, unitContext, claims, false);
    if (!observed.ok) return observed;
    const reconciled = await readProjection(journal.value); if (!reconciled.ok) return reconciled;
    projection = reconciled.value;
    const targets = reclaimTargets(location.storeRoot, location.run, projection.launch);
    const cleanup = async () => recordOperation<true>(journal.value, 'gc', { module: import.meta.url, method: 'reclaimTask',
      args: [journal.value, targets.project, targets.pin, targets.work] });
    if (projection.reclaimed) {
      const deleted = await cleanup(); if (!deleted.ok) return deleted;
      reclaimed = true;
      return { ok: true, value: { location, state: 'reclaimed', executionBoundary, outputs: projection.outputs.at(-1)!,
        evidence: [], delivery: projection.reclaimed.delivery } };
    }
    const layout = await validateRecordLayout({
      location, project: projection.launch.project,
      protectedRoots: [journal.value.root, dirname(join(resolve(location.storeRoot), projection.launch.runtime.path)),
        ...protectedStatePaths(location.database)]
    });
    if (!layout.ok) return layout;
    if (!projection.authority) return refuse('invalid', 'Missing prepared run authority');
    const outputs = await retainOutputs({
      journal: journal.value, layout: layout.value, brief: projection.brief,
      inputBaseline: projection.launch.setup.inputs, outputBaseline: projection.launch.setup.outputs, authority: projection.authority,
        projectClaim: project.value
    });
    if (!outputs.ok) return outputs;
    const fresh = await readEvents(journal.value, 0);
    if (!fresh.ok) return fresh;
    const appended = await appendEvents(writer, fresh.value.at(-1)?.seq ?? 0, [{ type: 'outputs_preserved', receipt: outputs.value }]);
    if (!appended.ok) return appended;
    const latest = await readProjection(journal.value);
    if (!latest.ok) return latest;
    const published = await publishRunStatus(location, new Date().toISOString(), null);
    if (!published.ok) return published;
    let state: LandReport['state'] = 'partial';
    if (outputs.value.preserved) {
      if (await fs.realpath(targets.project) !== targets.project) return refuse('invalid', 'Aliased project cannot be reclaimed');
      const delivery = join(resolve(location.storeRoot), 'deliveries', location.run);
      const archived = await recordOperation<true>(journal.value, 'gc', { module: new URL('../records/content.js', import.meta.url).href,
        method: 'materializeDelivery', args: [journal.value, outputs.value.artifacts, delivery] });
      if (!archived.ok) return archived;
      const cursor = await readEvents(journal.value, 0); if (!cursor.ok) return cursor;
      const recorded = await appendEvents(writer, cursor.value.at(-1)?.seq ?? 0, [{ type: 'run_reclaimed',
        at: new Date().toISOString(), delivery }]);
      if (!recorded.ok) return recorded;
      // Once the durable archive fact exists, retry needs neither the pin nor raw evidence.
      const deleted = await cleanup(); if (!deleted.ok) return deleted;
      state = 'reclaimed'; reclaimed = true;
      const snapshot = publishRunStatus(location, new Date().toISOString(), null); if (!snapshot.ok) return snapshot;
    }
    return { ok: true, value: { location, state, executionBoundary, outputs: latest.value.outputs.at(-1)!, evidence: reclaimed ? [] : [...observed.value.evidence, ...outputs.value.artifacts],
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
  workRoot: string): Promise<Result<true>> {
  try {
    const current = await readProjection(journal); if (!current.ok) return current;
    if (!current.value.reclaimed) return refuse('conflict', 'Reclaim requires a durable delivery');
    for (const target of [path, pin, workRoot]) {
      if (!lstatSync(target, { throwIfNoEntry: false })) continue;
      const directory = await fs.open(dirname(target), 'r');
      try { await fs.rm(target, { recursive: true, force: true }); await directory.sync(); }
      finally { await directory.close(); }
    }
    // All raw evidence lives beneath the addressed journal; SQLite history and its status view stay.
    for (const target of rawEvidence(journal.root)) await fs.rm(target, { recursive: true, force: true });
    const directory = await fs.open(journal.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    return { ok: true, value: true };
  } catch (error) { return refuse('unknown', 'Partial reclaim requires reconciliation: ' + String(error)); }
}
