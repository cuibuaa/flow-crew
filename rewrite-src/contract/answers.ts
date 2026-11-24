import { ignoreRetired } from './retirement.mjs';
import { z } from 'zod';
import { idSchema, declaredPathSchema, refSchema, parseValue, type Id, type Ref, type Result } from './brief.js';
import { planSchema, type PlanContext, type PlanRevision, type Stage } from './plan.js';

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
  readonly blocks: null | { readonly criterionIds: readonly Id[]; readonly paths: readonly string[] };
}
/** Report full-brief disposition and context-permitted result ID; schema enforces label presence/membership without interpreting it. */
export interface GateAnswer {
  readonly outcome: GateOutcome; readonly reason: string;
  readonly criteria: Readonly<Record<Id, CriterionAnswer>>; readonly findings: readonly Finding[];
  readonly remainingWork: readonly string[]; readonly result?: Id;
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

const GATE_OUTCOMES: Record<GateOutcome, string> = {
  accepted: 'The change meets every criterion.',
  accepted_blocked: 'The change is accepted with an obstacle the brief explicitly allows.',
  rejected_repairable: 'A criterion fails or a regression exists, and the author can fix it. List each in findings.',
  rejected_irreparable: 'The brief cannot be met by further repair. Say why in reason.',
};

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
  const evidenceText = z.string().min(1).describe('What you ran or read and what it showed. Name the commands, inputs and paths so another reader can repeat it.');
  const pass = z.strictObject({ status: z.literal('pass'), evidence: evidenceText }).describe('The criterion holds.');
  const fail = z.strictObject({ status: z.literal('fail'), evidence: evidenceText }).describe('The criterion does not hold.');
  const pending = z.strictObject({ status: z.literal('not_assessed'), evidence: evidenceText, reason: z.literal('pending_work') })
    .describe('Cannot be judged yet because later work is still pending.');
  const paths = z.array(declaredPathSchema).describe('Literal paths of the files involved.');
  const finding = z.strictObject({
    id: idSchema.describe('A short identifier you choose for this finding.'), paths,
    reason: z.string().min(1).describe('What is wrong and how you showed it.'),
    criterionIds: z.array(criterionId).describe('The criteria this finding affects.'),
    class: z.enum(['criterion_unmet', 'regression', 'advisory'])
      .describe('criterion_unmet: a criterion fails. regression: behaviour that worked before the change now breaks. advisory: worth knowing, does not block.'),
    commandEvidence: refSchema.optional().describe('Omit unless you hold a command evidence reference.'),
  });
  const author = z.strictObject({
    status: z.enum(['delivered', 'blocked', 'environment_gap'])
      .describe('delivered: the stage goal is met in the working copy. blocked: you could not meet it. environment_gap: a resource you are entitled to use is unavailable. Choose from what you observed.'),
    summary: z.string().min(1).describe('What you delivered, or why you could not.'),
    caveats: z.array(z.string()).describe('What you could not verify, and obstacles you met; empty when none.'),
    remainingWork: z.array(z.string()).describe('Work still to do; empty when none.'),
    blocks: z.strictObject({ criterionIds: z.array(criterionId).describe('The criteria the obstacle affects.'), paths }).nullable()
      .describe('null unless status is blocked or environment_gap; then the criteria and literal paths the obstacle affects.'),
  });
  const gateBranch = (outcome: GateOutcome) => {
    const criterion = outcome === 'accepted' ? (context.final ? pass : z.union([pass, pending]))
      : context.final ? z.union([pass, fail]) : z.union([pass, fail, pending]);
    const criteria = z.strictObject(Object.fromEntries(context.criterionIds.map((id) => [id, criterion])))
      .describe('One verdict for each criterion, keyed by criterion id.');
    const accepted = outcome === 'accepted' || outcome === 'accepted_blocked';
    const result = !context.final || !context.resultIds.length ? z.never().optional()
      : (accepted ? member(context.resultIds) : member(context.resultIds).optional()).describe('The brief result label that describes what was delivered.');
    return z.strictObject({
      outcome: z.literal(outcome), reason: z.string().min(1).describe('Why this outcome, with the decisive evidence.'), criteria,
      findings: z.array(finding).describe('Each defect or regression you found; empty when none.'),
      remainingWork: z.array(z.string()).describe('What must still happen before the brief is met; empty when none.'), result,
    }).describe(GATE_OUTCOMES[outcome]);
  };
  const branches = [gateBranch('accepted'), gateBranch('rejected_repairable'), gateBranch('rejected_irreparable')];
  if (context.allowBlocked) branches.push(gateBranch('accepted_blocked'));
  const schema = context.purpose === 'work'
    ? z.strictObject({ kind: z.literal('work'), answer: author })
    : context.purpose === 'gate'
      ? z.strictObject({ kind: z.literal('gate'), answer: z.union(branches) })
      : z.strictObject({ kind: z.literal('plan'), answer: z.strictObject({
        baseRevision: z.literal(context.revision).describe('The current plan revision; it is the only accepted value.'),
        plan: planSchema(context).describe('The pending stages that achieve the whole brief.'),
      }) });
  return { json: z.toJSONSchema(schema), parse: (value) => parseValue<StageAnswer>(schema, ignoreRetired(value, 'stageAnswer')) };
}
