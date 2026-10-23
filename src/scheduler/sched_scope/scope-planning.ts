// Historical unresolved scope-negotiation evidence remains readable for reporting.
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

export const SCOPE_PLANNING_INPUT_PREFIX = 'scope_negotiation_input_';

const SCOPE_PLANNING_DISPOSITION_PREFIX = 'scope_negotiation_disposition_';

export interface ScopePlanningInputV1 {
  version: 1;
  kind: 'scope_negotiation_planning_input';
  digest: string;
  runId: string;
  sourceIteration: number;
  stageId: string;
  stageKind: 'ordinary' | 'gate';
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
