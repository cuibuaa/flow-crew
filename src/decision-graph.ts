/** One bounded routing interface. Prose judgments belong to schema-constrained models. */
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { validate } from './reality-gate/checks/json-schema-match.js';
import type { StageConfig } from './scheduler/sched_admission/configuration.js';

const text: Schema = { type: 'string', minLength: 1, pattern: '\\S' };
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function decisionSchema(stage: StageConfig): Schema {
  const properties: Record<string, Schema> = { successor: { type: 'string', enum: stage.decision!.successors }, reason: text };
  return object(properties);
}
export interface DecisionRecord {
  declaredSuccessors?: string[]; requestedSuccessor?: string; planRevision?: number;
  /** Effective engine judgment, independent of the authored verdict or route. */
  gateAccepted?: boolean;
  key: string; stageId: string; iteration: number; successor?: string; reason: string;
  outcome: 'chosen' | 'defaulted' | 'refused';
  /** Archived chooser assumptions, retained for read-only summaries. */
  assumptions?: string[];
  /** Archived assessment suggestions, retained for read-only history. */
  risk_areas?: Array<{ file: string; risk: string; experiment: string }>;
}
export interface DecisionGraphState {
  maxVisits?: number;
  records: DecisionRecord[];
  enabled: Record<string, string>;
  visits: Record<string, number>;
  replan?: { stageId: string; reason: string };
}
export function emptyDecisionGraph(): DecisionGraphState { return { records: [], enabled: {}, visits: {} }; }

/** No model text repair or prose interpretation: JSON and closed-schema checks only. */
export function validateDecision(stage: StageConfig, raw: string): {
  successor: string; reason: string; outcome: DecisionRecord['outcome']; requestedSuccessor?: string;
} {
  const declaration = stage.decision!;
  let value: Record<string, unknown> | undefined;
  const errors: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    errors.push(...validate(parsed, decisionSchema(stage), '$'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { errors.push('Output must be one JSON document matching the decision schema.'); }
  const outside = typeof value?.successor === 'string' && !declaration.successors.includes(value.successor);
  if (errors.length) {
    const reason = errors.join('; ');
    return { successor: declaration.default, reason, ...(typeof value?.successor === 'string' ? { requestedSuccessor: value.successor } : {}), outcome: outside ? 'refused' : 'defaulted' };
  }
  return { successor: value!.successor as string, reason: value!.reason as string,
    outcome: 'chosen' };
}
