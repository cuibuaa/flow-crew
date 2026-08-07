import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export type AdapterName = 'codex' | 'claude';

export const ADAPTER_CLI: Record<AdapterName, string> = {
  codex: 'codex',
  claude: 'claude',
};

// README: “plan in Claude Code, execute in Codex” and hand heavy execution to
// Codex, the default backend. `adapter` selects that execution backend.
export const RECOMMENDED: AdapterName = 'codex';

export const ADAPTER_INSTALL_HINT: Record<AdapterName, string> = {
  codex: 'npm i -g @openai/codex',
  claude: 'npm i -g @anthropic-ai/claude-code',
};

export type AdapterProbe = (command: string) => boolean;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an executable without relying on the optional external `which` utility. */
export function findExecutableOnPath(
  command: string,
  pathValue: string | undefined = process.env.PATH,
): string | undefined {
  if (!command) return undefined;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = resolve(command);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  if (pathValue === undefined) return undefined;
  for (const entry of pathValue.split(delimiter)) {
    const candidate = join(entry || process.cwd(), command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function commandExists(command: string): boolean {
  return findExecutableOnPath(command) !== undefined;
}

/** Physical adapter CLIs currently visible on PATH, in stable recommendation order. */
export function installedAdapters(probe: AdapterProbe = commandExists): AdapterName[] {
  return (Object.keys(ADAPTER_CLI) as AdapterName[])
    .filter((adapter) => probe(ADAPTER_CLI[adapter]));
}

export type AdapterResolution =
  | { ok: true; adapter: AdapterName; reason: string }
  | { ok: false; error: 'none-installed'; hint: string };

export interface AdapterChoiceOptions {
  explicit?: string;
  configured?: string;
}

function normalizeChoice(value: string | undefined, source: string): AdapterName | 'auto' | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'codex' || normalized === 'claude') return normalized;
  throw new Error(`Unknown ${source} adapter "${value}". Available adapters: auto, codex, claude`);
}

function noAdapterHint(): string {
  return [
    'No adapter CLI is installed or visible on PATH.',
    `Install Codex: ${ADAPTER_INSTALL_HINT.codex}`,
    `Install Claude Code: ${ADAPTER_INSTALL_HINT.claude}`,
    'Then run `flowcrew doctor` to verify the installation.',
  ].join('\n');
}

/**
 * Resolve one runtime choice without prompting or writing configuration.
 * The optional installed snapshot is the dependency-injection seam used by tests.
 */
export function resolveAdapterChoice(
  opts: AdapterChoiceOptions,
  installed: readonly AdapterName[] = installedAdapters(),
): AdapterResolution {
  const explicit = normalizeChoice(opts.explicit, 'explicit');
  // An explicit --adapter wins outright, so the lower-priority project setting is
  // never consulted and must not be validated: rejecting it here would make a
  // stale or `mock` config value fail a run the flag alone fully determines.
  const configured = explicit === undefined
    ? normalizeChoice(opts.configured, 'configured')
    : undefined;
  const available = new Set<AdapterName>(installed);
  if (available.size === 0) {
    return { ok: false, error: 'none-installed', hint: noAdapterHint() };
  }

  const requested = explicit ?? configured ?? 'auto';
  const source = explicit !== undefined
    ? 'explicit --adapter choice'
    : configured !== undefined
      ? 'project configuration'
      : 'automatic selection';

  if (requested !== 'auto' && available.has(requested)) {
    return {
      ok: true,
      adapter: requested,
      reason: `Selected ${requested} from the ${source}; its CLI is installed.`,
    };
  }

  if (requested !== 'auto') {
    const fallback = (Object.keys(ADAPTER_CLI) as AdapterName[])
      .find((adapter) => available.has(adapter));
    if (fallback) {
      return {
        ok: true,
        adapter: fallback,
        reason: `The ${source} requested ${requested}, but its CLI is not installed; using installed ${fallback} as the runtime fallback.`,
      };
    }
  }

  if (available.has(RECOMMENDED)) {
    const bothInstalled = available.size === Object.keys(ADAPTER_CLI).length;
    return {
      ok: true,
      adapter: RECOMMENDED,
      reason: bothInstalled
        ? `Adapter selection is auto and both CLIs are installed; selected recommended execution backend ${RECOMMENDED}.`
        : `Adapter selection is auto; selected the only installed CLI, ${RECOMMENDED}.`,
    };
  }

  const onlyInstalled = (Object.keys(ADAPTER_CLI) as AdapterName[])
    .find((adapter) => available.has(adapter))!;
  return {
    ok: true,
    adapter: onlyInstalled,
    reason: `Adapter selection is auto; selected the only installed CLI, ${onlyInstalled}.`,
  };
}
