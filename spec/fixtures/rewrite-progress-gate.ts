import type { AnswerContext, StageAnswer } from '../../dist-rewrite/contract/answers.js';
import type { Plan, PlanContext } from '../../dist-rewrite/contract/plan.js';
// Authored interface fixture, not a historical observation. Array order is deliberately non-topological.
export const progressPlan = {
  stages: [
    { id: 'delivery_gate', purpose: 'gate', role: 'reviewer', after: ['delivery_work'], 
     commands: ['verify'], repair: { stage: 'repair', returnsTo: 'delivery_gate' } },
    { id: 'first_work', purpose: 'work', role: 'author', after: [], instruction: 'Implement the first milestone.', },
    { id: 'progress_gate', purpose: 'gate', role: 'reviewer', after: ['first_work'],
      commands: [] },
    { id: 'delivery_work', purpose: 'work', role: 'author', after: ['progress_gate'], instruction: 'Finish the remaining delivery.', },
    { id: 'repair', purpose: 'work', role: 'author', after: [], instruction: 'Repair the final review findings.', },
  ],
} as const satisfies Plan;
export const progressContext = {
  roleIds: ['author', 'reviewer'], commandIds: ['verify'], checkpointIds: [],
} as const satisfies PlanContext;
export const progressAnswerContext = {
  ...progressContext, purpose: 'gate', criterionIds: ['present', 'later'], resultIds: ['delivered'],
  allowBlocked: false, final: false, revision: 'revision_a',
} as const satisfies AnswerContext;
export const progressAnswer = {
  kind: 'gate', answer: {
    outcome: 'accepted', reason: 'The present milestone is reviewed; declared later work remains.',
    criteria: {
      present: { status: 'pass', evidence: 'The current checkpoint provides the first component.' },
      later: { status: 'not_assessed', reason: 'pending_work', evidence: 'The delivery work has not run.' },
    }, findings: [], remainingWork: ['Complete the later criterion.'],
  },
} as const satisfies StageAnswer;
