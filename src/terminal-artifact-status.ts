import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isTerminalRunStatus } from './store.js';

export interface TerminalArtifactStatusMismatch {
  lifecycleStatus: string;
  terminalStatus: string;
  terminalArtifact: string;
}

export interface PersistedTerminalArtifactState {
  status?: unknown;
  terminalArtifact?: unknown;
  terminalStates?: unknown;
  startedAt?: unknown;
  projectDir?: unknown;
  stages?: unknown;
}

export interface TerminalArtifactStatusEvidence {
  projectDir?: string;
  runDir?: string;
  artifactMtimeMs?: (path: string) => number | undefined;
}

const SETTLED_STAGE_STATUSES = new Set(['complete', 'failed', 'skipped']);

function matchingStatusesForArtifact(
  terminalStates: object,
  terminalArtifact: string,
): Set<string> {
  const matchingStatuses = new Set<string>();
  for (const [status, rawEntry] of Object.entries(terminalStates)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const paths = (rawEntry as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) continue;
    if (paths.some((path) => typeof path === 'string'
      && path.length > 0
      && basename(path) === terminalArtifact)) {
      matchingStatuses.add(status);
    }
  }
  return matchingStatuses;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

function defaultArtifactMtimeMs(path: string, root: string): number | undefined {
  try {
    const canonicalRoot = realpathSync.native(root);
    const canonicalPath = realpathSync.native(path);
    if (!within(canonicalRoot, canonicalPath)) return undefined;
    const stat = statSync(canonicalPath);
    return stat.isFile() && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function artifactMtimeMs(
  path: string,
  root: string,
  evidence: TerminalArtifactStatusEvidence,
): number | undefined {
  const value = evidence.artifactMtimeMs
    ? evidence.artifactMtimeMs(path)
    : defaultArtifactMtimeMs(path, root);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  if (typeof state.startedAt !== 'string') return undefined;
  const startedAtMs = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAtMs)) return undefined;
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
        const snapshot = safeDeclaredCandidate(evidence.runDir, `terminal_${basename(rawPath)}`);
        if (snapshot) candidates.push({ path: snapshot, root: evidence.runDir });
      }
      if (!candidates.some((candidate) => {
        const mtimeMs = artifactMtimeMs(candidate.path, candidate.root, evidence);
        return mtimeMs !== undefined && mtimeMs >= startedAtMs;
      })) {
        continue;
      }
      fresh.set(`${terminalStatus}\0${rawPath}`, {
        terminalStatus,
        terminalArtifact: basename(rawPath),
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
