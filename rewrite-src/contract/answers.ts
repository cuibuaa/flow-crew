import { z } from 'zod';
import { idSchema, declaredPathSchema, refSchema, parseValue, type Id, type Ref, type Result } from './brief.js';
import { planSchema, commandRelationSchema, type CommandRelation, type PlanContext, type PlanRevision, type Stage } from './plan.js';

/** Name the four reviewer dispositions; core routes them without reclassifying narrative evidence. */
export type GateOutcome = 'accepted' | 'accepted_blocked' | 'rejected_repairable' | 'rejected_irreparable';
/** Carry pass/fail evidence or intermediate pending_work; final context refuses pending rather than inferring completion. */
export type CriterionAnswer = { readonly status: 'pass' | 'fail'; readonly evidence: string }
  | { readonly status: 'not_assessed'; readonly evidence: string; readonly reason: 'pending_work' };
/** Bind independent review evidence to canonical criteria and literal paths; findings never create a second routing channel. */
export interface Finding {
  readonly id: Id; readonly paths: readonly string[]; readonly reason: string;
  readonly criterionIds: readonly Id[]; readonly class: 'criterion_unmet' | 'regression' | 'advisory';
  readonly commandEvidence?: Ref;
}
/** Report work delivery or declared obstacles; author claims cannot override the independent gate. */
export interface AuthorAnswer {
  readonly status: 'delivered' | 'blocked' | 'environment_gap'; readonly summary: string;
  readonly caveats: readonly string[]; readonly remainingWork: readonly string[];
  readonly observations?: readonly CommandRelation[];
  readonly blocks: null | { readonly criterionIds: readonly Id[]; readonly paths: readonly string[] };
}
/** Report full-brief disposition and context-permitted result ID; schema enforces label presence/membership without interpreting it. */
export interface GateAnswer {
  readonly outcome: GateOutcome; readonly reason: string;
  readonly criteria: Readonly<Record<Id, CriterionAnswer>>; readonly findings: readonly Finding[];
  readonly remainingWork: readonly string[]; readonly result?: Id;
  readonly commandEvidence?: readonly { readonly command: Id; readonly context: string; readonly executions: readonly string[] }[];
}
/** Return an exact-base pending graph proposal; admission alone may commit it after settlement. */
export type PlanAnswer = PlanRevision;
/** Bind a typed answer to work/gate/plan purpose; no separate choice or prose-routing envelope exists. */
export type StageAnswer = { readonly kind: 'work'; readonly answer: AuthorAnswer }
  | { readonly kind: 'gate'; readonly answer: GateAnswer }
  | { readonly kind: 'plan'; readonly answer: PlanAnswer };
/** Supply engine-owned finite identities and topology-derived final scope; answer text cannot change this context. */
export interface AnswerContext extends PlanContext {
  readonly purpose: Stage['purpose']; readonly criterionIds: readonly Id[];
  readonly resultIds: readonly Id[]; readonly allowBlocked: boolean;
  readonly final: boolean; readonly revision: Id;
}
/** Expose one generated JSON schema and receiving parser; parsing returns invalid rather than making a product verdict. */
export interface AnswerSchema {
  readonly json: z.core.JSONSchema.JSONSchema;
  parse(value: unknown): Result<StageAnswer>;
}

/** Build one purpose/scope-bound generation and receiving grammar; bad context throws, bad answers return invalid, labels stay opaque. */
export function answerSchema(context: AnswerContext): AnswerSchema {
  // Context is engine-owned. Refuse ambiguous or noncanonical contexts before generation.
  for (const ids of [context.criterionIds, context.commandIds, context.resultIds, context.checkpointIds, context.roleIds, context.settledStageIds ?? []]) {
    if (new Set(ids).size !== ids.length || ids.some((id) => !idSchema.safeParse(id).success))
      throw new Error('Invalid answer context identity set');
  }
  if (!context.criterionIds.length || !idSchema.safeParse(context.revision).success)
    throw new Error('Missing criterion or revision context');
  const member = (ids: readonly Id[]) => ids.length ? z.enum(ids) : z.never();
  const criterionId = member(context.criterionIds);
  const pass = z.strictObject({ status: z.literal('pass'), evidence: z.string().min(1) });
  const fail = z.strictObject({ status: z.literal('fail'), evidence: z.string().min(1) });
  const pending = z.strictObject({ status: z.literal('not_assessed'), evidence: z.string().min(1), reason: z.literal('pending_work') });
  const paths = z.array(declaredPathSchema);
  const finding = z.strictObject({
    id: idSchema, paths, reason: z.string().min(1), criterionIds: z.array(criterionId),
    class: z.enum(['criterion_unmet', 'regression', 'advisory']), commandEvidence: refSchema.optional(),
  });
  const author = z.strictObject({
    status: z.enum(['delivered', 'blocked', 'environment_gap']), summary: z.string().min(1),
    observations: z.array(commandRelationSchema).optional(), caveats: z.array(z.string()), remainingWork: z.array(z.string()),
    blocks: z.strictObject({ criterionIds: z.array(criterionId), paths }).nullable(),
  });
  const gateBranch = (outcome: GateOutcome) => {
    const criterion = outcome === 'accepted' ? (context.final ? pass : z.union([pass, pending]))
      : context.final ? z.union([pass, fail]) : z.union([pass, fail, pending]);
    const criteria = z.strictObject(Object.fromEntries(context.criterionIds.map((id) => [id, criterion])));
    const accepted = outcome === 'accepted' || outcome === 'accepted_blocked';
    const result = !context.final || !context.resultIds.length ? z.never().optional()
      : accepted ? member(context.resultIds) : member(context.resultIds).optional();
    return z.strictObject({
      outcome: z.literal(outcome), reason: z.string().min(1), criteria,
      commandEvidence: (context.commandIds.length ? z.array(z.strictObject({ command: member(context.commandIds), context: z.string(), executions: z.array(z.string()) })) : z.array(z.never())).optional(),
      findings: z.array(finding), remainingWork: z.array(z.string()), result,
    });
  };
  const branches = [gateBranch('accepted'), gateBranch('rejected_repairable'), gateBranch('rejected_irreparable')];
  if (context.allowBlocked) branches.push(gateBranch('accepted_blocked'));
  const schema = context.purpose === 'work'
    ? z.strictObject({ kind: z.literal('work'), answer: author })
    : context.purpose === 'gate'
      ? z.strictObject({ kind: z.literal('gate'), answer: z.union(branches) })
      : z.strictObject({ kind: z.literal('plan'), answer: z.strictObject({
        baseRevision: z.literal(context.revision), plan: planSchema(context),
      }) });
  return { json: z.toJSONSchema(schema), parse: (value) => parseValue<StageAnswer>(schema, value) };
}
