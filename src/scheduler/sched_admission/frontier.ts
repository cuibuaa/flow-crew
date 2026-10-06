/** DAG reachability, topological order, readiness and conservative parallel scope conflicts. Gate readers are explicit services. */
import { type StoreState, isPendingStageStatus, isSatisfiedStageDependencyStatus, runDir, type WriteAttribution, type StageStatus } from '../../store.js';
import { existsSync } from 'node:fs';
import { join, isAbsolute, posix } from 'node:path';
import { type StageConfig } from './configuration.js';
import type { GateContract } from '../../scheduler.js';

export function topoSort(stages: StageConfig[]): StageConfig[] {
  const ids = new Set(stages.map((s) => s.id));
  if (ids.size !== stages.length) throw new Error('Duplicate stage IDs detected');
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of stages) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of stages) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(d)) throw new Error(`Unknown dependency "${d}" in stage "${s.id}"`);
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
  if (sorted.length !== stages.length) throw new Error('Cycle detected in workflow stages');
  const order = new Map(sorted.map((id, i) => [id, i]));
  return [...stages].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export interface GateReadServices {
  loadGateContract(projectDir: string, runId?: string, campaignStorageKey?: string): GateContract | null;
  readGateVerdict(projectDir: string, stageId: string, runId?: string, contract?: GateContract | null, allowSharedFallback?: boolean, requireValidationDelta?: boolean): { pass: boolean; reason?: string } | null;
}

export function createReadyFinder({ loadGateContract, readGateVerdict }: GateReadServices) {
  return (function findAllReady(stages: StageConfig[], state: StoreState): StageConfig[] {
    const ready: StageConfig[] = [];
    const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
    let contract: ReturnType<typeof loadGateContract> | undefined;
    for (const s of stages) {
      const ss = state.stages[s.id];
      if (!ss || !isPendingStageStatus(ss.status)) continue;
      const depsReady = (s.depends_on ?? []).every((d) => {
        const ds = state.stages[d];
        if (!ds || !isSatisfiedStageDependencyStatus(ds.status)) return false;
        const dependency = stagesById.get(d);
        const hasRunLocation = typeof state.projectDir === 'string' && typeof state.runId === 'string';
        if (hasRunLocation && contract === undefined) {
          contract = loadGateContract(state.projectDir, state.runId, state.campaignStorageKey);
        }
        const hasSpecificVerdict = hasRunLocation && existsSync(join(
          runDir(state.projectDir, state.runId),
          `verdict_${d}.json`,
        ));
        const verdict = hasRunLocation && (dependency?.is_gate === true || hasSpecificVerdict)
          ? readGateVerdict(state.projectDir, d, state.runId, contract, false, dependency?.is_gate === true)
          : undefined;
        // A negative verdict is authoritative even if an older/static workflow
        // forgot to mark the producing stage as a gate. Stage status describes
        // process completion; it must never turn an explicit rejection into a
        // satisfied dependency.
        if (verdict?.pass === false) return false;
        // A `retry_to` edge is retry wiring, not an ordinary dependency.
        // `normalizeRetryGateRelationships` puts the gate into `depends_on` so a fix can be
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

export type ParsedScope =
  | { kind: 'exact'; raw: string; value: string }
  | { kind: 'tree'; raw: string; value: string }
  | { kind: 'glob'; raw: string; directoryPrefix: string; segments: ParsedScopeSegment[] }
  | { kind: 'unknown'; raw: string; reason: string };

type ParsedScopeSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; value: string }
  | { kind: 'globstar'; value: '**' };

function parsedScopeSegments(path: string): ParsedScopeSegment[] {
  return path.split('/').map((segment): ParsedScopeSegment => {
    if (segment === '**') return { kind: 'globstar', value: '**' };
    if (/[*!?[{]/.test(segment)) return { kind: 'wildcard', value: segment };
    return { kind: 'literal', value: segment };
  });
}

export function parseDeclaredScope(rawValue: string): ParsedScope {
  const raw = rawValue.trim();
  const slashNormalized = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!slashNormalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  if (isAbsolute(slashNormalized) || /^[A-Za-z]:\//.test(slashNormalized)) {
    return { kind: 'unknown', raw, reason: 'scope must be project-relative' };
  }
  const segments = slashNormalized.split('/');
  if (segments.includes('..')) return { kind: 'unknown', raw, reason: 'scope may not traverse outside the project' };
  // Preserve an explicit directory marker while canonicalizing harmless path
  // aliases. In particular, `dir/`, `dir/.`, and `./dir/` must all conflict
  // with the ambiguous bare literal `dir` and with descendants of `dir`.
  const explicitDirectory = slashNormalized.endsWith('/') || slashNormalized.endsWith('/.');
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  const globAt = normalized.search(/[*!?[{]/);
  if (globAt >= 0) {
    const literal = normalized.slice(0, globAt);
    const slash = literal.lastIndexOf('/');
    return {
      kind: 'glob',
      raw,
      directoryPrefix: slash >= 0 ? literal.slice(0, slash) : '',
      segments: parsedScopeSegments(normalized),
    };
  }
  if (explicitDirectory) return { kind: 'tree', raw, value: normalized };
  return { kind: 'exact', raw, value: normalized };
}

function prefixesAreProvablyDisjoint(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = a.replace(/\/$/, '').split('/');
  const right = b.replace(/\/$/, '').split('/');
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return true;
  }
  return false;
}

function parsedScopesMayOverlap(a: ParsedScope, b: ParsedScope): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  // A literal without a trailing slash is ambiguous: it may name either a
  // file or a directory. Treat path-segment ancestry as a possible overlap,
  // while still proving similarly named siblings (for example src vs src-ui)
  // disjoint.
  if (a.kind !== 'glob' && b.kind !== 'glob') {
    return !prefixesAreProvablyDisjoint(a.value, b.value);
  }

  const aSegments = a.kind === 'glob' ? a.segments : parsedScopeSegments(a.value);
  const bSegments = b.kind === 'glob' ? b.segments : parsedScopeSegments(b.value);
  const length = Math.min(aSegments.length, bSegments.length);
  for (let index = 0; index < length; index++) {
    const left = aSegments[index];
    const right = bSegments[index];
    // A globstar destroys fixed segment alignment from this point onward.
    if (left.kind === 'globstar' || right.kind === 'globstar') return true;
    // Ordinary wildcard segments consume exactly one path segment, so later
    // aligned literals can still prove that the two languages are disjoint.
    if (left.kind === 'literal' && right.kind === 'literal' && left.value !== right.value) return false;
  }
  return true;
}

export interface ScopeConflict {
  leftStageId: string;
  rightStageId: string;
  leftScope?: string;
  rightScope?: string;
  reason: string;
}

export function findScopeConflict(left: StageConfig, right: StageConfig): ScopeConflict | undefined {
  if (!left.scope) return { leftStageId: left.id, rightStageId: right.id, reason: `${left.id} has no declared scope` };
  if (!right.scope) return { leftStageId: left.id, rightStageId: right.id, reason: `${right.id} has no declared scope` };
  // An explicitly empty scope means the stage declares no project writes.
  if (left.scope.length === 0 || right.scope.length === 0) return undefined;
  const leftParsed = left.scope.map(parseDeclaredScope);
  const rightParsed = right.scope.map(parseDeclaredScope);
  for (const a of leftParsed) {
    if (a.kind === 'unknown') return { leftStageId: left.id, rightStageId: right.id, leftScope: a.raw, reason: `${left.id}: ${a.reason}` };
    for (const b of rightParsed) {
      if (b.kind === 'unknown') return { leftStageId: left.id, rightStageId: right.id, rightScope: b.raw, reason: `${right.id}: ${b.reason}` };
      if (parsedScopesMayOverlap(a, b)) {
        return {
          leftStageId: left.id,
          rightStageId: right.id,
          leftScope: a.raw,
          rightScope: b.raw,
          reason: `declared scopes may overlap: ${a.raw} ↔ ${b.raw}`,
        };
      }
    }
  }
  return undefined;
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
        + `but their project-write scopes are not provably disjoint (${details.join('; ')}). `
        + 'They are admitted but will be serialized at runtime; give stages intended to run in parallel separate project paths.',
      );
    }

    for (const stage of frontier) remaining.delete(stage.id);
  }
  return warnings;
}

export interface ParallelWriteConflict {
  stageIds: [string, string];
  files: string[];
  attribution: [WriteAttribution, WriteAttribution];
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

function directlyAttributesWrites(attribution: WriteAttribution): boolean {
  switch (attribution) {
    case 'structured':
      return true;
    case 'snapshot':
    case 'unknown':
      return false;
    default: {
      const exhaustive: never = attribution;
      void exhaustive;
      return false;
    }
  }
}

export function detectParallelWriteConflicts(
  stageIds: string[],
  statuses: Record<string, StageStatus>,
): ParallelWriteConflict[] {
  const conflicts: ParallelWriteConflict[] = [];
  for (let i = 0; i < stageIds.length; i++) {
    const left = latestAttemptWrites(statuses[stageIds[i]]);
    const leftSet = new Set(left.files);
    for (let j = i + 1; j < stageIds.length; j++) {
      const right = latestAttemptWrites(statuses[stageIds[j]]);
      // A shared-worktree snapshot observes that a path changed while the stage
      // ran; it cannot establish which concurrent stage authored the change.
      // Require direct attribution from both sides before claiming co-authorship.
      if (!directlyAttributesWrites(left.attribution) || !directlyAttributesWrites(right.attribution)) continue;
      const files = [...new Set(right.files.filter((file) => leftSet.has(file)))].sort();
      if (files.length > 0) {
        conflicts.push({
          stageIds: [stageIds[i], stageIds[j]],
          files,
          attribution: [left.attribution, right.attribution],
        });
      }
    }
  }
  return conflicts;
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
