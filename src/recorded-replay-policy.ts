/** Offline classification never grants admission or executes recorded work. */
export type ReplayDecision = {status: 'returned'; value: unknown} | {status: 'refused'; error: string};
export type ReplayClassification = 'unchanged' | 'intended' | 'ambiguous_unpredicted';
const key = (value: unknown): string => JSON.stringify(value);

/** Freeze generated clocks at the producer; recorded timestamps remain data.
 * This synchronous boundary must not enclose asynchronous work. */
export function withRecordedReplayClock<T>(timestamp: number, read: () => T): T {
  const NativeDate = globalThis.Date;
  globalThis.Date = new Proxy(NativeDate, {
    construct: (target, args) => Reflect.construct(target, args.length ? args : [timestamp]),
    apply: () => new NativeDate(timestamp).toString(),
    get: (target, key) => key === 'now' ? () => timestamp : Reflect.get(target, key),
  });
  try { return read(); } finally { globalThis.Date = NativeDate; }
}

/** Only private fixture roots are transient. Never erase recorded time fields. */
export function recordedReplayValue(value: unknown, privateRoot: string): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string'
    ? item.replaceAll(privateRoot, '<owned-root>') : item));
}

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

/** Only undeclared script references are superseded by a format refusal. */
export function classifyRealityDeclarationChange(input: {
  baseline: ReplayDecision;
  candidate: ReplayDecision;
  declaredOnly: ReplayDecision;
  requiredErrors: string[];
}): ReplayClassification {
  if (key(input.baseline) === key(input.candidate)) return 'unchanged';
  if (input.declaredOnly.status !== 'returned'
    || input.candidate.status !== 'returned' || !Array.isArray(input.declaredOnly.value) || !Array.isArray(input.candidate.value)) return 'ambiguous_unpredicted';
  const expected = [...input.declaredOnly.value, ...input.requiredErrors].sort();
  return input.requiredErrors.length > 0 && key(expected) === key([...input.candidate.value].sort()) ? 'intended' : 'ambiguous_unpredicted';
}
