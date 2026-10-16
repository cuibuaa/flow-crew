import { writeFileSync } from './engine-fs.js';

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { STAGE_STATUS, type StoreState } from './store.js';
import { recordRunEvent } from './run-events.js';
import { resolveResearchPaths } from './research-paths.js';
import { readLiveConstraintContentIdentity } from './live-constraint-guard.js';
import { rollbackStatIdentity } from './rollback-content-store.js';
import { resolveArtifactLocation } from './artifact-location.js';
import { normalizedProjectContentPath } from './scheduler/sched_admission/scope-services.js';
import { canonicalPotentialProjectPath, listProjectFilesAt } from './scheduler/sched_scope/path-capabilities.js';

export interface ResearchInputGeneration {
  startedAt: string;
  resultFile: string;
  baselines: Record<string, string | null>;
}

function fingerprint(projectDir: string, path: string): string | null {
  try {
    resolveArtifactLocation({ root: 'project', path }, projectDir, projectDir);
    const identity = readLiveConstraintContentIdentity(canonicalPotentialProjectPath(projectDir, path));
    return identity.state === 'present' && identity.type === 'file' ? identity.sha256 : null;
  } catch { return null; }
}

function publicationIdentity(projectDir: string, path: string): string | undefined {
  try {
    resolveArtifactLocation({ root: 'project', path }, projectDir, projectDir);
    const identity = rollbackStatIdentity(canonicalPotentialProjectPath(projectDir, path));
    return identity?.type === 'file' ? `${identity.dev}:${identity.ino}` : undefined;
  } catch { return undefined; }
}

/** Admission and inference share the consumer's bounded regular-file domain. */
export function researchEvidenceFiles(projectDir: string, files: readonly string[]): string[] {
  return files.filter(path => {
    if (basename(path) !== 'evidence.json') return false;
    try {
      const absolute = resolveArtifactLocation({ root: 'project', path }, projectDir, projectDir);
      const stat = lstatSync(absolute);
      return stat.isFile() && stat.size <= 4 * 1024 * 1024;
    } catch { return false; }
  });
}

/** The settled current producer ledger proves publication, even for equal bytes.
 * Match file identity so internal aliases work without promoting unrelated copies. */
function hasCompletedPublication(projectDir: string, state: StoreState, path: string): boolean {
  const identity = publicationIdentity(projectDir, path);
  return identity !== undefined && Object.values(state.stages).some(stage => {
    const attempt = stage.attempts?.at(-1);
    return stage.status === STAGE_STATUS.COMPLETE && attempt?.status === STAGE_STATUS.COMPLETE
      && (attempt.iteration ?? 1) === (state.currentIteration ?? 1)
      && (attempt.writes ?? []).some(written => {
        const normalized = normalizedProjectContentPath(written);
        return normalized !== undefined && publicationIdentity(projectDir, normalized) === identity;
      });
  });
}

/** Snapshot mutable slots before dispatch, as attempt evidence generation does. */
export function beginResearchInputGeneration(projectDir: string, state: StoreState): void {
  if (!state.research) return;
  const paths = resolveResearchPaths(state.research);
  const previous = state.researchInputGeneration;
  if (previous?.startedAt === state.startedAt && previous.resultFile === paths.resultFile) return;
  const files = new Set([paths.resultFile, `${paths.resultFile}.no_candidate.json`,
    ...researchEvidenceFiles(projectDir, listProjectFilesAt(projectDir, paths.reportDir))]);
  state.researchInputGeneration = {
    startedAt: state.startedAt,
    resultFile: paths.resultFile,
    baselines: Object.fromEntries([...files].map(path => [path, fingerprint(projectDir, path)])),
  };
}

/** Changed content or completed current production establishes freshness without
 * realtime ordering. The same ledger also preserves pending legacy production. */
export function researchInputIsFresh(projectDir: string, state: StoreState, path: string): boolean {
  const generation = state.researchInputGeneration;
  if (!generation || generation.startedAt !== state.startedAt
    || !state.research || generation.resultFile !== resolveResearchPaths(state.research).resultFile) return false;
  const current = fingerprint(projectDir, path);
  return current !== null && (current !== (generation.baselines[path] ?? null)
    || hasCompletedPublication(projectDir, state, path));
}

export interface ResearchGateCandidate {
  version: 1;
  gateStageId?: string;
  kind: 'measured' | 'no_candidate' | 'invalid' | 'absent';
  capturedAt: string;
  source: string;
  sha256?: string;
  label?: string;
  result?: number;
  reason?: string;
  /** Exact reviewed bytes, including brief-specific schema and integrity fields. */
  evidenceJson?: string;
  settlement?: { disposition: 'ingested' | 'rejected'; reason: string };
}

export const RESEARCH_GATE_CANDIDATE_FILE = 'research_gate_candidate.json';

function candidateFile(gateStageId?: string): string {
  if (!gateStageId) return RESEARCH_GATE_CANDIDATE_FILE;
  const binding = createHash('sha256').update(gateStageId, 'utf8').digest('hex').slice(0, 16);
  return `research_gate_candidate_${binding}.json`;
}

function classify(source: string, bytes: Buffer): ResearchGateCandidate {
  const base = { version: 1 as const, capturedAt: new Date().toISOString(), source, evidenceJson: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf-8')) as Record<string, unknown>; }
  catch { return { ...base, kind: 'invalid', reason: 'candidate evidence is not valid JSON' }; }
  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined;
  if (!label) return { ...base, kind: 'invalid', reason: 'candidate evidence has no non-empty label' };
  if (value.outcome === 'no_candidate' || (value.outcome === undefined && value.status === 'no_candidate')) {
    return typeof value.reason === 'string' && value.reason.trim()
      ? { ...base, kind: 'no_candidate', label, reason: value.reason.trim() }
      : { ...base, kind: 'invalid', label, reason: 'no_candidate evidence has no non-empty reason' };
  }
  return typeof value.result === 'number' && Number.isFinite(value.result)
    ? { ...base, kind: 'measured', label, result: value.result }
    : { ...base, kind: 'invalid', label, reason: 'measured candidate evidence has no finite result' };
}

function immutableConsumed(runDir: string): string | undefined {
  try {
    return readdirSync(runDir)
      .filter((name) => /^research_round_\d+_(?:no_candidate_)?consumed\.json$/.test(name))
      .sort((left, right) => Number(/\d+/.exec(left)?.[0]) - Number(/\d+/.exec(right)?.[0]))
      .at(-1);
  } catch { return undefined; }
}

export function captureResearchGateCandidate(
  projectDir: string,
  runDir: string,
  gateStageId?: string,
): ResearchGateCandidate {
  const destination = join(runDir, candidateFile(gateStageId));
  const previous = readResearchGateCandidate(runDir, gateStageId);
  if (previous && !previous.settlement) {
    settleResearchGateCandidate(projectDir, runDir, previous, 'rejected', 'Gate was re-evaluated before this captured outcome was ingested');
  }
  const consumed = immutableConsumed(runDir);
  let state: StoreState | undefined;
  try { state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')) as StoreState; } catch { /* fallback below */ }
  let candidate: ResearchGateCandidate;
  if (state?.research) {
    const result = resolveResearchPaths(state.research).resultFile;
    const resultPath = join(projectDir, result);
    const sidecarPath = `${resultPath}.no_candidate.json`;
    const measured = researchInputIsFresh(projectDir, state, result);
    const noCandidate = researchInputIsFresh(projectDir, state, `${result}.no_candidate.json`);
    if (measured && noCandidate) {
      candidate = { version: 1, kind: 'invalid', capturedAt: new Date().toISOString(), source: result, reason: 'both measured and no_candidate evidence are fresh' };
    } else if (measured || noCandidate) {
      const source = noCandidate ? `${result}.no_candidate.json` : result;
      candidate = classify(source, readFileSync(noCandidate ? sidecarPath : resultPath));
    } else if (consumed) {
      candidate = classify(consumed, readFileSync(join(runDir, consumed)));
    } else {
      candidate = { version: 1, kind: 'absent', capturedAt: new Date().toISOString(), source: result, reason: 'no fresh round outcome exists' };
    }
  } else if (consumed) {
    candidate = classify(consumed, readFileSync(join(runDir, consumed)));
  } else {
    candidate = { version: 1, kind: 'absent', capturedAt: new Date().toISOString(), source: 'run.json', reason: 'run is not in research mode' };
  }
  const bound = gateStageId ? { ...candidate, gateStageId } : candidate;
  writeFileSync(destination, `${JSON.stringify(bound, null, 2)}\n`, 'utf-8');
  return bound;
}

export function readResearchGateCandidate(runDir: string, gateStageId?: string): ResearchGateCandidate | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, candidateFile(gateStageId)), 'utf-8')) as ResearchGateCandidate;
    if (parsed.version !== 1) return undefined;
    if (gateStageId && parsed.gateStageId !== gateStageId) return undefined;
    return parsed;
  } catch { return undefined; }
}

/** One settlement channel for reviewed evidence, including superseded captures. */
export function settleResearchGateCandidate(
  projectDir: string, runDir: string, candidate: ResearchGateCandidate,
  disposition: 'ingested' | 'rejected', reason: string,
): void {
  if (candidate.settlement) return;
  candidate.settlement = { disposition, reason };
  writeFileSync(join(runDir, candidateFile(candidate.gateStageId)), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as StoreState;
  recordRunEvent(projectDir, state.runId, {
    type: 'research_gate_candidate_settled', runId: state.runId,
    timestamp: new Date().toISOString(), iteration: state.currentIteration,
    stageId: candidate.gateStageId, source: 'scheduler',
    detail: `${disposition}: ${reason}; label=${JSON.stringify(candidate.label)}; sha256=${candidate.sha256 ?? 'absent'}`,
  });
}

export function pendingResearchGateCandidates(runDir: string): ResearchGateCandidate[] {
  return readdirSync(runDir)
    .filter(name => /^research_gate_candidate(?:_[a-f0-9]{16})?\.json$/.test(name))
    .flatMap(name => {
      const candidate = JSON.parse(readFileSync(join(runDir, name), 'utf8')) as ResearchGateCandidate;
      return candidate.version === 1 && !candidate.settlement ? [candidate] : [];
    })
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function rejectPendingResearchGateCandidates(projectDir: string, runDir: string, reason: string): void {
  for (const candidate of pendingResearchGateCandidates(runDir)) {
    settleResearchGateCandidate(projectDir, runDir, candidate, 'rejected', reason);
  }
}
