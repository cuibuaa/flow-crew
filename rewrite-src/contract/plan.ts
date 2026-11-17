import { z } from 'zod';
import { idSchema, declaredPathSchema, parseValue, type Immutable, type Hash, type Id, type Ref, type Result } from './brief.js';

/** Supply finite admissible role/command/checkpoint/settled IDs; membership conveys no scheduling or acceptance decision. */
export interface PlanContext {
  readonly commandIds: readonly Id[];
  readonly checkpointIds: readonly Id[];
  readonly roleIds: readonly Id[];
  readonly settledStageIds?: readonly Id[];
}
/** Proposed semantic observations, checked by independent review against complete command evidence. */
export const commandRelationSchema = z.strictObject({ command: idSchema, criterionIds: z.array(idSchema).min(1),
  sources: z.array(declaredPathSchema), products: z.array(declaredPathSchema) });
export type CommandRelation = Immutable<z.infer<typeof commandRelationSchema>>;
const workStage = z.strictObject({
  id: idSchema, role: idSchema, purpose: z.literal('work'), after: z.array(idSchema),
  commands: z.array(idSchema).optional(), instruction: z.string().min(1), skills: z.array(idSchema), baseCheckpoint: idSchema.optional(),
});
const gateStage = workStage.extend({
  purpose: z.literal('gate'), commands: z.array(idSchema),
  repair: z.strictObject({ stage: idSchema, returnsTo: idSchema }).optional(),
});
const plannerStage = workStage.extend({ purpose: z.literal('plan') });
/** Declare one work/gate/plan node, dependencies and explicit repair route; stage names never define policy. */
export type Stage = Immutable<z.infer<typeof workStage> | z.infer<typeof gateStage> | z.infer<typeof plannerStage>>;
/** Carry a proposed pending DAG; syntax validation and executable admission remain separate owners. */
export interface Plan { readonly stages: readonly Stage[]; readonly observations?: readonly CommandRelation[] }
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
  const member = (ids: readonly Id[]) => ids.length ? z.enum(ids) : z.never();
  const common = {
    commands: z.array(member(context.commandIds)).optional(), role: member(context.roleIds), baseCheckpoint: member(context.checkpointIds).optional(),
  };
  const stage = z.discriminatedUnion('purpose', [
    workStage.extend(common), gateStage.extend({ ...common, commands: z.array(member(context.commandIds)) }),
    plannerStage.extend(common),
  ]);
  return z.strictObject({ stages: z.array(stage).min(1), observations: z.array(commandRelationSchema).optional() }).superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = plan.stages.map((v) => v.id);
    if (new Set(ids).size !== ids.length) fail('Duplicate stage id');
    const settled = new Set(context.settledStageIds ?? []);
    if (ids.some((id) => settled.has(id))) fail('Pending suffix redefines settled stage');
    const stages = new Map(plan.stages.map((v) => [v.id, v]));
    for (const stage of plan.stages) {
      for (const [label, values] of [['dependency', stage.after], ['skill', stage.skills],
        ['command', stage.commands ?? []]] as const)
        if (new Set(values).size !== values.length) fail(`Duplicate ${label}`);
      for (const predecessor of stage.after) if (!stages.has(predecessor) && !settled.has(predecessor)) fail('Unknown dependency');
    }
    const visiting = new Set<Id>();
    const visited = new Set<Id>();
    function visit(id: Id): void {
      if (visiting.has(id)) { fail('Dependency cycle'); return; }
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
      if ((!target && !settled.has(stage.repair.stage)) || target?.purpose === 'gate') fail('Repair target must be work or plan');
      if (stage.repair.returnsTo !== stage.id) fail('Repair must return to its rejecting gate');
      if (target && dependsOn(target.id, stage.id)) fail('Repair cannot depend on acceptance of its rejecting gate');
    }
  });
}
/** Parse one graph using finite context; returns invalid for syntax/reference violations without choosing executable work. */
export function parsePlan(value: unknown, context: PlanContext): Result<Plan> {
  return parseValue(planSchema(context), value);
}
