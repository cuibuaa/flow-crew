import { realpathSync, statSync } from 'node:fs';
import { compareContentIdentities, readContentIdentity, type ContentIdentity } from './content-identity.js';
import { basename, isAbsolute, resolve } from 'node:path';
import { within } from './source_services/cli-inputs.js';
import { isTerminalRunStatus, terminalArtifactSnapshotName } from './store.js';

export interface TerminalArtifactStatusMismatch {
  lifecycleStatus: string;
  terminalStatus: string;
  terminalArtifact: string;
}

export interface PersistedTerminalArtifactState {
  status?: unknown;
  startedAt?: unknown;
  terminalArtifact?: unknown;
  terminalStates?: unknown;
  terminalArtifactBaselines?: Record<string, ContentIdentity>;
  projectDir?: unknown;
  stages?: unknown;
}

export interface TerminalArtifactStatusEvidence {
  projectDir?: string;
  runDir?: string;
  artifactMtimeMs?: (path: string) => number | undefined;
  artifactIdentity?: (path: string) => ContentIdentity;
}

const SETTLED_STAGE_STATUSES = new Set(['complete', 'failed', 'skipped']);

function matchingStatusesForArtifact(
  terminalStates: object,
  terminalArtifact: string,
): Set<string> {
  const matchingStatuses = new Set<string>();
  const exactStatuses = new Set<string>();
  for (const [status, rawEntry] of Object.entries(terminalStates)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const paths = (rawEntry as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) continue;
    if (paths.includes(terminalArtifact)) exactStatuses.add(status);
    if (paths.some((path) => typeof path === 'string'
      && path.length > 0
      && basename(path) === terminalArtifact)) {
      matchingStatuses.add(status);
    }
  }
  return exactStatuses.size > 0 ? exactStatuses : matchingStatuses;
}

function safeDeclaredCandidate(root: string, declaredPath: string): string | undefined {
  if (!declaredPath
    || declaredPath.includes('\0')
    || declaredPath.includes('\\')
    || isAbsolute(declaredPath)
    || /^[A-Za-z]:[\\/]/.test(declaredPath)) {
    return undefined;
  }
  const candidate = resolve(root, declaredPath);
  return within(resolve(root), candidate) ? candidate : undefined;
}

export function terminalArtifactIdentity(path: string, root: string, evidence: TerminalArtifactStatusEvidence = {}): ContentIdentity {
  try {
    const canonical = evidence.artifactIdentity ? path : realpathSync.native(path);
    return within(evidence.artifactIdentity ? root : realpathSync.native(root), canonical)
      ? evidence.artifactIdentity?.(canonical) ?? readContentIdentity(canonical)
      : { state: 'unavailable', reason: 'terminal artifact escapes its root' };
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
      ? { state: 'absent' } : { state: 'unavailable', reason: String(error) };
  }
}

/** Run-start content is the shared freshness boundary, independent of wall clocks. */
export function freshTerminalArtifact(
  state: PersistedTerminalArtifactState, declaredPath: string, path: string, root: string,
  evidence: TerminalArtifactStatusEvidence = {},
): boolean {
  // Pre-deploy runs have no content boundary: retain their original timestamp meaning.
  if (!state.terminalArtifactBaselines) {
    try {
      const mtimeMs = evidence.artifactMtimeMs ? evidence.artifactMtimeMs(path) : statSync(path).mtimeMs;
      return typeof state.startedAt === 'string' && typeof mtimeMs === 'number'
        && Number.isFinite(mtimeMs) && mtimeMs >= Date.parse(state.startedAt);
    }
    catch { return false; }
  }
  const identity = terminalArtifactIdentity(path, root, evidence);
  if (identity.state !== 'present' || identity.type !== 'file') return false;
  return compareContentIdentities(state.terminalArtifactBaselines[declaredPath] ?? { state: 'absent' }, identity) === 'different';
}

function everyStageSettled(stages: unknown): boolean {
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return false;
  const entries = Object.values(stages);
  return entries.length > 0 && entries.every((stage) => (
    Boolean(stage)
    && typeof stage === 'object'
    && !Array.isArray(stage)
    && SETTLED_STAGE_STATUSES.has(String((stage as { status?: unknown }).status))
  ));
}

function discoverFreshTerminalArtifact(
  state: PersistedTerminalArtifactState,
  evidence: TerminalArtifactStatusEvidence,
): { terminalStatus: string; terminalArtifact: string } | undefined {
  if (typeof state.status !== 'string' || isTerminalRunStatus(state.status)) return undefined;
  if (typeof state.terminalArtifact === 'string' && state.terminalArtifact) return undefined;
  if (!everyStageSettled(state.stages)) return undefined;
  if (!state.terminalStates || typeof state.terminalStates !== 'object' || Array.isArray(state.terminalStates)) {
    return undefined;
  }

  const projectDir = evidence.projectDir
    ?? (typeof state.projectDir === 'string' && state.projectDir ? state.projectDir : undefined);
  const fresh = new Map<string, { terminalStatus: string; terminalArtifact: string }>();
  for (const [terminalStatus, rawEntry] of Object.entries(state.terminalStates)) {
    if (!isTerminalRunStatus(terminalStatus)
      || !rawEntry
      || typeof rawEntry !== 'object'
      || Array.isArray(rawEntry)) {
      continue;
    }
    const paths = (rawEntry as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) continue;
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || !rawPath) continue;
      const validationRoot = projectDir ?? evidence.runDir;
      if (!validationRoot || !safeDeclaredCandidate(validationRoot, rawPath)) continue;
      const candidates: Array<{ path: string; root: string }> = [];
      if (projectDir) {
        const projectCandidate = safeDeclaredCandidate(projectDir, rawPath);
        if (projectCandidate) candidates.push({ path: projectCandidate, root: projectDir });
      }
      if (evidence.runDir) {
        const snapshot = safeDeclaredCandidate(evidence.runDir, terminalArtifactSnapshotName(rawPath));
        if (snapshot) candidates.push({ path: snapshot, root: evidence.runDir });
      }
      if (!candidates.some(candidate => freshTerminalArtifact(state, rawPath, candidate.path, candidate.root, evidence))) continue;
      fresh.set(`${terminalStatus}\0${rawPath}`, {
        terminalStatus,
        terminalArtifact: rawPath,
      });
    }
  }

  return fresh.size === 1 ? [...fresh.values()][0] : undefined;
}

/**
 * Resolve only an unambiguous artifact-to-status disagreement. Lifecycle status
 * remains authoritative for execution; this diagnostic preserves the terminal
 * artifact's independent meaning without rewriting persisted state.
 */
export function terminalArtifactStatusMismatch(
  state: PersistedTerminalArtifactState,
  evidence: TerminalArtifactStatusEvidence = {},
): TerminalArtifactStatusMismatch | undefined {
  if (typeof state.status !== 'string' || !state.status) return undefined;
  if (!state.terminalStates || typeof state.terminalStates !== 'object' || Array.isArray(state.terminalStates)) {
    return undefined;
  }

  if (typeof state.terminalArtifact !== 'string' || !state.terminalArtifact) {
    const discovered = discoverFreshTerminalArtifact(state, evidence);
    if (!discovered) return undefined;
    return {
      lifecycleStatus: state.status,
      terminalStatus: discovered.terminalStatus,
      terminalArtifact: discovered.terminalArtifact,
    };
  }

  const matchingStatuses = matchingStatusesForArtifact(state.terminalStates, state.terminalArtifact);
  if (matchingStatuses.size !== 1) return undefined;
  const terminalStatus = [...matchingStatuses][0];
  if (terminalStatus === state.status) return undefined;
  return {
    lifecycleStatus: state.status,
    terminalStatus,
    terminalArtifact: state.terminalArtifact,
  };
}

export function formatTerminalArtifactStatusMismatch(
  mismatch: TerminalArtifactStatusMismatch,
): string {
  return `lifecycle status ${mismatch.lifecycleStatus}; terminal artifact ${JSON.stringify(mismatch.terminalArtifact)} declares ${mismatch.terminalStatus}`;
}
