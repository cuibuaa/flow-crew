const TEST_OUTCOME = { PASS: 'passed', FAIL: 'failed', PENDING: 'pending', TODO: 'todo', SKIPPED: 'skipped', DISABLED: 'disabled' } as const;
import { resolve } from 'node:path';

export interface ReplayTests {
  collected: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
  error?: string;
}
const empty = (error: string): ReplayTests => ({ collected: 0, passed: 0, failed: 0, skipped: 0, failures: [], error });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Engine-owned reporter, installed in a disposable directory for this replay. */
export const NODE_REPLAY_REPORTER = `export default async function* (events) {
  const tests = []; let summary;
  for await (const event of events) {
    if (event.type === 'test:summary' && !event.data.file) summary = event.data;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      if (d.details?.type !== 'suite') tests.push({file:d.file,name:d.name,
        status:event.type === 'test:pass' ? 'passed' : 'failed',
        skipped:!!(d.skip || d.todo),failureType:d.details?.error?.failureType});
    }
  }
  yield JSON.stringify({flowcrewReplay:1,tests,summary}) + '\\n';
};\n`;

export function nodeReplayTests(output: string, target: string): ReplayTests {
  try {
    const value = JSON.parse(output) as { flowcrewReplay?: number; tests?: Array<{ file?: string; name?: string; status?: string; skipped?: boolean; failureType?: string }>; summary?: unknown };
    if (value.flowcrewReplay !== 1 || !value.summary || !Array.isArray(value.tests)) return empty('Node did not emit a complete engine reporter record');
    const result: ReplayTests = { collected: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
    const names = new Set<string>();
    for (const test of value.tests) {
      // Node's file wrapper is also emitted for an import failure or zero tests.
      if (!test.name || !test.file || resolve(test.name) === resolve(target)) return empty('Node file wrapper is not a collected test');
      if (names.has(test.name)) return empty('Node test names are ambiguous; declare uniquely named tests');
      names.add(test.name);
      if (test.failureType && test.failureType !== 'testCodeFailure') return empty(`Node runtime failure ${test.failureType} cannot satisfy a reproduction`);
      result.collected++;
      if (test.skipped) result.skipped++;
      else if (test.status === TEST_OUTCOME.PASS) result.passed++;
      else if (test.status === TEST_OUTCOME.FAIL) { result.failed++; result.failures.push(test.name); }
      else return empty('Node emitted an unknown test outcome');
    }
    return result;
  } catch { return empty('Node did not emit a parseable engine reporter record'); }
}

/** Read a complete runner JSON record before applying bounded log truncation. */
export function vitestReplayTests(output: string, targets: readonly string[]): Map<string, ReplayTests> {
  const results = new Map<string, ReplayTests>();
  try {
    const value = JSON.parse(output.trim()) as {
      numTotalTests?: unknown; numPassedTests?: unknown; numFailedTests?: unknown; numPendingTests?: unknown;
      numRuntimeErrorTestSuites?: unknown; unhandledErrors?: unknown[];
      testResults?: Array<{ name?: string; status?: string; message?: string; assertionResults?: Array<{ status?: string; fullName?: string }> }>;
    };
    if (![value.numTotalTests, value.numPassedTests, value.numFailedTests, value.numPendingTests].every(count)
      || !Array.isArray(value.testResults) || Number(value.numRuntimeErrorTestSuites ?? 0) > 0 || value.unhandledErrors?.length) {
      throw new Error('Vitest collection/runtime errors cannot satisfy a reproduction');
    }
    for (const suite of value.testResults) {
      if (!suite.name || !targets.includes(resolve(suite.name)) || results.has(resolve(suite.name)) || !Array.isArray(suite.assertionResults)) {
        throw new Error('Vitest returned an unbound or duplicate target record');
      }
      const result: ReplayTests = { collected: suite.assertionResults.length, passed: 0, failed: 0, skipped: 0, failures: [] };
      const names = new Set<string>();
      for (const test of suite.assertionResults) {
        if (!test.fullName || names.has(test.fullName)) throw new Error('Vitest test identities are absent or ambiguous');
        names.add(test.fullName);
        if (test.status === TEST_OUTCOME.PASS) result.passed++;
        else if (test.status === TEST_OUTCOME.FAIL) { result.failed++; result.failures.push(test.fullName); }
        else if (test.status === TEST_OUTCOME.PENDING || test.status === TEST_OUTCOME.TODO || test.status === TEST_OUTCOME.SKIPPED || test.status === TEST_OUTCOME.DISABLED) result.skipped++;
        else throw new Error('Vitest returned an unknown test outcome');
      }
      results.set(resolve(suite.name), result);
    }
    const sum = (key: 'collected' | 'passed' | 'failed' | 'skipped') => [...results.values()].reduce((n, row) => n + row[key], 0);
    if (sum('collected') !== value.numTotalTests || sum('passed') !== value.numPassedTests
      || sum('failed') !== value.numFailedTests || sum('skipped') !== value.numPendingTests) {
      throw new Error('Vitest totals do not match named target records');
    }
  } catch (error) {
    for (const target of targets) results.set(target, empty(error instanceof Error ? error.message : String(error)));
  }
  return results;
}

const xmlValue = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!)
  .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => String.fromCodePoint(code[0] === 'x' ? parseInt(code.slice(1), 16) : Number(code)));
function xmlAttributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], xmlValue(match[2])]));
}

/** Pytest's engine-requested JUnit supplies identities, not log wording. */
export function pytestReplayTests(xml: string): ReplayTests {
  try {
    const suites = [...xml.matchAll(/<testsuite\s+([^>]+)>/g)];
    if (suites.length !== 1 || !xml.trim().endsWith('</testsuites>')) throw new Error('pytest did not emit one complete JUnit suite');
    const totals = xmlAttributes(suites[0][1]);
    const tests = ['tests', 'failures', 'errors', 'skipped'].map((key) => /^\d+$/.test(totals[key] ?? '') ? Number(totals[key]) : NaN);
    if (!tests.every(count) || tests[2] > 0) throw new Error('pytest collection/runtime errors cannot satisfy a reproduction');
    const result: ReplayTests = { collected: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
    const names = new Set<string>();
    for (const record of xml.matchAll(/<testcase\s+([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/testcase>)/g)) {
      const attributes = xmlAttributes(record[1]);
      if (!attributes.name || !attributes.classname) throw new Error('pytest test identity is absent');
      const name = `${attributes.classname}::${attributes.name}`;
      if (names.has(name)) throw new Error('pytest test identities are ambiguous');
      names.add(name); result.collected++;
      if (/<skipped(?:\s|>)/.test(record[2] ?? '')) result.skipped++;
      else if (/<failure(?:\s|>)/.test(record[2] ?? '')) { result.failed++; result.failures.push(name); }
      else if (/<error(?:\s|>)/.test(record[2] ?? '')) throw new Error('pytest runtime errors cannot satisfy a reproduction');
      else result.passed++;
    }
    if (result.collected !== tests[0] || result.failed !== tests[1] || result.skipped !== tests[3]) throw new Error('pytest JUnit totals do not match test records');
    return result;
  } catch (error) { return empty(error instanceof Error ? error.message : String(error)); }
}
