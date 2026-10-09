import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArtifactContractSchema, ArtifactPathSchema } from './artifact-declarations.js';
import type { StageConfig } from './scheduler.js';

export const AuditFindingsSchema = z.object({
  version: z.literal(1),
  findings: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    paths: z.array(ArtifactPathSchema).min(1),
    reason: z.string().trim().min(1),
    criterion_ids: z.array(z.string().min(1)),
    invalidates_plan: z.boolean(),
    repair_role: z.string().min(1),
  }).strict()),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    if (ids.has(finding.id) || new Set(finding.paths).size !== finding.paths.length) context.addIssue({ code: 'custom', path: ['findings', index], message: 'finding IDs and paths must be unique' });
    ids.add(finding.id);
  }
});
export type AuditFinding = z.infer<typeof AuditFindingsSchema>['findings'][number];

/** Only exact project files; generated repairs receive no broader scope than the named finding. */
export function buildScopedRepair(gate: StageConfig, finding: AuditFinding, producers: readonly StageConfig[] = [], binding?: {
  evidencePath: string; verdictDigest: string; attemptIndex: number; attemptStartedAt: string;
}): StageConfig {
  if (finding.invalidates_plan) throw new Error('SCOPED_REPAIR_PLAN_LEVEL: finding requires planning, not a local repair');
  if (finding.criterion_ids.some((id) => !gate.criterion_refs.includes(id))) throw new Error('SCOPED_REPAIR_CRITERION_UNBOUND: finding criteria must belong to the authoring gate');
  // Keep admitted producers intact. The repair inherits their checks and inputs,
  // writes only named files, and reads other outputs from their existing owners.
  // Deleting the fixed scope alone loses these duties; copying whole output trees
  // would widen the repair. Conditional/group duties cannot be narrowed safely.
  const duties = [...new Map([...producers, gate].map((stage) => [stage.id, stage])).values()];
  const contract: z.input<typeof ArtifactContractSchema> = { version: 1, produces: [], reads: [], replays: [], groups: [] };
  for (const [index, stage] of duties.entries()) {
    const original = ArtifactContractSchema.parse(stage.artifact_contract);
    if (stage.condition || original.groups.length || original.produces.some((artifact) => artifact.when)) {
      throw new Error(`SCOPED_REPAIR_CONDITIONAL_DUTY: ${stage.id} requires a complete conditional/group outcome repair, not a narrowed file repair`);
    }
    const ids = new Map<string, string>();
    for (const [number, artifact] of [...original.produces, ...original.reads].entries()) ids.set(artifact.id, `d${index}_a${number}`);
    for (const artifact of original.produces) {
      const id = ids.get(artifact.id)!;
      if (artifact.root === 'project' && finding.paths.includes(artifact.path)) {
        if (!contract.produces.some((entry) => entry.path === artifact.path)) contract.produces.push({ ...artifact, id });
        else contract.reads.push({ root: artifact.root, path: artifact.path, kind: artifact.kind, id, source: { kind: 'stage', stage: stage.id, artifact: artifact.id } });
      } else contract.reads.push({ root: artifact.root, path: artifact.path, kind: artifact.kind, id, source: { kind: 'stage', stage: stage.id, artifact: artifact.id } });
    }
    contract.reads.push(...original.reads.map((read) => ({ ...read, id: ids.get(read.id)! })));
    contract.replays!.push(...original.replays.map((replay, number) => ({ ...replay, id: `d${index}_r${number}`, targets: replay.targets.map((target) => ids.get(target)!), expected: { ...replay.expected, failures: replay.expected.failures.map((failure) => ({ ...failure, artifact: ids.get(failure.artifact)! })) } })));
  }
  for (const [index, path] of finding.paths.entries()) if (!contract.produces.some((artifact) => artifact.path === path)) contract.produces.push({ id: `repaired_${index}`, root: 'project', path });
  if (binding) contract.reads.push({ id: 'rejected_verdict', root: 'run', path: binding.evidencePath, source: { kind: 'input' } });
  const digest = createHash('sha256').update(JSON.stringify({ gate: gate.id, finding, contract, binding })).digest('hex');
  return {
    id: `repair_${digest.slice(0, 13)}`, role: finding.repair_role,
    scope: [...finding.paths], depends_on: [gate.id], dependency_reasons: { [gate.id]: `Repair scoped finding ${finding.id} from this gate` },
    prompt_template: `Repair audit finding ${finding.id} only within these project files: ${JSON.stringify(finding.paths)}.\nReason: ${finding.reason}\nRead the retained rejected verdict and audit evidence for ${gate.id}${binding ? ` at run:${binding.evidencePath} (sha256 ${binding.verdictDigest}, execution ${binding.attemptIndex} started ${binding.attemptStartedAt})` : ''}. Produce fresh corrected files, run the inherited declared checks, and return to that gate. Do not broaden the task or write outside the declared scope.`,
    skills: [], criterion_refs: [...finding.criterion_ids], is_gate: false, dynamic_dispatch: false, retry_to: [gate.id],
    artifact_contract: ArtifactContractSchema.parse(contract),
  };
}
