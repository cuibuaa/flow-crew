import { isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';

/** Normal form for a declared structured reporter. No log spelling or model
 * inference has identity authority. */
export const FailureReadingSchema = z.object({
  version: z.literal(1),
  testsRun: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
  failures: z.array(z.object({
    testId: z.string().min(1).max(1024),
    file: z.string().min(1).max(1024).nullable(),
    messageClass: z.string().min(1).max(256),
  }).strict()).max(1000),
}).strict();

export type FailureReading = z.infer<typeof FailureReadingSchema>;
export interface IdentityFacts {
  totals?: { tests: number; passed: number; failed: number; pending: number | null; todo: number | null; files: number };
  failureFiles?: string[];
  count?: number;
  testsRun?: number;
  identifiers: string[];
  failures?: FailureReading['failures'];
  evidence?: 'complete' | 'partial';
  owner: 'runner-json' | 'unknown';
  reason?: string;
}

// Native JSON decoding, followed by the runner's structured contract. Free-text
// failureMessages, durations, locations and stack traces never enter identity.
const RUNNER_FAILURE_STATUS = 'failed';
const VitestReport = z.object({
  // A producer's exhaustive-population declaration, like a model reading's
  // complete flag. Bare Vitest JSON omits global unhandled errors.
  complete: z.boolean().optional(),
  numTotalTests: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(),
  numPassedTests: z.number().int().nonnegative(),
  numFailedTestSuites: z.number().int().nonnegative().optional(),
  numTotalTestSuites: z.number().int().nonnegative().optional(),
  numPassedTestSuites: z.number().int().nonnegative().optional(),
  numPendingTestSuites: z.number().int().nonnegative().optional(),
  numPendingTests: z.number().int().nonnegative().optional(), numTodoTests: z.number().int().nonnegative().optional(),
  startTime: z.number().optional(), success: z.boolean().optional(), coverageMap: z.unknown().optional(),
  snapshot: z.object({ failure: z.boolean().optional(), added: z.unknown().optional(), didUpdate: z.unknown().optional(),
    filesAdded: z.unknown().optional(), filesRemoved: z.unknown().optional(), filesRemovedList: z.unknown().optional(),
    filesUnmatched: z.unknown().optional(), filesUpdated: z.unknown().optional(), matched: z.unknown().optional(),
    total: z.unknown().optional(), unchecked: z.unknown().optional(), uncheckedKeysByFile: z.unknown().optional(),
    unmatched: z.unknown().optional(), updated: z.unknown().optional() }).strict().optional(),
  testResults: z.array(z.object({
    name: z.string(), status: z.enum(['passed', 'failed']).optional(), message: z.string().optional(),
    startTime: z.number().optional(), endTime: z.number().optional(),
    assertionResults: z.array(z.object({
      fullName: z.string().min(1).optional(), ancestorTitles: z.array(z.string()).optional(),
      status: z.enum(['passed', 'failed', 'pending', 'todo', 'skipped', 'disabled']),
      title: z.string().optional(), meta: z.unknown().optional(), tags: z.array(z.string()).optional(),
      duration: z.number().nullable().optional(), failureMessages: z.array(z.string()).nullable().optional(),
      location: z.object({ line: z.number(), column: z.number() }).optional(),
    }).strict().refine(test => test.status !== RUNNER_FAILURE_STATUS || test.fullName !== undefined, 'Failed assertion identity is missing')),
  }).strict()),
}).strict();

export function decodeRunnerReport(bytes: string, format: 'vitest-json', projectDir: string, failed?: boolean): FailureReading & { files: string[]; totals: NonNullable<IdentityFacts['totals']> } {
  if (format !== 'vitest-json') throw new Error('Unsupported structured reporter');
  const report = VitestReport.parse(JSON.parse(bytes));
  if (failed !== undefined && report.success !== undefined && report.success === failed) {
    throw new Error('Structured reporter success contradicts the command exit');
  }
  const assertions = report.testResults.flatMap(suite => suite.assertionResults.map(test => ({ suite, test })));
  let canonicalRoot = projectDir;
  try { canonicalRoot = realpathSync(projectDir); } catch { /* in-memory reporter fixtures */ }
  const fileIdentity = (name: string) => (isAbsolute(name) ? relative(canonicalRoot, name) : name).split(sep).join('/');
  const files = [...new Set(report.testResults.filter(suite => suite.status === RUNNER_FAILURE_STATUS
    || suite.assertionResults.some(test => test.status === RUNNER_FAILURE_STATUS)).map(suite => fileIdentity(suite.name)))];
  const failures = assertions.filter(({ test }) => test.status === RUNNER_FAILURE_STATUS).map(({ suite, test }) => ({
    testId: test.fullName!,
    // Vitest emits absolute suite names. Removing the supplied checkout prefix
    // is path relativity on a structured field, never test-output normalization.
    file: fileIdentity(suite.name),
    messageClass: 'test-failure',
  }));
  if (assertions.length !== report.numTotalTests || failures.length !== report.numFailedTests
    || assertions.filter(({ test }) => test.status === 'passed').length !== report.numPassedTests) {
    throw new Error('Structured reporter counts disagree');
  }
  // Vitest's file message carries a suite/hook error, not an assertion identity.
  // Its suite counter also includes nested describes, whose structured ancestry
  // lets us check that no failed suite disappeared. Never read message spelling.
  const accountedSuites = new Set<string>();
  for (const { suite, test } of assertions.filter(({ test }) => test.status === RUNNER_FAILURE_STATUS)) {
    const ancestry = test.ancestorTitles ?? [];
    for (let depth = 0; depth <= ancestry.length; depth++) accountedSuites.add(JSON.stringify([suite.name, ...ancestry.slice(0, depth)]));
  }
  const complete = report.complete === true && !report.snapshot?.failure
    && report.testResults.every(suite => !suite.message?.length
      && (suite.status !== RUNNER_FAILURE_STATUS || suite.assertionResults.some(test => test.status === RUNNER_FAILURE_STATUS)))
    && (report.numFailedTestSuites === undefined || report.numFailedTestSuites === accountedSuites.size);
  return { ...FailureReadingSchema.parse({ version: 1, testsRun: report.numPassedTests + report.numFailedTests, complete, failures }), files, totals: { tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    pending: report.numPendingTests ?? null, todo: report.numTodoTests ?? null, files: report.testResults.length } };
}

export function identityFacts(reading: unknown, owner: IdentityFacts['owner'], failed: boolean, truncated = false): IdentityFacts {
  const parsed = FailureReadingSchema.safeParse(reading);
  if (!parsed.success) return { identifiers: [], owner: 'unknown', reason: 'Missing or invalid closed-schema failure reading' };
  const value = parsed.data;
  const identifiers = value.failures.map(failure => JSON.stringify([failure.testId, failure.file, failure.messageClass]));
  if (new Set(identifiers).size !== identifiers.length || value.testsRun !== null && value.testsRun < identifiers.length
    || failed && !identifiers.length || !failed && identifiers.length) {
    return { identifiers: [], owner: 'unknown', reason: 'Failure reading contradicts counts or command exit' };
  }
  return { identifiers: identifiers.sort(), failures: value.failures, count: identifiers.length,
    ...(value.testsRun === null ? {} : { testsRun: value.testsRun }), owner,
    evidence: value.complete && !truncated ? 'complete' : 'partial',
    ...(!value.complete || truncated ? { reason: 'Bounded reading is partial; identity comparison remains unknown' } : {}) };
}
