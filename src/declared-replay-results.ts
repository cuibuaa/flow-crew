const TEST_OUTCOME = { PASS: 'passed', FAIL: 'failed', PENDING: 'pending', TODO: 'todo', SKIPPED: 'skipped', DISABLED: 'disabled' } as const;
import { resolve } from 'node:path';

export type ReplayDiagnostic = null | boolean | number | string | ReplayDiagnostic[] | { [key: string]: ReplayDiagnostic };
export interface ReplayTestObservation {
  name: string;
  status: string;
  file?: string;
  nesting?: number;
  durationMs?: number;
  diagnostic?: ReplayDiagnostic;
}

/** Diagnostics are data, never acceptance evidence. Keep nested assertion/error
 * fields (including non-enumerable Error.cause) with explicit size/cycle limits.
 * This self-contained function also runs in the engine-owned Node reporter. */
export function replayDiagnostic(value: unknown, ancestors: object[] = [], depth = 0): ReplayDiagnostic {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 8192 ? value : { text: value.slice(0, 8192), omittedCharacters: value.length - 8192 };
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') return { type: typeof value, value: String(value) };
  if (ancestors.includes(value)) return { truncated: 'cycle' };
  if (depth >= 8) return { truncated: 'depth' };
  const lineage = [...ancestors, value];
  if (Array.isArray(value)) {
    const result: ReplayDiagnostic[] = [];
    for (const entry of value.slice(0, 128)) result.push(replayDiagnostic(entry, lineage, depth + 1));
    if (value.length > 128) result.push({ omittedEntries: value.length - 128 });
    return result;
  }
  const result: { [key: string]: ReplayDiagnostic } = {};
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys.slice(0, 128)) {
    // Define a data property so diagnostic keys cannot mutate the result prototype.
    let entry: ReplayDiagnostic;
    try { entry = replayDiagnostic(Reflect.get(value, key), lineage, depth + 1); }
    catch { entry = { unavailable: 'property could not be read' }; }
    Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true });
  }
  if (keys.length > 128) result.omittedProperties = keys.length - 128;
  return result;
}

export interface ReplayTests {
  collected: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
  error?: string;
  tests?: ReplayTestObservation[];
  diagnostic?: ReplayDiagnostic;
  /** Runner-forwarded stdout/stderr/diagnostic events differ from process pipes. */
  runnerOutput?: ReplayDiagnostic;
}
const empty = (error: string, diagnostic?: unknown): ReplayTests => ({ collected: 0, passed: 0, failed: 0, skipped: 0, failures: [], error,
  ...(diagnostic === undefined ? {} : { diagnostic: replayDiagnostic(diagnostic) }) });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Engine-owned reporter, installed in a disposable directory for this replay. */
export const NODE_REPLAY_REPORTER = `${replayDiagnostic.toString()}
export default async function* (events) {
  const tests = [], output = {events:[],observedEvents:0,omittedEvents:0};
  let summary, remainingDiagnosticBytes = 262144, remainingOutputBytes = 262144;
  // Identity/outcome rows are never dropped to make diagnostic data fit.
  // The process capture limit remains independent and authoritative.
  const diagnostic = (value) => {
    const data = replayDiagnostic(value);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes > remainingDiagnosticBytes) return {omitted:'aggregate diagnostic byte limit',omittedBytes:bytes};
    remainingDiagnosticBytes -= bytes;
    return data;
  };
  for await (const event of events) {
    if (['test:stdout', 'test:stderr', 'test:diagnostic'].includes(event.type)) {
      output.observedEvents++;
      const record = {type:event.type,data:replayDiagnostic(event.data)};
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (output.events.length < 128 && bytes <= remainingOutputBytes) {
        output.events.push(record); remainingOutputBytes -= bytes;
      } else output.omittedEvents++;
    }
    if (event.type === 'test:summary' && !event.data.file) summary = event.data;
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      if (d.details?.type !== 'suite') tests.push({file:d.file,name:d.name,
        status:event.type === 'test:pass' ? 'passed' : 'failed',
        skipped:!!(d.skip || d.todo),failureType:d.details?.error?.failureType,
        nesting:d.nesting,durationMs:d.details?.duration_ms,
        diagnostic:d.details?.error ? diagnostic(d.details.error) : undefined});
    }
  }
  yield JSON.stringify({flowcrewReplay:1,tests,summary,output}) + '\\n';
};\n`;

export function nodeReplayTests(output: string, target: string): ReplayTests {
  try {
    const value = JSON.parse(output) as { flowcrewReplay?: number; tests?: Array<{ file?: string; name?: string; status?: string; skipped?: boolean; failureType?: string; nesting?: number; durationMs?: number; diagnostic?: ReplayDiagnostic }>; summary?: unknown; output?: ReplayDiagnostic };
    const observed = Array.isArray(value.tests) ? value.tests.map(test => ({ name: test?.name ?? '<unnamed>', file: test?.file,
      status: test?.skipped ? 'skipped' : test?.status ?? 'unknown', nesting: test?.nesting, durationMs: test?.durationMs,
      ...(test?.diagnostic === undefined ? {} : { diagnostic: test.diagnostic }) })) : [];
    const invalid = (error: string): ReplayTests => ({ ...empty(error, value.summary), tests: observed,
      ...(value.output === undefined ? {} : { runnerOutput: value.output }) });
    if (value.flowcrewReplay !== 1 || !value.summary || !Array.isArray(value.tests)) return invalid('Node did not emit a complete engine reporter record');
    const result: ReplayTests = { collected: 0, passed: 0, failed: 0, skipped: 0, failures: [], tests: observed, diagnostic: replayDiagnostic(value.summary),
      ...(value.output === undefined ? {} : { runnerOutput: value.output }) };
    const names = new Set<string>();
    for (const test of value.tests) {
      // Node's file wrapper is also emitted for an import failure or zero tests.
      if (!test.name || !test.file || resolve(test.name) === resolve(target)) return invalid('Node file wrapper is not a collected test');
      if (names.has(test.name)) return invalid('Node test names are ambiguous; declare uniquely named tests');
      names.add(test.name);
      if (test.failureType && test.failureType !== 'testCodeFailure') return invalid(`Node runtime failure ${test.failureType} cannot satisfy a reproduction`);
      result.collected++;
      if (test.skipped) result.skipped++;
      else if (test.status === TEST_OUTCOME.PASS) result.passed++;
      else if (test.status === TEST_OUTCOME.FAIL) { result.failed++; result.failures.push(test.name); }
      else return invalid('Node emitted an unknown test outcome');
    }
    return result;
  } catch { return empty('Node did not emit a parseable engine reporter record', output); }
}

/** Read a complete runner JSON record before applying bounded log truncation. */
export function vitestReplayTests(output: string, targets: readonly string[]): Map<string, ReplayTests> {
  const results = new Map<string, ReplayTests>();
  let diagnostic: unknown = output;
  const observed = new Map<string, ReplayTestObservation[]>();
  try {
    const value = JSON.parse(output.trim()) as {
      numTotalTests?: unknown; numPassedTests?: unknown; numFailedTests?: unknown; numPendingTests?: unknown;
      numRuntimeErrorTestSuites?: unknown; unhandledErrors?: unknown[];
      testResults?: Array<{ name?: string; status?: string; message?: string; assertionResults?: Array<{ status?: string; fullName?: string; duration?: number; failureMessages?: unknown; failureDetails?: unknown }> }>;
    };
    diagnostic = value;
    for (const suite of Array.isArray(value.testResults) ? value.testResults : []) if (suite?.name && Array.isArray(suite.assertionResults)) {
      const tests = observed.get(resolve(suite.name)) ?? [];
      for (const test of suite.assertionResults) tests.push({ name: test?.fullName ?? '<unnamed>', file: suite.name, status: test?.status ?? 'unknown', durationMs: test?.duration,
        diagnostic: replayDiagnostic({ failureMessages: test?.failureMessages, failureDetails: test?.failureDetails }) });
      observed.set(resolve(suite.name), tests);
    }
    if (![value.numTotalTests, value.numPassedTests, value.numFailedTests, value.numPendingTests].every(count)
      || !Array.isArray(value.testResults) || Number(value.numRuntimeErrorTestSuites ?? 0) > 0 || value.unhandledErrors?.length) {
      throw new Error('Vitest collection/runtime errors cannot satisfy a reproduction');
    }
    for (const suite of value.testResults) {
      if (!suite.name || !targets.includes(resolve(suite.name)) || results.has(resolve(suite.name)) || !Array.isArray(suite.assertionResults)) {
        throw new Error('Vitest returned an unbound or duplicate target record');
      }
      const result: ReplayTests = { collected: suite.assertionResults.length, passed: 0, failed: 0, skipped: 0, failures: [], tests: observed.get(resolve(suite.name)), diagnostic: replayDiagnostic({ status: suite.status, message: suite.message }) };
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
    for (const target of targets) results.set(target, { ...empty(error instanceof Error ? error.message : String(error), diagnostic), tests: observed.get(resolve(target)) ?? [] });
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
  const observed: ReplayTestObservation[] = [];
  try {
  const records = [...xml.matchAll(/<testcase\s+([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/testcase>)/g)].map(record => ({ attributes: xmlAttributes(record[1]), body: record[2] ?? '' }));
  for (const { attributes, body } of records) observed.push({ name: `${attributes.classname ?? '<unnamed>'}::${attributes.name ?? '<unnamed>'}`,
    status: /<skipped(?:\s|>)/.test(body) ? 'skipped' : /<failure(?:\s|>)/.test(body) ? 'failed' : /<error(?:\s|>)/.test(body) ? 'error' : 'passed',
    diagnostic: replayDiagnostic({ attributes, body: xmlValue(body) }) });
    const suites = [...xml.matchAll(/<testsuite\s+([^>]+)>/g)];
    if (suites.length !== 1 || !xml.trim().endsWith('</testsuites>')) throw new Error('pytest did not emit one complete JUnit suite');
    const totals = xmlAttributes(suites[0][1]);
    const tests = ['tests', 'failures', 'errors', 'skipped'].map((key) => /^\d+$/.test(totals[key] ?? '') ? Number(totals[key]) : NaN);
    if (!tests.every(count) || tests[2] > 0) throw new Error('pytest collection/runtime errors cannot satisfy a reproduction');
    const result: ReplayTests = { collected: 0, passed: 0, failed: 0, skipped: 0, failures: [], tests: observed, diagnostic: replayDiagnostic(totals) };
    const names = new Set<string>();
    for (const { attributes, body } of records) {
      if (!attributes.name || !attributes.classname) throw new Error('pytest test identity is absent');
      const name = `${attributes.classname}::${attributes.name}`;
      if (names.has(name)) throw new Error('pytest test identities are ambiguous');
      names.add(name); result.collected++;
      if (/<skipped(?:\s|>)/.test(body)) result.skipped++;
      else if (/<failure(?:\s|>)/.test(body)) { result.failed++; result.failures.push(name); }
      else if (/<error(?:\s|>)/.test(body)) throw new Error('pytest runtime errors cannot satisfy a reproduction');
      else result.passed++;
    }
    if (result.collected !== tests[0] || result.failed !== tests[1] || result.skipped !== tests[3]) throw new Error('pytest JUnit totals do not match test records');
    return result;
  } catch (error) { return { ...empty(error instanceof Error ? error.message : String(error), xml), tests: observed }; }
}
