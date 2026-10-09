import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ArtifactPathSchema, resolveArtifactLocation, artifactRootContains as contained } from './artifact-location.js';
export { ArtifactPathSchema, resolveArtifactLocation } from './artifact-location.js';
export type { ArtifactLocation } from './artifact-location.js';
import { DeclaredReplaySchema } from './declared-replay.js';
import type { StageStatus } from './store.js';
import { fcGlobalDir, STAGE_STATUS } from './store.js';
import { containsEngineOwnedGlobalPath, engineOwnedGlobalCarriers, isEngineOwnedGlobalPath, isEngineOwnedRunPath, prospectivePhysicalPath } from './engine-owned-carriers.js';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const location = z.object({ root: z.enum(['project', 'run']), path: ArtifactPathSchema });
const when = z.object({
  stage: id,
  field: z.enum(['status', 'exitCode']),
  equals: z.union([z.string(), z.number().int()]),
}).strict();
const produced = location.extend({
  id,
  kind: z.enum(['file', 'directory']).default('file'),
  nonempty: z.boolean().default(true),
  when: when.optional(),
}).strict();
export const ArtifactReadSchema = location.extend({
  id,
  kind: z.enum(['file', 'directory']).default('file'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('stage'), stage: id, artifact: id }).strict(),
    z.object({ kind: z.literal('input') }).strict(),
    z.object({ kind: z.literal('framework'), artifact: z.enum(['task_brief', 'run_state']) }).strict(),
  ]),
  when: when.optional(),
}).strict();
export const RecordedArtifactContractSchema = z.object({
  version: z.literal(1),
  produces: z.array(produced),
  reads: z.array(ArtifactReadSchema),
  replays: z.array(DeclaredReplaySchema).optional(),
  groups: z.array(z.object({ id, mode: z.literal('exactly_one'), members: z.array(id).min(2) }).strict()).default([]),
}).strict().superRefine((contract, context) => {
  const ids = new Set<string>();
  for (const [index, artifact] of [...contract.produces, ...contract.reads].entries()) {
    if (ids.has(artifact.id)) context.addIssue({ code: 'custom', path: ['artifacts', index, 'id'], message: 'artifact IDs must be unique within this stage' });
    ids.add(artifact.id);
  }
  const paths = new Set<string>();
  for (const [index, artifact] of contract.produces.entries()) {
    const path = `${artifact.root}:${artifact.path}`;
    if (paths.has(path)) context.addIssue({ code: 'custom', path: ['produces', index, 'path'], message: 'produced locations must be unique within this stage' });
    paths.add(path);
  }
  const grouped = new Set<string>();
  const groupIds = new Set<string>();
  for (const [index, group] of contract.groups.entries()) {
    if (groupIds.has(group.id)) context.addIssue({ code: 'custom', path: ['groups', index, 'id'], message: 'group IDs must be unique' });
    groupIds.add(group.id);
    for (const member of group.members) {
      const artifact = contract.produces.find((entry) => entry.id === member);
      if (!artifact || artifact.when || grouped.has(member)) context.addIssue({ code: 'custom', path: ['groups', index, 'members'], message: `group member ${member} must name one unconditional produced artifact and occur in only one group` });
      grouped.add(member);
    }
  }
});
// Declarations carry capability/ownership metadata, not an extra verification
// protocol. Historical replay data remains readable and is never executed.
export const ArtifactContractSchema = RecordedArtifactContractSchema;
export type ArtifactContract = z.infer<typeof RecordedArtifactContractSchema>;
export function artifactDeclarationErrors(value: unknown, stageId: string): string[] {
  if (!value) return [`ARTIFACT_DECLARATION_REQUIRED: ${stageId}.artifact_contract: declare output/input locations explicitly`];
  const parsed = ArtifactContractSchema.safeParse(value);
  return parsed.success ? [] : [`ARTIFACT_DECLARATION_INVALID: ${stageId}.artifact_contract: ${parsed.error.message}`];
}
export type ArtifactContractInput = z.input<typeof ArtifactContractSchema>;
export type ArtifactRead = z.infer<typeof ArtifactReadSchema>;

export function artifactActivation(condition: ArtifactContract['produces'][number]['when'], statuses: Record<string, StageStatus>): 'active' | 'inactive' | 'unknown' {
  if (!condition) return 'active';
  const status = statuses[condition.stage];
  if (!status || !([STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, STAGE_STATUS.SKIPPED] as readonly string[]).includes(status.status)) return 'unknown';
  const actual = condition.field === 'status' ? status.status : status.exitCode;
  if (actual === undefined || (condition.field === 'exitCode' && !Number.isInteger(actual))) return 'unknown';
  return actual === condition.equals ? 'active' : 'inactive';
}

export interface ArtifactPlanStage {
  id: string;
  depends_on: string[];
  condition?: string;
  retry_to?: string[];
  is_gate?: boolean;
  artifact_contract?: ArtifactContract;
}


export function producesEngineOwnedArtifact(artifact: ArtifactContract['produces'][number], stage: ArtifactPlanStage, runDirectory?: string, projectDirectory?: string): boolean {
  if (artifact.root === 'run' && isEngineOwnedRunPath(artifact.path, stage)) return true;
  if (!runDirectory || (artifact.root === 'project' && !projectDirectory)) return false;
  const runRoot = realpathSync(runDirectory);
  const root = artifact.root === 'run' ? runRoot : realpathSync(projectDirectory!);
  const output = resolve(root, artifact.path);
  if (artifact.kind === 'directory' && containsEngineOwnedGlobalPath(prospectivePhysicalPath(output), fcGlobalDir())) return true;
  const paths = [output], visitedDirectories = new Set<string>(), outputInodes = new Set<string>();
  while (paths.length) {
    const path = paths.pop()!, target = prospectivePhysicalPath(path);
    if (!contained(root, target)) throw new Error(`ARTIFACT_PATH_ESCAPE: ${artifact.root}:${artifact.path} contains an alias outside its root`);
    if (contained(runRoot, target) && isEngineOwnedRunPath(relative(runRoot, target).split(sep).join('/'), stage)) return true;
    if (isEngineOwnedGlobalPath(target, fcGlobalDir())) return true;
    let entry;
    try { entry = statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (entry?.isFile()) outputInodes.add(`${entry.dev}:${entry.ino}`);
    if (artifact.kind === 'directory' && entry?.isDirectory() && !visitedDirectories.has(target)) {
      visitedDirectories.add(target);
      paths.push(...readdirSync(path).map((name) => join(path, name)));
    }
  }
  const globalCarriers = engineOwnedGlobalCarriers(fcGlobalDir());
  for (const path of globalCarriers) {
    try {
      if (artifact.kind === 'directory' && contained(output, realpathSync(path))) return true;
      const carrier = statSync(path);
      if (outputInodes.has(`${carrier.dev}:${carrier.ino}`)) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Native hardlinks have no path target. Compare all existing declared members
  // against owned inodes, without following directory links in the store walk.
  if (!outputInodes.size) return false;
  const folders = [runRoot];
  while (folders.length) {
    const folder = folders.pop()!;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) folders.push(path);
      if (!isEngineOwnedRunPath(relative(runRoot, path).split(sep).join('/'), stage)) continue;
      try {
        const carrier = statSync(path);
        if (outputInodes.has(`${carrier.dev}:${carrier.ino}`)) return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return false;
}

/** No prompt/script parsing participates in this admission boundary. */
export function inspectArtifactDeclarations(input: {
  stages: ArtifactPlanStage[];
  scopeOwns: (stage: ArtifactPlanStage, path: string) => boolean;
  projectDir?: string;
  runDir?: string;
}): string[] {
  const errors: string[] = [];
  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  function ancestor(stage: ArtifactPlanStage, dependency: string, visited = new Set<string>()): boolean {
    if (visited.has(stage.id)) return false;
    visited.add(stage.id);
    return stage.depends_on.some((id) => id === dependency || (byId.has(id) && ancestor(byId.get(id)!, dependency, visited)));
  }
  for (const stage of input.stages) {
    if (!stage.artifact_contract) {
      errors.push(...artifactDeclarationErrors(undefined, stage.id));
      continue;
    }
    const parsed = RecordedArtifactContractSchema.safeParse(stage.artifact_contract);
    if (!parsed.success) { errors.push(`ARTIFACT_DECLARATION_INVALID: ${stage.id}.artifact_contract: ${parsed.error.message}`); continue; }
    const contract = parsed.data;
    errors.push(...artifactDeclarationErrors(stage.artifact_contract, stage.id));
    if (stage.is_gate && !contract.produces.some((artifact) => artifact.root === 'run' && artifact.path === `verdict_${stage.id}.json`
      && artifact.kind === 'file' && !artifact.when && !contract.groups.some((group) => group.members.includes(artifact.id)))) {
      errors.push(`ARTIFACT_GATE_VERDICT_REQUIRED: ${stage.id}.artifact_contract.produces must declare unconditional file run:verdict_${stage.id}.json`);
    }
    for (const artifact of [...contract.produces, ...contract.reads]) {
      if (artifact.when) {
        if (!ancestor(stage, artifact.when.stage)) errors.push(`ARTIFACT_FACT_UNREACHABLE: ${stage.id}.${artifact.id}.when.stage ${artifact.when.stage} must be a dependency ancestor`);
        if (artifact.when.field === 'status' && !([STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, STAGE_STATUS.SKIPPED] as readonly string[]).includes(String(artifact.when.equals))) errors.push(`ARTIFACT_FACT_INVALID: ${stage.id}.${artifact.id}.when.equals must name a settled stage status`);
        if (artifact.when.field === 'exitCode' && typeof artifact.when.equals !== 'number') errors.push(`ARTIFACT_FACT_INVALID: ${stage.id}.${artifact.id}.when.equals must be an integer exit code`);
      }
      if (input.projectDir && input.runDir) {
        try { resolveArtifactLocation(artifact, input.projectDir, input.runDir); } catch (error) { errors.push(`${stage.id}.${artifact.id}: ${String(error)}`); }
      }
    }
    for (const artifact of contract.produces) {
      if (artifact.root === 'project' && !input.scopeOwns(stage, artifact.path)) errors.push(`ARTIFACT_OUTPUT_OUTSIDE_SCOPE: ${stage.id}.${artifact.id} ${artifact.path} is outside the declared project-write scope`);
      let frameworkOwned = false;
      try { frameworkOwned = producesEngineOwnedArtifact(artifact, stage, input.runDir, input.projectDir); }
      catch (error) { errors.push(`${stage.id}.${artifact.id}: ${String(error)}`); }
      if (frameworkOwned) errors.push(`ARTIFACT_FRAMEWORK_PATH: ${stage.id}.${artifact.id} cannot produce engine-owned or another stage's evidence ${artifact.path}`);
      if (artifact.root === 'run') for (const other of input.stages) {
        if (other.id === stage.id || ancestor(stage, other.id) || ancestor(other, stage.id)) continue;
        if (other.artifact_contract?.produces.some((output) => output.root === 'run' && (output.path === artifact.path || (output.kind === 'directory' && artifact.path.startsWith(`${output.path}/`)) || (artifact.kind === 'directory' && output.path.startsWith(`${artifact.path}/`))))) {
          errors.push(`ARTIFACT_OUTPUT_CONCURRENT_OWNERS: ${stage.id}.${artifact.id} run:${artifact.path} overlaps ${other.id}; declare a dependency ordering before sharing a run output`);
        }
      }
    }
    for (const read of contract.reads) {
      const source = read.source;
      if (source.kind === 'stage') {
        const producer = byId.get(source.stage);
        const output = producer?.artifact_contract?.produces.find((artifact) => artifact.id === source.artifact);
        if (!producer || !output || output.path !== read.path || output.root !== read.root || output.kind !== read.kind) errors.push(`ARTIFACT_READ_UNBOUND: ${stage.id}.${read.id} must name a matching declared producer artifact`);
        else if (!ancestor(stage, producer.id)) errors.push(`ARTIFACT_READ_UNREACHABLE: ${stage.id}.${read.id} producer ${producer.id} must be a dependency ancestor`);
        else if (producer.condition || producer.retry_to?.length
          || (output.when && (!read.when || output.when.stage !== read.when.stage || output.when.field !== read.when.field || output.when.equals !== read.when.equals))
          || producer.artifact_contract?.groups.some((group) => group.members.includes(output.id))) errors.push(`ARTIFACT_READ_CONDITIONAL: ${stage.id}.${read.id} must use the producer's exact when predicate for a conditional output; conditional stages and exactly-one groups require unconditional outcome evidence`);
      } else if (source.kind === 'framework') {
        const path = source.artifact === 'task_brief' ? 'task_brief.md' : 'run.json';
        if (read.root !== 'run' || read.path !== path || read.kind !== 'file') errors.push(`ARTIFACT_FRAMEWORK_READ_INVALID: ${stage.id}.${read.id} must read run:${path}`);
      } else if (input.projectDir && (read.root === 'project' || input.runDir)) {
        try {
          const path = resolveArtifactLocation(read, input.projectDir, input.runDir ?? input.projectDir);
          if (!existsSync(path) || (read.kind === 'file' ? !statSync(path).isFile() : !statSync(path).isDirectory())) errors.push(`ARTIFACT_INPUT_ABSENT: ${stage.id}.${read.id} declares an existing input but ${read.root}:${read.path} is absent or has the wrong kind`);
        } catch (error) { errors.push(`${stage.id}.${read.id}: ${String(error)}`); }
      }
    }
  }
  return errors;
}
