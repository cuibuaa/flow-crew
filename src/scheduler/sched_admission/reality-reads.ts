import { runRecordPath } from '../../run-layout.js';
/** Reachability of explicit reality-check reads and typed handler parameters; script text is never inferred as a read. */
import { type TerminalStatesConfig, type ResearchConfig } from '../../store.js';
import { parseChecksFromMarkdown, type CheckDecl } from '../../reality-gate/index.js';
import { artifactProducerReadError, resolveArtifactLocation } from '../../artifact-declarations.js';
import { existsSync } from 'node:fs';
import { relative, join } from 'node:path';
import { inspectRealityHandlerReads } from '../../reality-gate/declared-reads.js';
import { type StageConfig } from './configuration.js';


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
        const expected = read.source.artifact === 'task_brief' ? input.runDir ? relative(input.runDir, runRecordPath(input.runDir, 'task_brief.md')).split('\\').join('/') : 'engine/task_brief.md' : 'run.json';
        if (read.root !== 'run' || read.path !== expected || read.kind !== 'file') errors.push(`ARTIFACT_FRAMEWORK_READ_INVALID: ${label} must read file run:${expected}`);
      } else if ((read.root === 'run' && !input.runDir) || !existsSync(join(read.root === 'run' ? input.runDir! : input.projectDir, read.path))) {
        errors.push(`ARTIFACT_INPUT_ABSENT: ${label} requires existing ${read.root}:${read.path}`);
      }

    }
    // Handler parameters are typed hard reads; arbitrary script strings are not.
    errors.push(...inspectRealityHandlerReads(check, input.projectDir, input.runDir ?? input.projectDir));
  }
  return errors;
}
