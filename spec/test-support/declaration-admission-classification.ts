/** Offline comparison helper; it never grants admission. */
type ReplayDecision = {status: 'returned'; value: unknown} | {status: 'refused'; error: string};
type ReplayClassification = 'unchanged' | 'intended' | 'ambiguous_unpredicted';
const key = (value: unknown): string => JSON.stringify(value);

export function classifyDeclarationAdmissionChange(input: {
  baseline: ReplayDecision;
  candidate: ReplayDecision;
  requiredErrors: string[];
}): ReplayClassification {
  if (key(input.baseline) === key(input.candidate)) return 'unchanged';
  if (input.baseline.status !== 'returned' || input.candidate.status !== 'returned') return 'ambiguous_unpredicted';
  const before = input.baseline.value as {errors?: unknown; pass?: unknown};
  const after = input.candidate.value as {errors?: unknown; pass?: unknown};
  if (!before || !after || !Array.isArray(before.errors) || !Array.isArray(after.errors)) return 'ambiguous_unpredicted';
  const expected = {...before, errors: [...before.errors, ...input.requiredErrors].sort(), pass: before.errors.length + input.requiredErrors.length === 0};
  const actual = {...after, errors: [...after.errors].sort()};
  return input.requiredErrors.length > 0 && key(expected) === key(actual) ? 'intended' : 'ambiguous_unpredicted';
}
