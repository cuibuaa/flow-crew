import { runRecordPath } from '../../run-layout.js';
import type { DispatchAdmissionError } from './dispatch.js';
/** DAG reachability, readiness and single shared-tree author admission. Gate readers are explicit services. */
import { STAGE_STATUS, type StoreState, isPendingStageStatus, isSatisfiedStageDependencyStatus, runDir, type WriteAttribution, type StageStatus } from '../../store.js';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
export { parseDeclaredScope, type ParsedScope } from './scope-services.js';
import { type StageConfig } from './configuration.js';
import type { GateContract } from '../../scheduler.js';

export function inspectStageGraph(stages: StageConfig[]): { sorted: StageConfig[]; errors: DispatchAdmissionError[] } {
  const errors: DispatchAdmissionError[] = [];
  const ids = new Set(stages.map((s) => s.id));
  for (const stageId of ids) if (stages.filter(stage => stage.id === stageId).length > 1) {
    errors.push({ code: 'stage_graph', stageId, field: 'id', message: 'Duplicate stage IDs detected' });
  }
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of stages) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of stages) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(d)) { errors.push({ code: 'stage_graph', stageId: s.id, field: `depends_on.${d}`, message: `${s.id}.depends_on: unknown stage ${JSON.stringify(d)}` }); continue; }
      if (d === s.id) errors.push({ code: 'stage_graph', stageId: s.id, field: `depends_on.${d}`, message: `${s.id}.depends_on: self dependency is forbidden` });
      adj.get(d)!.push(s.id);
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const sorted: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    sorted.push(n);
    for (const nb of adj.get(n) ?? []) {
      const d = inDeg.get(nb)! - 1;
      inDeg.set(nb, d);
      if (d === 0) queue.push(nb);
    }
  }
  if (sorted.length !== stages.length) {
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    for (const stage of stages) if (transitivelyDependsOn(stage.id, stage.id, byId)) errors.push({ code: 'stage_graph', stageId: stage.id, field: 'depends_on', message: `${stage.id}.depends_on: dependency cycle detected` });
  }
  const order = new Map(sorted.map((id, i) => [id, i]));
  return { sorted: [...stages].sort((a, b) => order.get(a.id)! - order.get(b.id)!), errors };
}

export function topoSort(stages: StageConfig[]): StageConfig[] {
  const result = inspectStageGraph(stages);
  if (result.errors.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.sorted;
}

export interface GateReadServices {
  loadGateContract(projectDir: string, runId?: string, campaignStorageKey?: string): GateContract | null;
  readGateEvaluation(projectDir: string, stageId: string, runId?: string, contract?: GateContract | null, requireValidationDelta?: boolean): { pass: boolean; reason?: string } | null;
}

/** Committed edges control their declared targets until consumed by a revision. */
function decisionControls(source: StageConfig, target: string, state: StoreState): boolean {
  if (source.id === target || !source.decision?.successors.includes(target)) return false;
  const latest = state.decisionGraph?.records.filter(record => record.stageId === source.id).at(-1);
  // A replan edge is consumed by its admitted revision; history cannot suppress that revision's remaining duties.
  if (latest?.successor === 'replan' && latest.planRevision !== undefined
    && (state.queryState?.planRevision?.revision ?? latest.planRevision) > latest.planRevision) return false;
  return true;
}

/** A join may name the ends of alternatives, not only their immediate targets. */
function unchosenJoinDependency(stage: StageConfig, dependency: string, stages: ReadonlyMap<string, StageConfig>, state: StoreState): boolean {
  return [...stages.values()].some(source => {
    const targets = source.decision?.successors.filter(id => stages.has(id)) ?? [];
    if (targets.length < 2) return false;
    const record = state.decisionGraph?.records.filter(record => record.stageId === source.id).at(-1);
    const choice = record?.successor;
    const descendsFrom = (id: string, target: string) => id === target || transitivelyDependsOn(id, target, stages);
    return Boolean(choice && targets.includes(choice)
      && targets.every(target => stage.depends_on.some(id => descendsFrom(id, target)))
      && !descendsFrom(dependency, choice)
      && targets.some(target => target !== choice && descendsFrom(dependency, target))
      && isStageInSkippedBranch(dependency, stages, state));
  });
}

/** Follow observed conditional skips upstream, without re-evaluating conditions.
 * A gate skipping itself does not verify its producer's work. Completed,
 * running and failed work still needs settlement even if an ancestor was skipped.
 * A completed rejection remains a dependency obligation for its descendants. */
export function isStageInSkippedBranch(stageId: string, stages: ReadonlyMap<string, StageConfig>, state: StoreState): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const stage = stages.get(id);
    const status = state.stages[id]?.status;
    if (!stage || (status !== STAGE_STATUS.PENDING && status !== STAGE_STATUS.SKIPPED)) return false;
    const incoming = [...stages.values()].filter(source => decisionControls(source, id, state)
      && !transitivelyDependsOn(source.id, id, stages));
    if (incoming.length && incoming.every(source => {
      const record = state.decisionGraph?.records.filter(record => record.stageId === source.id).at(-1);
      return record?.successor && record.successor !== id;
    }) && !state.decisionGraph?.enabled[id]) return true;
    if (id !== stageId && status === STAGE_STATUS.SKIPPED && stage.condition?.trim()) return true;
    return (stage.depends_on ?? []).some(dependency => !unchosenJoinDependency(stage, dependency, stages, state) && visit(dependency));
  };
  return visit(stageId);
}

export function createReadyFinder({ loadGateContract, readGateEvaluation }: GateReadServices) {
  return (function findAllReady(stages: StageConfig[], state: StoreState): StageConfig[] {
    const ready: StageConfig[] = [];
    const records = state.decisionGraph?.records ?? [];
    const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
    let contract: ReturnType<typeof loadGateContract> | undefined;
    for (const s of stages) {
      const ss = state.stages[s.id];
      if (!ss || !isPendingStageStatus(ss.status)) continue;
      const enabledBy = state.decisionGraph?.enabled[s.id];
      const incoming = stages.filter(source => decisionControls(source, s.id, state) && !transitivelyDependsOn(source.id, s.id, stagesById));
      if (incoming.length && !enabledBy && !incoming.some(source => records.filter(record => record.stageId === source.id).at(-1)?.successor === s.id)) continue;
      if (s.retry_to?.length && !enabledBy) continue;

      const depsReady = (s.depends_on ?? []).every((d) => {
        if (unchosenJoinDependency(s, d, stagesById, state)) return true;
        if (s.retry_to?.includes(d) && isStageInSkippedBranch(d, stagesById, state)) return true;
        let owner = enabledBy;
        const grants = new Set<string>();
        while (owner && !grants.has(owner)) { grants.add(owner); owner = state.decisionGraph?.enabled[owner]; }
        if (grants.has(d)) return true; // Only this admitted edge can release a rejecting predecessor.
        const ds = state.stages[d];
        if (!ds || ds.continuation || !isSatisfiedStageDependencyStatus(ds.status)) return false;
        const dependency = stagesById.get(d);
        const hasRunLocation = typeof state.projectDir === 'string' && typeof state.runId === 'string';
        if (hasRunLocation && contract === undefined) {
          contract = loadGateContract(state.projectDir, state.runId, state.campaignStorageKey);
        }
        const hasSpecificVerdict = hasRunLocation && existsSync(runRecordPath(
          runDir(state.projectDir, state.runId),
          `verdict_${d}.json`,
        ));
        const verdict = hasRunLocation && (dependency?.is_gate === true || hasSpecificVerdict)
          ? readGateEvaluation(state.projectDir, d, state.runId, contract, dependency?.is_gate === true)
          : undefined;
        // A negative verdict is authoritative even if an older/static workflow
        // forgot to mark the producing stage as a gate. Stage status describes
        // process completion; it must never turn an explicit rejection into a
        // satisfied dependency.
        if (verdict?.pass === false) return false;
        // A `retry_to` edge is retry wiring, not an ordinary dependency.
        // `normalizeStageContracts` puts the gate into `depends_on` so a fix can be
        // dispatched when the gate REJECTS, and records exactly that on the edge: "fixes run
        // only after this gate reports a failure". Letting a PASSING gate satisfy the same
        // edge dispatches the fix again after the work was accepted — the opposite of the
        // recorded reason — and lets an unreviewed change land on a verified state. Rejection
        // reaches the fix through the retry loop ("Reset and run all active retry stages"),
        // never through here, so refusing the edge cannot strand a failing gate.
        //
        // Measured before this guard: a run whose gate passed on its second attempt then ran
        // fix → gate → fix → gate for another 46 minutes and 20M input tokens, committing
        // nothing. `gate_retry_loops` does not bound it, because this path is not the retry
        // loop, so within one iteration the cycle had no bound of its own.
        if (s.retry_to?.includes(d)) return false;
        if (dependency?.is_gate !== true) return true;
        // A completed gate is not a satisfied dependency until it has said
        // `pass: true`. Skipped gates were rejected by the dependency-status
        // check above and cannot release ordinary downstream work.
        return verdict?.pass === true;
      });
      if (depsReady) ready.push(s);
    }
    return ready;
  });
}

export interface ScopeConflict {
  leftStageId: string;
  rightStageId: string;
  reason: string;
}

export function findScopeConflict(left: StageConfig, right: StageConfig): ScopeConflict | undefined {
  return { leftStageId: left.id, rightStageId: right.id,
    reason: 'stages share one mutable project tree; wait for the active stage to settle' };
}

export function selectRunnableBatch(ready: StageConfig[]): {
  selected: StageConfig[];
  deferred: Array<{ stage: StageConfig; conflict: ScopeConflict }>;
} {
  const selected: StageConfig[] = [];
  const deferred: Array<{ stage: StageConfig; conflict: ScopeConflict }> = [];
  for (const stage of ready) {
    let conflict: ScopeConflict | undefined;
    for (const admitted of selected) {
      conflict = findScopeConflict(admitted, stage);
      if (conflict) break;
    }
    if (conflict) deferred.push({ stage, conflict });
    else selected.push(stage);
  }
  return { selected, deferred };
}

export function parallelScopeAdmissionWarnings(stages: StageConfig[]): string[] {
  const remaining = new Map(stages.map((stage) => [stage.id, stage]));
  const warnings: string[] = [];
  while (remaining.size > 0) {
    // Dependencies outside the proposal (normally the already-complete
    // dispatch stage) do not block this static frontier simulation.
    const frontier = [...remaining.values()].filter((stage) => (
      stage.depends_on.every((dependency) => !remaining.has(dependency))
    ));
    if (frontier.length === 0) break; // the normal admission cycle error owns this case

    const conflicts: ScopeConflict[] = [];
    const adjacency = new Map(frontier.map((stage) => [stage.id, new Set<string>()]));
    for (let left = 0; left < frontier.length; left++) {
      for (let right = left + 1; right < frontier.length; right++) {
        const conflict = findScopeConflict(frontier[left], frontier[right]);
        if (!conflict) continue;
        conflicts.push(conflict);
        adjacency.get(frontier[left].id)!.add(frontier[right].id);
        adjacency.get(frontier[right].id)!.add(frontier[left].id);
      }
    }

    const visited = new Set<string>();
    for (const stage of frontier) {
      if (visited.has(stage.id) || adjacency.get(stage.id)!.size === 0) continue;
      const component = new Set<string>();
      const queue = [stage.id];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (component.has(current)) continue;
        component.add(current);
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
      const details = conflicts
        .filter((conflict) => component.has(conflict.leftStageId) && component.has(conflict.rightStageId))
        .map((conflict) => `${conflict.leftStageId} ↔ ${conflict.rightStageId}: ${conflict.reason}`);
      warnings.push(
        `Parallel scope warning: stages [${[...component].join(', ')}] can be runnable in the same scheduling frontier, `
        + `and share one mutable project tree (${details.join('; ')}). `
        + 'They are admitted but will be serialized at runtime; independent runs need separate workspaces for parallel authorship.',
      );
    }

    for (const stage of frontier) remaining.delete(stage.id);
  }
  return warnings;
}

export function latestAttemptWrites(status: StageStatus | undefined): { files: string[]; attribution: WriteAttribution } {
  const attempt = status?.attempts?.at(-1);
  const files = (attempt?.writes ?? [])
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter((file) => !!file)
    // These are factual adapter observations, not declared project scopes.
    // Normalize lexically for comparison but retain `../` paths so two stages
    // writing the same run-owned artifact outside the project remain visible.
    .map((file) => posix.normalize(file));
  return { files: [...new Set(files)], attribution: attempt?.writeAttribution ?? 'unknown' };
}

export function transitivelyDependsOn(stageId: string, ancestorId: string, byId: ReadonlyMap<string, StageConfig>): boolean {
  const seen = new Set<string>();
  const queue = [...(byId.get(stageId)?.depends_on ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestorId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(byId.get(current)?.depends_on ?? []));
  }
  return false;
}
