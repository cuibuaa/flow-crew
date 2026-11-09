import './test-support/policy-runtime.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateValidationDelta, runProjectValidationBaseline, type ValidationRunResponse } from '../src/project-validation.js';
import { decodeRunnerReport, FailureReadingSchema, identityFacts } from '../src/validation-identity.js';

const root = resolve('identity-fixture');
const failure = { testId: 'stable test', file: 'case.test.ts', messageClass: 'assertion' };
const reading = { version: 1, testsRun: 1, complete: true, failures: [failure] };
const run = async (response: ValidationRunResponse, options: Parameters<typeof runProjectValidationBaseline>[1] = {}) =>
  runProjectValidationBaseline(root, { commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture' }],
    runCommand: () => response, ...options });
const testResult = (baseline: Awaited<ReturnType<typeof run>>) => baseline.results.find(result => result.role === 'test')!;
// This controlled producer declares that its finite failure population is exhaustive.
const nativeReport = (failed: boolean, count = 1) => JSON.stringify({ complete: true, numTotalTests: count, numFailedTests: failed ? count : 0,
  numPassedTests: failed ? 0 : count, testResults: [{ name: `${root}/case.test.ts`, assertionResults: Array.from({ length: count }, (_, index) => ({
    fullName: `test ${index}`, status: failed ? 'failed' : 'passed', duration: 0.375, failureMessages: ['address 0xabcd and timestamp are not identity'],
  })) }] });

describe('bounded identity ownership, replacing legacyFailureFacts and handwritten TAP identity', () => {
  it.each([undefined, false])('does not certify whole-command completeness without an exhaustive producer declaration (%j)', async complete => {
    const report = JSON.parse(nativeReport(true));
    if (complete === undefined) delete report.complete; else report.complete = complete;
    const baseline = await run({ exitCode: 1, stdout: JSON.stringify(report) }, {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' } }],
    });
    expect(testResult(baseline)).toMatchObject({ failureIdentity: 'known', identityOwner: 'runner-json', failureEvidence: 'partial', testsRun: 1 });
    expect(evaluateValidationDelta(baseline, baseline.results).find(value => value.role === 'test')?.state).toBe('unverified');
  });
  it.each([undefined, false])('keeps a green exit with an incomplete declared population unknown (%j)', async complete => {
    const report = JSON.parse(nativeReport(false));
    if (complete === undefined) delete report.complete; else report.complete = complete;
    const baseline = await run({ exitCode: 0, stdout: JSON.stringify(report) }, {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' } }],
    });
    expect(testResult(baseline)).toMatchObject({ exitCode: 0, failureIdentity: 'unknown', identityOwner: 'runner-json', reason: expect.stringContaining('partial') });
    expect(baseline.gateCriteria).toEqual([]);
    expect(evaluateValidationDelta(undefined, baseline.results)[0].state).toBe('verified');
    expect(evaluateValidationDelta(baseline, baseline.results)[0].state).toBe('verified');
  });

  it('decodes native reporter JSON using JSON.parse and the structured schema, excluding incidental fields', async () => {
    const baseline = await run({ exitCode: 1, stdout: nativeReport(true, 10) }, {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' } }],
    });
    expect(testResult(baseline)).toMatchObject({ state: 'failed', failureCount: 10, testsRun: 10,
      failureIdentity: 'known', failureEvidence: 'complete', identityOwner: 'runner-json' });
    expect(testResult(baseline).failureIdentifiers).toHaveLength(10);
    expect(testResult(baseline).failureIdentifiers.every(id => !id.includes('0.375') && !id.includes('0xabcd'))).toBe(true);
    expect(testResult(baseline).failures?.every(value => value.file === 'case.test.ts')).toBe(true);
    expect(decodeRunnerReport(nativeReport(false), 'vitest-json', root)).toMatchObject({ testsRun: 1, failures: [] });
  });

  it('records executed tests without counting pending native assertions as run', () => {
    const report = JSON.parse(nativeReport(true));
    report.numTotalTests = 2;
    report.testResults[0].assertionResults.push({ fullName: 'not run', status: 'pending' });
    expect(decodeRunnerReport(JSON.stringify(report), 'vitest-json', root)).toMatchObject({ testsRun: 1, failures: [expect.objectContaining({ testId: 'test 0' })] });
  });

  it('keeps identical UTF-8 reporter bytes identical across child stream chunk boundaries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'utf8-report-'));
    try {
      const report = JSON.parse(nativeReport(true)); report.testResults[0].assertionResults[0].fullName = '测试 😀';
      const payload = JSON.stringify(report), split = Buffer.from(payload).indexOf(Buffer.from('测')) + 1;
      const command = { role: 'test' as const, command: process.execPath, display: 'UTF-8 reporter', args: [] as string[], report: { format: 'vitest-json' as const } };
      const single = await runProjectValidationBaseline(directory, { commands: [{ ...command, args: ['-e', `process.stdout.write(${JSON.stringify(payload)});process.exitCode=1;`] }] });
      const fragmented = await runProjectValidationBaseline(directory, { commands: [{ ...command, args: ['-e', `const bytes=Buffer.from(${JSON.stringify(payload)});process.stdout.write(bytes.subarray(0,${split}));setTimeout(()=>{process.stdout.write(bytes.subarray(${split}));process.exitCode=1;},100);`] }] });
      expect(testResult(fragmented)).toMatchObject({ failureIdentity: 'known', failureEvidence: 'complete', outputBytes: { stdout: Buffer.byteLength(payload), stderr: 0 } });
      expect(testResult(fragmented).failureIdentifiers).toEqual(testResult(single).failureIdentifiers);
      expect(testResult(fragmented).failures?.[0].testId).toBe('测试 😀');
      expect(evaluateValidationDelta(single, fragmented.results).find(value => value.role === 'test')?.state).toBe('unverified');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('records invalid UTF-8 as unknown without handing damaged text to a model', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'invalid-utf8-report-'));
    try {
      const report = JSON.parse(nativeReport(true)); report.testResults[0].assertionResults[0].fullName = 'x';
      const bytes = Buffer.from(JSON.stringify(report)); bytes[bytes.indexOf(Buffer.from('"x"')) + 1] = 0xc3;
      const result = await runProjectValidationBaseline(directory, { commands: [{ role: 'test', command: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}));process.exitCode=1;`], display: 'invalid UTF-8', report: { format: 'vitest-json' } }] });
      expect(testResult(result)).toMatchObject({ failureIdentity: 'unknown', identityOwner: 'unknown', failureIdentifiers: [], outputBytes: { stdout: bytes.length, stderr: 0 } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['load', 'hook'])('keeps an unrepresented %s error partial without parsing its message or invoking a model fallback', async kind => {
    const prior = JSON.parse(nativeReport(true));
    prior.numFailedTestSuites = 1;
    prior.testResults[0].status = 'failed'; prior.testResults[0].message = '';
    const current = structuredClone(prior);
    if (kind === 'load') {
      current.numFailedTestSuites = 2;
      current.testResults.push({ name: `${root}/load.test.ts`, status: 'failed', message: 'arbitrary opaque text 0.375s 0xabcd', assertionResults: [] });
    } else current.testResults[0].message = 'arbitrary opaque text 0.339s 0xffff';
    const options = { commands: [{ role: 'test' as const, command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' as const } }] };
    const before = await run({ exitCode: 1, stdout: JSON.stringify(prior) }, options);
    const after = await run({ exitCode: 1, stdout: JSON.stringify(current) }, options);
    expect(testResult(before)).toMatchObject({ failureEvidence: 'complete', failureCount: 1 });
    expect(testResult(after)).toMatchObject({ identityOwner: 'runner-json', failureEvidence: 'partial', failureCount: 1, testsRun: 1 });
    expect(testResult(after).failureIdentifiers).toEqual(testResult(before).failureIdentifiers);
    expect(evaluateValidationDelta(before, after.results).find(value => value.role === 'test')?.state).toBe('unverified');
  });

  it('accounts for nested structured suite counts and keeps extra suite or snapshot failures partial', () => {
    const report = JSON.parse(nativeReport(true));
    report.testResults[0].assertionResults[0].ancestorTitles = ['nested']; report.numFailedTestSuites = 2;
    expect(decodeRunnerReport(JSON.stringify(report), 'vitest-json', root).complete).toBe(true);
    report.numFailedTestSuites = 3;
    expect(decodeRunnerReport(JSON.stringify(report), 'vitest-json', root).complete).toBe(false);
    report.numFailedTestSuites = 2; report.snapshot = { failure: true };
    expect(decodeRunnerReport(JSON.stringify(report), 'vitest-json', root).complete).toBe(false);
  });

  it('uses the declared exhaustive report despite additional diagnostic bytes', async () => {
    const options = { commands: [{ role: 'test' as const, command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' as const } }] };
    const before = await run({ exitCode: 1, stdout: nativeReport(true) }, options);
    const after = await run({ exitCode: 1, stdout: nativeReport(true), stderr: 'opaque diagnostic bytes' }, options);
    expect(testResult(after)).toMatchObject({ failureIdentity: 'known', failureEvidence: 'complete', identityOwner: 'runner-json' });
    expect(testResult(after).failureIdentifiers).toEqual(testResult(before).failureIdentifiers);
    expect(evaluateValidationDelta(before, after.results).find(value => value.role === 'test')?.state).toBe('unverified');
  });

  it('does not silently discard unsupported structured failure channels', async () => {
    const report = JSON.parse(nativeReport(true)); report.unhandledErrors = [{ name: 'Error', message: 'opaque' }];
    const after = await run({ exitCode: 1, stdout: JSON.stringify(report) }, {
      commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' } }],
    });
    expect(testResult(after)).toMatchObject({ failureIdentity: 'unknown', identityOwner: 'unknown' });
  });

  it('accepts a freshly written declared report and rejects stale or escaping report paths without falling back', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'json-report-'));
    try {
      const report = JSON.stringify({ numTotalTests: 1, numFailedTests: 1, numPassedTests: 0,
        testResults: [{ name: join(directory, 'case.test.ts'), assertionResults: [{ fullName: 'native id', status: 'failed' }] }] });
      writeFileSync(join(directory, 'report.json'), report);
      const command = { role: 'test' as const, command: process.execPath, display: 'declared JSON suite',
        args: ['-e', 'process.exitCode=1'], report: { format: 'vitest-json' as const, path: 'report.json' } };
      const stale = await runProjectValidationBaseline(directory, { commands: [command] });
      expect(testResult(stale)).toMatchObject({ failureIdentity: 'unknown', reason: expect.stringContaining('stale') });
      const fresh = await runProjectValidationBaseline(directory, { commands: [{ ...command,
        args: ['-e', `require('fs').writeFileSync('report.json',${JSON.stringify(report)});process.exitCode=1`] }] });
      expect(testResult(fresh)).toMatchObject({ failureIdentity: 'known', testsRun: 1, identityOwner: 'runner-json' });
      const escaped = await runProjectValidationBaseline(directory, { commands: [{ ...command, report: { format: 'vitest-json', path: '../outside.json' } }] });
      expect(testResult(escaped)).toMatchObject({ state: 'unverified', failureIdentity: 'unknown' });
      const controlPath = await runProjectValidationBaseline(directory, { commands: [{ ...command, report: { format: 'vitest-json', path: 'auth.json' } }] });
      expect(testResult(controlPath)).toMatchObject({ state: 'unverified', failureIdentity: 'unknown', reason: expect.stringContaining('credential/control') });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['FAIL case.test.ts\nTests 1 failed', '× stable test 7ms', 'src/example.ts:12:4 - error TS2322',
    'TAP version 13\nnot ok 1 - stable test\n1..1\n# fail 1',
    '[... 512 earlier bytes omitted ...]\nFAIL retained.test.ts\nTests 1 failed'])('never grants raw output a decision role: %s', async output => {
    const baseline = await run({ exitCode: 1, stdout: output });
    expect(testResult(baseline)).toMatchObject({ failureIdentity: 'unknown', failureIdentifiers: [], identityOwner: 'unknown' });
    expect(testResult(baseline).failureCount).toBeUndefined();
    expect(evaluateValidationDelta(baseline, baseline.results).find(value => value.role === 'test')?.state).toBe('unverified');
  });

  it('bounds opaque output without inventing identities or invoking a second owner', async () => {
    const result = testResult(await run({ exitCode: 1, stdout: 'early\n' + 'diagnostic'.repeat(5000) }, { maxOutputBytes: 128 }));
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(192);
    expect(result).toMatchObject({ failureIdentity: 'unknown', failureIdentifiers: [], reason: expect.stringContaining('No declared structured reporter') });
  });

  it('rejects contradictory JSON counts and failing exits with zero reported failures', async () => {
    const report = JSON.parse(nativeReport(true)); report.numFailedTests = 0;
    expect(() => decodeRunnerReport(JSON.stringify(report), 'vitest-json', root)).toThrow('counts disagree');
    expect(identityFacts({ ...reading, failures: [] }, 'runner-json', true).owner).toBe('unknown');
    expect(FailureReadingSchema.safeParse({ ...reading, failures: [{ ...failure, testId: 'x'.repeat(1025) }] }).success).toBe(false);
  });

  it('keeps unstructured package duration variants unknown rather than certifying equivalence', async () => {
    for (const duration of ['0.243s', '0.375s', '0.339s']) {
      const baseline = await run({ exitCode: 1, stdout: `FAIL\ttaglib\t${duration}\nFAIL\n` });
      expect(testResult(baseline)).toMatchObject({ failureIdentity: 'unknown', failureIdentifiers: [] });
      expect(evaluateValidationDelta(baseline, baseline.results)[0].state).toBe('unverified');
    }
  });

  it('records recovery to green and exposes added declared failures to the gate', async () => {
    const commands = [{ role: 'test' as const, command: 'fixture', args: [], display: 'fixture', report: { format: 'vitest-json' as const } }];
    const baseline = await run({ exitCode: 1, stdout: nativeReport(true) }, { commands });
    const improved = await run({ exitCode: 0 });
    expect(evaluateValidationDelta(baseline, improved.results)[0].state).toBe('verified');
    const current = await run({ exitCode: 1, stdout: nativeReport(true, 2) }, { commands });
    expect(evaluateValidationDelta(baseline, current.results)[0].state).toBe('unverified');
  });
});
