import { ignoreRetired } from './retirement.mjs';
import { z } from 'zod';
import { idSchema, parseValue, type Immutable, type Hash, type Id, type Ref, type Result } from './brief.js';

/** Supply finite admissible role/command/checkpoint/settled IDs; membership conveys no scheduling or acceptance decision. */
export interface PlanContext {
  readonly commandIds: readonly Id[];
  readonly checkpointIds: readonly Id[];
  readonly roleIds: readonly Id[];
  readonly settledStageIds?: readonly Id[];
}
const workStage = z.strictObject({
  id: idSchema.describe('A stage id you choose; unique across the plan.'), role: idSchema.describe('The role that runs this stage.'),
  purpose: z.literal('work').describe('work: an author changes the working copy.'),
  after: z.array(idSchema).describe('Ids of the stages whose results this stage needs first; real prerequisites only.'),
  commands: z.array(idSchema).optional().describe('Declared commands to run before this stage.'),
  instruction: z.string().min(1).describe('The goal of this stage, as an outcome.'),
  baseCheckpoint: idSchema.optional().describe('A safe checkpoint to start from; omit to continue from the current working copy.'),
});
const gateStage = workStage.omit({ instruction: true }).extend({
  purpose: z.literal('gate').describe('gate: an independent reviewer judges the work.'), commands: z.array(idSchema)
    .describe('Declared commands whose results the reviewer receives.'),
  repair: z.strictObject({ stage: idSchema.describe('The work or plan stage that runs again when this gate rejects repairably.'),
    returnsTo: idSchema.describe("This gate's own id: the repair returns to it.") }).optional()
    .describe('Where a repairable rejection sends the run.'),
});
const plannerStage = workStage.extend({ purpose: z.literal('plan').describe('plan: a planner proposes the next stages.') });
/** Declare one work/gate/plan node, dependencies and explicit repair route; only work and plan stages carry an instruction, and stage names never define policy. */
export type Stage = Immutable<z.infer<typeof workStage> | z.infer<typeof gateStage> | z.infer<typeof plannerStage>>;
/** Carry a proposed pending DAG; syntax validation and executable admission remain separate owners. */
export interface Plan { readonly stages: readonly Stage[] }
/** Bind an admitted graph revision to its digest and immutable executed evidence; cannot roll history back. */
export interface AdmittedPlan {
  readonly revision: Id; readonly plan: Plan; readonly digest: Hash; readonly executed: readonly Ref[];
}
/** Propose a pending suffix against an exact base revision; core refuses stale bases and executed-history changes. */
export interface PlanRevision { readonly baseRevision: Id; readonly plan: Plan }

/** Build the shared graph/membership schema; refuses graph violations while leaving frontier and delivery topology to core. */
export function planSchema(context: PlanContext) {
  for (const ids of [context.commandIds, context.checkpointIds, context.roleIds, context.settledStageIds ?? []])
    if (new Set(ids).size !== ids.length || ids.some((id) => !idSchema.safeParse(id).success))
      throw new Error('Invalid plan context identity set');
  // The one membership check. It stays an enum so the planner's JSON schema lists the admissible ids; the refusal names the id that is missing.
  const member = (kind: string, ids: readonly Id[]) => {
    const error = (issue: { input?: unknown }) => `Unknown ${kind} id ${String(issue.input)}; admissible ${kind} ids: ${ids.join(', ') || 'none'}`;
    return ids.length ? z.enum(ids, { error }) : z.never({ error });
  };
  const common = {
    commands: z.array(member('command', context.commandIds)).optional().describe('Declared commands to run before this stage.'),
    role: member('role', context.roleIds).describe('The role that runs this stage.'),
    baseCheckpoint: member('checkpoint', context.checkpointIds).optional().describe('A safe checkpoint to start from; omit to continue from the current working copy.'),
  };
  const stage = z.discriminatedUnion('purpose', [
    workStage.extend(common), gateStage.extend({ ...common,
      commands: z.array(member('command', context.commandIds)).describe('Declared commands whose results the reviewer receives.') }),
    plannerStage.extend(common),
  ]);
  return z.strictObject({ stages: z.array(stage).min(1).describe('The stages, each with the stage ids it needs first.') }).superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = plan.stages.map((v) => v.id);
    if (new Set(ids).size !== ids.length) fail(`Duplicate stage id: ${ids.join(', ')}`);
    const settled = new Set(context.settledStageIds ?? []);
    if (ids.some((id) => settled.has(id))) fail(`Pending suffix redefines settled stage: ${ids.filter(id => settled.has(id)).join(', ')}`);
    const stages = new Map(plan.stages.map((v) => [v.id, v]));
    for (const stage of plan.stages) {
      for (const [label, values] of [['dependency', stage.after],
        ['command', stage.commands ?? []]] as const)
        if (new Set(values).size !== values.length) fail(`Duplicate ${label} in stage ${stage.id}: ${values.join(', ')}`);
      for (const predecessor of stage.after) if (!stages.has(predecessor) && !settled.has(predecessor)) fail(`Unknown dependency ${predecessor} in stage ${stage.id}`);
    }
    const visiting = new Set<Id>();
    const visited = new Set<Id>();
    function visit(id: Id): void {
      if (visiting.has(id)) { fail(`Dependency cycle at stage ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const parent of stages.get(id)?.after ?? []) visit(parent);
      visiting.delete(id); visited.add(id);
    }
    for (const id of ids) visit(id);
    function dependsOn(id: Id, ancestor: Id, seen = new Set<Id>()): boolean {
      if (id === ancestor) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (stages.get(id)?.after ?? []).some((parent) => dependsOn(parent, ancestor, seen));
    }
    for (const stage of plan.stages) if (stage.purpose === 'gate' && stage.repair) {
      const target = stages.get(stage.repair.stage);
      if ((!target && !settled.has(stage.repair.stage)) || target?.purpose === 'gate') fail(`Repair target must be work or plan: gate ${stage.id}, target ${stage.repair.stage}, returnsTo ${stage.repair.returnsTo}`);
      if (stage.repair.returnsTo !== stage.id) fail(`Repair must return to its rejecting gate: gate ${stage.id}, target ${stage.repair.stage}, returnsTo ${stage.repair.returnsTo}`);
      if (target && dependsOn(target.id, stage.id)) fail(`Repair cannot depend on acceptance of its rejecting gate: gate ${stage.id}, target ${stage.repair.stage}, returnsTo ${stage.repair.returnsTo}`);
    }
  });
}
/** Parse one graph using finite context without choosing executable work. */
export function parsePlan(value: unknown, context: PlanContext): Result<Plan> {
  return parseValue(planSchema(context), ignoreRetired(value, 'plan'));
}
