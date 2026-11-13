import { DeclarationRefusal, parseBriefDeclarations, type BriefDeclarations } from '../../brief-declarations.js';
import { type BriefFrontmatterDocument, parseBriefFrontmatterDocument } from '../../brief-frontmatter.js';
/** Brief frontmatter, duration/floor contracts; no dispatch admission or execution. */
import { type TerminalStatesConfig, type ResearchConfig, type TerminalStateEntry, type StoreState } from '../../store.js';
import { join } from 'node:path';
import { artifactOwnership, terminalArtifactIdentity, ARTIFACT_OWNERSHIP_UNVERIFIED } from '../../terminal-artifact-status.js';
import type { ContentIdentity } from '../../content-identity.js';
import { within } from '../../source_services/cli-inputs.js';
import { resolve } from 'node:path';
import { readdirSync, realpathSync } from 'node:fs';
import { type BriefOutputDeclaration, outputsFromDeclarations } from '../../ship-inputs.js';
import { log } from './shared.js';

export interface ParsedBriefFrontmatter {
  maxContinuations?: number;
  workflowError?: string;
  terminalStates?: TerminalStatesConfig;
  /** The only active research contract is a versioned frozen instrument declaration. */
  research?: ResearchConfig;
  researchPolicyError?: string;
  outputs?: BriefOutputDeclaration[];
  stripped: string;
  frontmatterError?: string;
  declarationRefusal?: DeclarationRefusal;
  frontmatterErrorKind?: BriefFrontmatterDocument['errorKind'];
}

/** An instrument declaration owns research shape; engineering enters the chooser. */
export function entryWorkflow(parsed: ParsedBriefFrontmatter): { workflow: string; reason: string; error?: string } {
  const error = (parsed.frontmatterErrorKind === 'yaml' ? parsed.frontmatterError : undefined) ?? parsed.workflowError ?? parsed.researchPolicyError;
  return { workflow: parsed.research ? 'research' : 'entry', reason: parsed.research ? 'The instrument declaration fixes the research loop.' : 'The model chooser selects the engineering shape.', ...(error ? { error } : {}) };
}

export function parseBriefFrontmatter(brief: string): ParsedBriefFrontmatter {
  const document = parseBriefFrontmatterDocument(brief);
  const stripped = document?.body ?? brief;
  try {
    const declaration = parseBriefDeclarations(brief);
    return { ...declarationConfiguration(declaration, stripped), stripped };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { stripped, ...(error instanceof DeclarationRefusal ? { declarationRefusal: error } : {}), frontmatterError: reason, frontmatterErrorKind: document?.errorKind ?? 'yaml', workflowError: reason };
  }
}

/** Project only a declaration already checked by the shared schema/hash boundary. */
export function declarationConfiguration(declaration: BriefDeclarations, brief = ''): ParsedBriefFrontmatter {
  const ts: TerminalStatesConfig = {};
  for (const [status, value] of Object.entries(declaration.terminal_states ?? {})) {
    if (value === undefined) continue;
    const entry = typeof value === 'string' ? { paths: [value] } : Array.isArray(value) ? { paths: value } : value;
    ts[status as keyof TerminalStatesConfig] = {
      paths: entry.paths,
      ...('floor' in entry && entry.floor ? { floor: {
        minAttemptedStages: entry.floor.min_attempted_stages, minWallMinutes: entry.floor.min_wall_minutes,
      } } : {}),
      ...('stage_glob' in entry ? { stageGlob: entry.stage_glob } : {}),
      ...('post_terminate_hook' in entry && entry.post_terminate_hook ? { postTerminateHook: {
        command: entry.post_terminate_hook.command, args: entry.post_terminate_hook.args,
        timeoutSeconds: entry.post_terminate_hook.timeout_seconds, env: entry.post_terminate_hook.env,
      } } : {}),
    };
  }
  return { stripped: brief, maxContinuations: declaration.max_continuations, research: declaration.research,
    outputs: outputsFromDeclarations(declaration, brief), ...(Object.keys(ts).length ? { terminalStates: ts } : {}) };
}

export function evaluateTerminalFloor(
  state: StoreState,
  entry: TerminalStateEntry,
  projectDir: string,
): { passed: boolean; reason?: string; reasonCode?: typeof ARTIFACT_OWNERSHIP_UNVERIFIED } {
  if (!entry.floor) return { passed: true };
  const { floor, stageGlob } = entry;
  const startedAtMs = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { passed: false, reason: `run startedAt '${state.startedAt}' is invalid; freshness cannot be proven` };
  }
  const elapsedMin = ((Date.now() - startedAtMs) / 60000);

  // Count fresh nonempty receipts matching the declared evidence pattern.
  // Result checks own whether the evidence proves the outcome; a count or
  // duration cannot establish its substance.
  if (floor.minAttemptedStages !== undefined) {
    const glob = terminalReceiptGlob(entry);
    const baseline = glob ? state.terminalReceiptBaselines?.[glob] : undefined;
    if (!baseline || baseline.error) return { passed: false, reasonCode: ARTIFACT_OWNERSHIP_UNVERIFIED,
      reason: 'terminal receipt content baseline is unavailable' };
    const files = glob ? receiptIdentities(projectDir, glob) : { files: {} };
    if (files.error) return { passed: false, reasonCode: ARTIFACT_OWNERSHIP_UNVERIFIED, reason: files.error };
    let fresh = 0, stale = 0;
    for (const [path, identity] of Object.entries(files.files)) {
      if (identity.state !== 'present' || identity.type !== 'file' || identity.byteLength === 0) continue;
      const ownership = artifactOwnership(baseline.files[path] ?? { state: 'absent' }, identity);
      if (ownership === 'unverified') return { passed: false, reasonCode: ARTIFACT_OWNERSHIP_UNVERIFIED, reason: 'terminal receipt content is unavailable' };
      if (ownership === 'current') fresh++; else stale++;
    }
    const matches = { fresh, stale };
    if (matches.fresh < floor.minAttemptedStages) {
      const globSource = stageGlob ? 'configured stage_glob' : 'inferred stage_glob';
      const staleDetail = matches.stale > 0
        ? `; ${matches.stale} matching file(s) have unchanged launch content`
        : '';
      return {
        passed: false,
        reason: `only ${matches.fresh} fresh stage verdict file(s) match ${globSource} '${glob}'${staleDetail}; need ${floor.minAttemptedStages}`,
      };
    }
    // Stages satisfied → floor passes. Wall time is informational only.
    if (floor.minWallMinutes !== undefined && elapsedMin < floor.minWallMinutes) {
      log.info(
        { minAttemptedStages: floor.minAttemptedStages, matches: matches.fresh, elapsedMin: Number(elapsedMin.toFixed(1)), minWallMinutes: floor.minWallMinutes },
        'Terminal floor: stages satisfied; passing despite wall time below min_wall_minutes (wall is advisory when stages are set)',
      );
    }
    return { passed: true };
  }

  // No stage requirement configured — fall back to wall time as the sole gate.
  if (floor.minWallMinutes !== undefined && elapsedMin < floor.minWallMinutes) {
    return { passed: false, reason: `wall time ${elapsedMin.toFixed(1)} min < required ${floor.minWallMinutes} min (no min_attempted_stages set)` };
  }
  return { passed: true };
}

export function terminalReceiptGlob(entry: TerminalStateEntry): string | undefined {
  if (entry.floor?.minAttemptedStages === undefined) return undefined;
  const first = entry.paths[0];
  return entry.stageGlob ?? (first ? `${first.includes('/') ? first.substring(0, first.lastIndexOf('/')) : '.'}/stage_*_verdict.md` : undefined);
}

export interface ReceiptBaseline { files: Record<string, ContentIdentity>; error?: string }

/** A successful enumeration records absence for future matching names, too. */
export function receiptIdentities(projectDir: string, glob: string): ReceiptBaseline {
  const files: Record<string, ContentIdentity> = {};
  const slash = glob.lastIndexOf('/');
  const dir = resolve(projectDir, slash >= 0 ? glob.substring(0, slash) : '.');
  const pattern = slash >= 0 ? glob.substring(slash + 1) : glob;
  const re = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try {
    if (!within(resolve(projectDir), dir) || !within(realpathSync.native(projectDir), realpathSync.native(dir))) {
      return { files, error: 'terminal receipt glob escapes its root' };
    }
    for (const name of readdirSync(dir)) {
      if (re.test(name)) files[join(dir, name).substring(resolve(projectDir).length + 1)] = terminalArtifactIdentity(join(dir, name), projectDir);
    }
    return { files };
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? { files }
      : { files, error: 'terminal receipt baseline could not be enumerated' };
  }
}

export function captureTerminalReceiptBaselines(projectDir: string, entries: TerminalStateEntry[]): Record<string, ReceiptBaseline> {
  return Object.fromEntries(entries.flatMap(entry => {
    const glob = terminalReceiptGlob(entry);
    return glob ? [[glob, receiptIdentities(projectDir, glob)]] : [];
  }));
}
