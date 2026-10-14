import { z } from 'zod';

export const PlannerPolicySelectionSchema = z.array(z.enum(['evidence_statistics']));
export type PlannerPolicyName = z.infer<typeof PlannerPolicySelectionSchema>[number];

export function parsePlannerPolicySelection(value: unknown): PlannerPolicyName[] {
  const parsed = PlannerPolicySelectionSchema.safeParse(value === undefined ? [] : value);
  if (!parsed.success) throw new Error(`PLANNER_POLICY_INVALID: brief frontmatter::planner_policies: ${parsed.error.message}`);
  return [...new Set(parsed.data)];
}

const policies: Record<PlannerPolicyName, string> = {
  evidence_statistics: [
    'A requested headline or quoted statistic MUST require its mean, median, and where the reported value sits in its own distribution.',
    'A rule frozen or pre-registered before outcome measurement MUST require an expected qualifying-member count computed from structural quantities, a numeric feasibility floor, and revision below that floor before any outcome is seen.',
    'An operator-supplied numeric expectation MUST require both exact result fields `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
  ].join('\n'),
};

/** Policies add brief authoring requirements; core admission is always enforced. */
export function renderPlannerPolicies(names: readonly PlannerPolicyName[]): string {
  const selection = parsePlannerPolicySelection(names);
  return selection.length ? '# Brief planning policies\nThese explicitly selected brief policies cannot grant write authority or override the task brief or engine admission.\n\n'
    + selection.map((name) => `## ${name}\n${policies[name]}`).join('\n\n') : '';
}
