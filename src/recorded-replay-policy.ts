/** Offline classification never grants admission or executes recorded work. */
export type ReplayDecision = {status: 'returned'; value: unknown} | {status: 'refused'; error: string};
export type ReplayClassification = 'unchanged' | 'intended' | 'ambiguous_unpredicted';
const key = (value: unknown): string => JSON.stringify(value);

export function classifyDeclarationAdmissionChange(input: {
  baseline: ReplayDecision;
  candidate: ReplayDecision;
  compatibility: ReplayDecision;
  requiredErrors: string[];
}): ReplayClassification {
  if (key(input.baseline) === key(input.candidate)) return 'unchanged';
  if (key(input.baseline) !== key(input.compatibility)
    || input.compatibility.status !== 'returned' || input.candidate.status !== 'returned') return 'ambiguous_unpredicted';
  const before = input.compatibility.value as {errors?: unknown; pass?: unknown};
  const after = input.candidate.value as {errors?: unknown; pass?: unknown};
  if (!before || !after || !Array.isArray(before.errors) || !Array.isArray(after.errors)) return 'ambiguous_unpredicted';
  const expected = {...before, errors: [...before.errors, ...input.requiredErrors].sort(), pass: before.errors.length + input.requiredErrors.length === 0};
  const actual = {...after, errors: [...after.errors].sort()};
  return input.requiredErrors.length > 0 && key(expected) === key(actual) ? 'intended' : 'ambiguous_unpredicted';
}

/** Only undeclared script references are superseded by a format refusal. */
export function classifyRealityDeclarationChange(input: {
  baseline: ReplayDecision;
  candidate: ReplayDecision;
  compatibility: ReplayDecision;
  declaredOnly: ReplayDecision;
  requiredErrors: string[];
}): ReplayClassification {
  if (key(input.baseline) === key(input.candidate)) return 'unchanged';
  if (key(input.baseline) !== key(input.compatibility) || input.declaredOnly.status !== 'returned'
    || input.candidate.status !== 'returned' || !Array.isArray(input.declaredOnly.value) || !Array.isArray(input.candidate.value)) return 'ambiguous_unpredicted';
  const expected = [...input.declaredOnly.value, ...input.requiredErrors].sort();
  return input.requiredErrors.length > 0 && key(expected) === key([...input.candidate.value].sort()) ? 'intended' : 'ambiguous_unpredicted';
}
