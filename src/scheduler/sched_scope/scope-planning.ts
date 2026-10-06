// Boundary: Persist unresolved negotiation inputs, resolve/defer dispositions and dependency blocking; no capability is granted by prompt prose.
import { type ScopeStageKind, publishJsonCreateOnly } from "../../runtime-negotiation.js";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { type StageConfig } from "../sched_admission/configuration.js";
import { scopeContainsPath } from './path-capabilities.js';

export const SCOPE_PLANNING_INPUT_PREFIX = 'scope_negotiation_input_';

const SCOPE_PLANNING_DISPOSITION_PREFIX = 'scope_negotiation_disposition_';

export interface ScopePlanningInputV1 {
  version: 1;
  kind: 'scope_negotiation_planning_input';
  digest: string;
  runId: string;
  sourceIteration: number;
  stageId: string;
  stageKind: ScopeStageKind;
  requestedPaths: string[];
  pathDigest: string;
  rejectionReason: string;
  auditPath: string;
}

interface ScopePlanningDispositionV1 {
  version: 1;
  kind: 'scope_negotiation_disposition';
  digest: string;
  iteration: number;
  disposition: 'resolve' | 'defer';
  basis: string;
  stageId?: string;
  recordedAt: string;
}

function readJsonArtifacts<T>(runDirPath: string, prefix: string): T[] {
  let files: string[];
  try { files = readdirSync(runDirPath); } catch { return []; }
  return files.filter((file) => file.startsWith(prefix) && file.endsWith('.json')).sort().flatMap((file) => {
    try { return [JSON.parse(readFileSync(join(runDirPath, file), 'utf-8')) as T]; } catch { return []; }
  });
}

export function pendingScopePlanningInputs(runDirPath: string): ScopePlanningInputV1[] {
  const inputs = readJsonArtifacts<ScopePlanningInputV1>(runDirPath, SCOPE_PLANNING_INPUT_PREFIX);
  const disposed = new Set(
    readJsonArtifacts<ScopePlanningDispositionV1>(runDirPath, SCOPE_PLANNING_DISPOSITION_PREFIX)
      .map((entry) => entry.digest),
  );
  return inputs.filter((entry) => !disposed.has(entry.digest));
}

export function scopePlanningDispositionDigests(runDirPath: string): Set<string> {
  return new Set(
    readJsonArtifacts<ScopePlanningDispositionV1>(runDirPath, SCOPE_PLANNING_DISPOSITION_PREFIX)
      .filter((entry) => entry.disposition === 'resolve' || entry.disposition === 'defer')
      .map((entry) => entry.digest),
  );
}

export function scopePlanningDigestsBlockingStage(
  runDirPath: string,
  stageId: string,
  dispatchedStages: readonly StageConfig[],
): string[] {
  const inputs = pendingScopePlanningInputs(runDirPath);
  if (inputs.length === 0) return [];
  const digestsByStage = new Map<string, string[]>();
  for (const input of inputs) {
    const current = digestsByStage.get(input.stageId) ?? [];
    if (!current.includes(input.digest)) current.push(input.digest);
    digestsByStage.set(input.stageId, current);
  }
  const stageById = new Map(dispatchedStages.map((stage) => [stage.id, stage]));
  const visited = new Set<string>();
  const digests = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const digest of digestsByStage.get(current) ?? []) digests.add(digest);
    for (const dependency of stageById.get(current)?.depends_on ?? []) queue.push(dependency);
  }
  return [...digests].sort();
}

export function appendScopePlanningInput(prompt: string, runDirPath: string): string {
  const pending = pendingScopePlanningInputs(runDirPath);
  if (pending.length === 0) return prompt;
  const rows = pending.map((entry) => ({
    digest: entry.digest,
    stageKind: entry.stageKind,
    requestedPaths: entry.requestedPaths,
    rejectionReason: entry.rejectionReason,
    auditPath: entry.auditPath,
  }));
  return `${prompt}\n\n# Pending scope-negotiation planning input\n${JSON.stringify(rows, null, 2)}\n`
    + `For every digest, either resolve it by predeclaring all requested paths in one dispatched stage's scope, `
    + `or defer it explicitly in dispatch.yaml as scope_negotiation: { defer: ["<digest>"] }. `
    + `The scheduler records one immutable resolve/defer disposition and will not duplicate the same unresolved digest.`;
}

export function applyScopePlanningDispositions(
  runDirPath: string,
  iteration: number,
  rawDispatch: unknown,
  dispatched: StageConfig[],
): void {
  const pending = pendingScopePlanningInputs(runDirPath);
  if (pending.length === 0) return;
  const wrapper = rawDispatch && typeof rawDispatch === 'object' && !Array.isArray(rawDispatch)
    ? rawDispatch as Record<string, unknown>
    : {};
  const negotiation = wrapper.scope_negotiation && typeof wrapper.scope_negotiation === 'object'
    ? wrapper.scope_negotiation as Record<string, unknown>
    : {};
  const deferred = new Set(
    Array.isArray(negotiation.defer)
      ? negotiation.defer.filter((value): value is string => typeof value === 'string')
      : [],
  );
  for (const entry of pending) {
    const resolvingStage = dispatched.find((stage) => (
      stage.scope !== undefined
      && entry.requestedPaths.every((path) => scopeContainsPath(stage.scope ?? [], path))
    ));
    const disposition: ScopePlanningDispositionV1 | undefined = resolvingStage
      ? {
          version: 1, kind: 'scope_negotiation_disposition', digest: entry.digest, iteration,
          disposition: 'resolve', basis: `planner predeclared every requested path in ${resolvingStage.id}`,
          stageId: resolvingStage.id, recordedAt: new Date().toISOString(),
        }
      : deferred.has(entry.digest)
        ? {
            version: 1, kind: 'scope_negotiation_disposition', digest: entry.digest, iteration,
            disposition: 'defer', basis: 'planner explicitly deferred the digest in dispatch.yaml',
            recordedAt: new Date().toISOString(),
          }
        : undefined;
    if (!disposition) continue;
    publishJsonCreateOnly(
      join(runDirPath, `${SCOPE_PLANNING_DISPOSITION_PREFIX}${entry.digest}_iteration_${iteration}.json`),
      disposition,
    );
  }
}
