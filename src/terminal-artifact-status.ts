import { basename } from 'node:path';

export interface TerminalArtifactStatusMismatch {
  lifecycleStatus: string;
  terminalStatus: string;
  terminalArtifact: string;
}

export interface PersistedTerminalArtifactState {
  status?: unknown;
  terminalArtifact?: unknown;
  terminalStates?: unknown;
}

/**
 * Resolve only an unambiguous artifact-to-status disagreement. Lifecycle status
 * remains authoritative for execution; this diagnostic preserves the terminal
 * artifact's independent meaning without rewriting persisted state.
 */
export function terminalArtifactStatusMismatch(
  state: PersistedTerminalArtifactState,
): TerminalArtifactStatusMismatch | undefined {
  if (typeof state.status !== 'string' || !state.status) return undefined;
  if (typeof state.terminalArtifact !== 'string' || !state.terminalArtifact) return undefined;
  if (!state.terminalStates || typeof state.terminalStates !== 'object' || Array.isArray(state.terminalStates)) {
    return undefined;
  }

  const matchingStatuses = new Set<string>();
  for (const [status, rawEntry] of Object.entries(state.terminalStates)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const paths = (rawEntry as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) continue;
    if (paths.some((path) => typeof path === 'string'
      && path.length > 0
      && basename(path) === state.terminalArtifact)) {
      matchingStatuses.add(status);
    }
  }

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
