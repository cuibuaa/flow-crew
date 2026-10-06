/** Reachability of explicit reality-check reads and typed handler parameters; script text is never inferred as a read. */
import { type TerminalStatesConfig, type ResearchConfig } from '../../store.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { parseChecksFromMarkdown } from '../../reality-gate/index.js';
import { resolveArtifactLocation } from '../../artifact-declarations.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRealityHandlerReads } from '../../reality-gate/declared-reads.js';
import { type StageConfig } from './configuration.js';
import { normalizedProjectPath } from './scope-services.js';
import { stageScopeOwnsPath } from './dispatch.js';
import { transitivelyDependsOn } from './frontier.js';

/** A hard reality check may reference an absent future artifact only when an
 * admitted stage or framework output contract can produce it before terminal
 * verification. */
export function inspectRealityCheckReachability(input: {
  markdown: string;
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
  const terminalPaths = new Set(
    Object.values(input.terminalStates ?? {}).flatMap((entry) => entry.paths)
      .map((path) => normalizedProjectPath(path))
      .filter((path): path is string => Boolean(path)),
  );
  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const terminalOwners = [...terminalPaths].flatMap((path) => {
    const owners = input.stages.filter((stage) => stageScopeOwnsPath(stage, path));
    return owners.length === 1 ? owners : [];
  });
  const errors: string[] = [];
  for (const check of parseChecksFromMarkdown(input.markdown)) {
    if (check.kind === 'invalid') { errors.push(check.diagnostic); continue; }
    if (check.reads === undefined) {
      errors.push(`REALITY_READ_DECLARATION_REQUIRED: reality check ${JSON.stringify(check.name)}.reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration`);
      continue;
    }
    const paths = new Set<string>();
    if (check.reads !== undefined) {
      for (const read of check.reads) {
        try { resolveArtifactLocation(read, input.projectDir, input.runDir ?? input.projectDir); }
        catch (error) { errors.push(`${check.name}.${read.id}: ${String(error)}`); continue; }
        if (read.root === 'run') {
          if (read.source.kind === 'framework') {
            const expected = read.source.artifact === 'task_brief' ? 'task_brief.md' : 'run.json';
            if (read.path !== expected) errors.push(`ARTIFACT_FRAMEWORK_READ_INVALID: reality check ${JSON.stringify(check.name)}.${read.id} must read run:${expected}`);
          } else if (read.source.kind === 'stage') {
            const source = read.source;
            const producer = input.stages.find((stage) => stage.id === source.stage);
            const output = producer?.artifact_contract?.produces.find((artifact) => artifact.id === source.artifact);
            if (!output || output.root !== 'run' || output.path !== read.path || output.when || producer?.condition || producer?.retry_to?.length || producer?.artifact_contract?.groups.some((group) => group.members.includes(output.id))) errors.push(`ARTIFACT_READ_UNREACHABLE: reality check ${JSON.stringify(check.name)}.${read.id} needs an unconditional matching run artifact producer`);
          } else if (!input.runDir || !existsSync(join(input.runDir, read.path))) errors.push(`ARTIFACT_INPUT_ABSENT: reality check ${JSON.stringify(check.name)}.${read.id} requires existing run:${read.path}`);
          continue;
        }
        paths.add(read.path);
        if (read.source.kind === 'stage') {
          const source = read.source;
          const producer = input.stages.find((stage) => stage.id === source.stage);
          const output = producer?.artifact_contract?.produces.find((artifact) => artifact.id === source.artifact);
          if (!output || output.root !== read.root || output.path !== read.path || output.kind !== read.kind || output.when || producer?.condition || producer?.retry_to?.length || producer?.artifact_contract?.groups.some((group) => group.members.includes(output.id))) errors.push(`ARTIFACT_READ_UNREACHABLE: reality check ${JSON.stringify(check.name)}.${read.id} needs an unconditional matching artifact producer`);
        } else if (read.source.kind === 'framework') errors.push(`ARTIFACT_FRAMEWORK_READ_INVALID: reality check ${JSON.stringify(check.name)}.${read.id} framework inputs must use the run root`);
        else if (!existsSync(join(input.projectDir, read.path))) errors.push(`ARTIFACT_INPUT_ABSENT: reality check ${JSON.stringify(check.name)}.${read.id} declares an existing input at ${read.path}`);
      }
      // Handler parameters are typed hard reads; arbitrary script strings are not.
      errors.push(...inspectRealityHandlerReads(check, input.projectDir, input.runDir ?? input.projectDir));
    }
    for (const path of paths) {
      const producers = input.stages.filter((stage) => stage.artifact_contract?.produces.some((artifact) => artifact.root === 'project' && artifact.path === path && !artifact.when && !stage.artifact_contract?.groups.some((group) => group.members.includes(artifact.id))));
      if (postConsumptionManifestPath === path && !existsSync(join(input.projectDir, path))) {
        errors.push(`reality check ${JSON.stringify(check.name)} references post-consumption framework manifest ${path}; the scheduler writes it only after the current round's confirmation gates settle. Use scheduler-injected immutable round evidence for current-round confirmation`);
        continue;
      }
      if (optionalResearchResultPath === path) {
        // Stage reachability cannot make this artifact mandatory: the admitted
        // research protocol lets the same stage emit only the no-candidate
        // sidecar. Hard checks must use the immutable evidence injected by the
        // scheduler instead of assuming which mutable branch the stage took.
        errors.push(`reality check ${JSON.stringify(check.name)} references mutable optional result path ${path}; a valid no-candidate round writes only its sidecar ${path}.no_candidate.json instead and never writes ${path}. Use scheduler-injected immutable round evidence, or declare an unconditional producer for a different artifact`);
        continue;
      }
      if (existsSync(join(input.projectDir, path))) continue;
      if (producers.length === 0) {
        errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but no admitted stage or framework emitter owns it`);
        continue;
      }
      if (terminalPaths.has(path)) {
        // The unified terminal evaluator materializes the finalizer's candidate
        // before running hard checks. Admission still requires the path to have
        // exactly one owner; a mere terminal declaration is not an emitter.
        if (producers.length !== 1) {
          errors.push(`reality check ${JSON.stringify(check.name)} references terminal path ${path}, but it has ${producers.length} admitted owners`);
        }
        continue;
      }
      if (terminalOwners.length > 0) {
        const reachesEveryFinalizer = producers.some((producer) => terminalOwners.every((owner) => (
          producer.id === owner.id || transitivelyDependsOn(owner.id, producer.id, byId)
        )));
        if (!reachesEveryFinalizer) {
          errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but no producer is an ancestor of every terminal owner`);
        }
      } else {
        const mandatoryProducer = producers.some((producer) => (
          !producer.condition?.trim() && (producer.is_gate || !producer.retry_to?.length)
        ));
        if (!mandatoryProducer) {
          errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but every producer is conditional or repair-only`);
        }
      }
    }
  }
  return errors;
}
