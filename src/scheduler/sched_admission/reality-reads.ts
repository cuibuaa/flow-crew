/** Reachability of explicit reality-check reads and typed handler parameters; script text is never inferred as a read. */
import { type TerminalStatesConfig, type ResearchConfig } from '../../store.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { parseChecksFromMarkdown, type CheckDecl } from '../../reality-gate/index.js';
import { artifactProducerReadError, resolveArtifactLocation } from '../../artifact-declarations.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRealityHandlerReads } from '../../reality-gate/declared-reads.js';
import { type StageConfig } from './configuration.js';
import { normalizedProjectPath } from './scope-services.js';

/** A hard reality check may reference an absent future artifact only when an
 * admitted stage or framework output contract can produce it before terminal
 * verification. */
export function inspectRealityCheckReachability(input: {
  markdown?: string;
  checks?: CheckDecl[];
  projectDir: string;
  stages: StageConfig[];
  terminalStates?: TerminalStatesConfig;
  research?: ResearchConfig;
  runDir?: string;
}): string[] {
  const researchPaths = input.research ? resolveResearchPaths(input.research) : undefined;
  const optionalResearchResultPath = researchPaths
    ? normalizedProjectPath(researchPaths.resultFile)
    : undefined;
  const postConsumptionManifestPath = researchPaths
    ? normalizedProjectPath(researchPaths.manifestFile)
    : undefined;
  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const errors: string[] = [];
  for (const check of input.checks ?? parseChecksFromMarkdown(input.markdown ?? '')) {
    if (check.kind === 'invalid') { errors.push(check.diagnostic); continue; }
    for (const read of check.reads ?? []) {
      try { resolveArtifactLocation(read, input.projectDir, input.runDir ?? input.projectDir); }
      catch (error) { errors.push(`${check.name}.${read.id}: ${String(error)}`); continue; }
      const label = `reality check ${JSON.stringify(check.name)}.${read.id}`;
      if (read.source.kind === 'stage') {
        const producer = byId.get(read.source.stage);
        const error = artifactProducerReadError(read, producer, label);
        if (error) errors.push(error);
      } else if (read.source.kind === 'framework') {
        const expected = read.source.artifact === 'task_brief' ? 'task_brief.md' : 'run.json';
        if (read.root !== 'run' || read.path !== expected || read.kind !== 'file') errors.push(`ARTIFACT_FRAMEWORK_READ_INVALID: ${label} must read file run:${expected}`);
      } else if ((read.root === 'run' && !input.runDir) || !existsSync(join(read.root === 'run' ? input.runDir! : input.projectDir, read.path))) {
        errors.push(`ARTIFACT_INPUT_ABSENT: ${label} requires existing ${read.root}:${read.path}`);
      }
      if (read.root !== 'project') continue;
      if (postConsumptionManifestPath === read.path && !existsSync(join(input.projectDir, read.path))) {
        errors.push(`reality check ${JSON.stringify(check.name)} references post-consumption framework manifest ${read.path}; the scheduler writes it only after the current round's confirmation gates settle. Use scheduler-injected immutable round evidence for current-round confirmation`);
      }
      if (optionalResearchResultPath === read.path) {
        errors.push(`reality check ${JSON.stringify(check.name)} references mutable optional result path ${read.path}; a valid no-candidate round writes only its sidecar ${read.path}.no_candidate.json instead and never writes ${read.path}. Use scheduler-injected immutable round evidence, or declare an unconditional producer for a different artifact`);
      }
    }
    // Handler parameters are typed hard reads; arbitrary script strings are not.
    errors.push(...inspectRealityHandlerReads(check, input.projectDir, input.runDir ?? input.projectDir));
  }
  return errors;
}
