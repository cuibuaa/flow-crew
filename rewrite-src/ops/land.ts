import { observeController, waitForControllerExit } from '../host/process.js';
import { readPreparation, endPreparation, reconcileClaims, reclaimRecordOperations } from '../records/state.js';
import { reconcileRun } from './reconcile.js';
import { underControl } from './run.js';
import { protectedStatePaths } from '../records/state.js';
import { recordOperation, claim, isFinal } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { idSchema, executionBoundary, parseValue } from '../contract/brief.js';
import { z } from 'zod';
import { openJournal, readEvents, appendEvents } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { rawEvidence, reclaimTargets } from '../records/held.js';
import { retainOutputs, type AcceptedUnmetCriterion } from '../records/content.js';
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
  readonly acceptedUnmet: readonly AcceptedUnmetCriterion[];
}

export interface UnmetAcceptance { readonly criterionId: string; readonly reason: string }

/** The only landing operation: preserve the declared outputs, then reclaim the run's bytes. A run must be terminal, closed
 * and held under its epochs; a preservation failure deletes nothing. */
export async function land(location: RunLocation, processFactory: ProcessPortsFactory,
  unitContext: RunContext, acceptUnmet: readonly UnmetAcceptance[] = []): Promise<Result<LandReport>> {
  if (!idSchema.safeParse(location.run).success) return refuse('invalid', 'Invalid land request');
  const requested = parseValue<readonly UnmetAcceptance[]>(z.array(z.strictObject({
    criterionId: idSchema, reason: z.string().refine(value => value.trim().length > 0, 'Acceptance needs a reason')
  })), acceptUnmet);
  if (!requested.ok) return requested;
  const initial = await openJournal(location, 'read'); if (!initial.ok) return initial;
  const current = await readProjection(initial.value); if (!current.ok) return current;
  return underControl(location, current.value.launch.unit, async ({journal, writer, claims}): Promise<Result<LandReport>> => {
    let reclaimed = false;
    const unit = current.value.launch.unit;
    const process = processFactory(writer);
    const refreshed = await readProjection(journal);
    if (!refreshed.ok) return refreshed;
    let projection = refreshed.value;
    for (const entry of requested.value) if (!projection.brief.declaration.criteria.some(criterion => criterion.id === entry.criterionId))
      return refuse('invalid', 'Unknown frozen criterion: ' + entry.criterionId);
    // A terminal controller can still flush gate receipts. Judge acceptance before reconciliation preserves/deletes bytes.
    if (requested.value.length && !projection.delivery && isFinal(projection.status)) {
      const exited = await waitForControllerExit(unit, unitContext); if (!exited.ok) return exited;
      const settled = await readProjection(journal); if (!settled.ok) return settled;
      projection = settled.value;
    }
    const gate = projection.attempts.map(attempt => attempt.answer).filter(answer => answer?.kind === 'gate').at(-1);
    let acceptedUnmet: readonly AcceptedUnmetCriterion[] = [];
    const entries: AcceptedUnmetCriterion[] = [];
    for (const entry of requested.value) {
      const judged = gate?.answer.criteria[entry.criterionId];
      if (judged?.status === 'pass') return refuse('invalid', 'Latest gate passed criterion: ' + entry.criterionId);
      entries.push({ ...entry, status: judged?.status ?? 'not_assessed', evidence: judged?.evidence ?? 'not assessed', at: new Date().toISOString() });
    }
    if (!isFinal(projection.status)) return refuse('conflict',
      `Run is ${projection.status}, not finished; run flowcrew cancel ${location.run} first, then land it`);
    // Publication may precede its journal fact. Land alone decides whether acceptance can still be recorded.
    if (entries.length && (projection.delivery || lstatSync(join(resolve(location.storeRoot), 'deliveries', location.run),
      { throwIfNoEntry: false }))) return refuse('conflict',
      'Delivery already exists; acceptance records must be supplied on the first land. Repeat land without --accept-unmet to finish cleanup');
    const targets = reclaimTargets(location.storeRoot, location.run, projection.launch);
    const cleanup = async () => {
      const deleted = await recordOperation<true>(journal, 'gc', { module: import.meta.url, method: 'reclaimTask',
        args: [journal, targets.project, targets.pin, targets.work] });
      return deleted.ok ? appendEvents(writer, null, [{ type: 'reclaim_completed' }]) : deleted;
    };
    // Closure reconciliation owns predecessor claims; acquiring them first can mask a pending flush.
    const observed = projection.delivery ? { ok: true as const, value: { evidence: [] } }
      : await reconcileRun(writer, process, unitContext, claims, false);
    if (!observed.ok) return observed;
    const reconciled = await readProjection(journal); if (!reconciled.ok) return reconciled;
    projection = reconciled.value;
    const project = await claim(resolve(projection.launch.project), unit, { database: location.database, holder: journal.root });
    if (!project.ok) return project;
    claims.push(project.value);
    const execution = await claim(join(resolve(location.storeRoot), 'runs', location.run, 'execution'), unit, { database: location.database,
      holder: journal.root });
    if (!execution.ok) return execution;
    claims.push(execution.value);
    // A durable delivery proves closure, but a failed cleanup may have handed off these operation claims.
    if (projection.delivery) {
      const deleted = await cleanup(); if (!deleted.ok) return deleted;
      return { ok: true, value: { location, state: 'reclaimed', executionBoundary, outputs: projection.outputs.at(-1)!,
        evidence: [], delivery: projection.delivery.delivery, acceptedUnmet } };
    }
    const layout = await validateRecordLayout({
      location, project: projection.launch.project,
      protectedRoots: [journal.root, dirname(join(resolve(location.storeRoot), projection.launch.runtime.path)),
        ...protectedStatePaths(location.database)]
    });
    if (!layout.ok) return layout;
    if (!projection.authority) return refuse('invalid', 'Missing prepared run authority');
    const scope = {
      journal, layout: layout.value, brief: projection.brief,
      inputBaseline: projection.launch.setup.inputs, outputBaseline: projection.launch.setup.outputs, authority: projection.authority,
        projectClaim: project.value
    };
    const outputs = await retainOutputs(scope);
    if (!outputs.ok) return outputs;
    const fresh = await readEvents(journal, 0);
    if (!fresh.ok) return fresh;
    const appended = await appendEvents(writer, fresh.value.at(-1)?.seq ?? 0, [{ type: 'outputs_preserved', receipt: outputs.value }]);
    if (!appended.ok) return appended;
    const latest = await readProjection(journal);
    if (!latest.ok) return latest;
    let state: LandReport['state'] = 'partial';
    if (outputs.value.preserved) {
      if (await fs.realpath(targets.project) !== targets.project) return refuse('invalid', 'Aliased project cannot be reclaimed');
      const delivery = join(resolve(location.storeRoot), 'deliveries', location.run);
      // Delivery derives the patch scope from the same preserved outputs, against setup's base.
      const archived = await recordOperation<readonly AcceptedUnmetCriterion[]>(journal, 'gc', { module: new URL('../records/content.js', import.meta.url).href,
        method: 'materializeDelivery', args: [journal, outputs.value.artifacts, delivery, projection.launch.setup.tree, entries] });
      if (!archived.ok) return archived;
      acceptedUnmet = archived.value;
      const cursor = await readEvents(journal, 0); if (!cursor.ok) return cursor;
      const recorded = await appendEvents(writer, cursor.value.at(-1)?.seq ?? 0, [{ type: 'delivery_preserved',
        at: new Date().toISOString(), delivery }]);
      if (!recorded.ok) return recorded;
      // Once the durable archive fact exists, retry needs neither the pin nor raw evidence.
      const deleted = await cleanup(); if (!deleted.ok) return deleted;
      state = 'reclaimed'; reclaimed = true;
    }
    return { ok: true, value: { location, state, executionBoundary, outputs: latest.value.outputs.at(-1)!, acceptedUnmet, evidence: reclaimed ? [] : [...observed.value.evidence, ...outputs.value.artifacts],
      ...(reclaimed ? { delivery: join(resolve(location.storeRoot), 'deliveries', location.run) } : {}) } };
  });
}
function refuse(kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }

export async function reclaimTask(journal: import('../contract/runtime.js').Journal, path: string, pin: string,
  workRoot: string): Promise<Result<true>> {
  try {
    const preparation = readPreparation(journal); if (!preparation.ok) return preparation;
    const current = preparation.value && !preparation.value.admitted ? { ok: true as const, value: preparation.value } : await readProjection(journal);
    if (!current.ok) return current;
    if (!current.value.delivery) return refuse('conflict', 'Reclaim requires a durable delivery');
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

/** Non-admitted runs own only private preparation bytes; they never acquired permission to execute or deliver external outputs. */
export async function controlPreparation(location: RunLocation, command: string): Promise<Result<LandReport | { state: 'acknowledged' }>> {
  return underControl(location, null, async ({journal, writer, claims}): ReturnType<typeof controlPreparation> => {
    const state = readPreparation(journal); if (!state.ok) return state;
    if (!state.value || state.value.admitted) return refuse('conflict', 'Preparation already admitted; repeat the control');
    const { preparation, status, delivery: preserved } = state.value;
    if (!['cancel', 'land'].includes(command)) return refuse('conflict',
      `Run is ${status}: ${state.value.reason ?? 'setup has not completed'}; cancel and land it before a new setup`);
    if (status === 'preparing') {
      const owner = await observeController(preparation.owner);
      if (owner !== 'inactive') return refuse(owner === 'active' ? 'conflict' : 'unknown', 'Setup owner has not closed');
    }
    const operations = await reclaimRecordOperations(journal); if (!operations.ok) return operations;
    const reconciled = await reconcileClaims(journal, claims); if (!reconciled.ok) return reconciled;
    const ended = await endPreparation(writer, 'cancelled', state.value.reason ?? 'Preparation cancelled');
    if (!ended.ok) return ended;
    if (command === 'cancel') return { ok: true, value: { state: 'acknowledged' } };
    const delivery = preserved?.delivery ?? join(resolve(location.storeRoot), 'deliveries', location.run);
    if (!preserved) {
      await fs.mkdir(delivery, { recursive: true });
      const events = await readEvents(journal, 0); if (!events.ok) return events;
      const recorded = await appendEvents(writer, events.value.at(-1)?.seq ?? 0,
        [{ type: 'delivery_preserved', at: new Date().toISOString(), delivery }]);
      if (!recorded.ok) return recorded;
    }
    const targets = reclaimTargets(location.storeRoot, location.run);
    const deleted = await recordOperation(journal, 'gc', { module: import.meta.url, method: 'reclaimTask',
      args: [journal, targets.project, targets.pin, targets.work] });
    if (!deleted.ok) return deleted;
    const completed = await appendEvents(writer, null, [{ type: 'reclaim_completed' }]);
    if (!completed.ok) return completed;
    return { ok: true, value: { location, state: 'reclaimed', executionBoundary,
      outputs: { preserved: true, artifacts: [], detail: 'Preparation never admitted; no workload outputs' }, evidence: [], delivery, acceptedUnmet: [] } };
  });
}
