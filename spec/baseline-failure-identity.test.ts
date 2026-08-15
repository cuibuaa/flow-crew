import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateValidationDelta,
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
  type ValidationRunResponse,
} from '../src/project-validation.js';

const projectDir = resolve('portable-baseline-identity-project');

async function baselineFor(
  response: ValidationRunResponse,
  maxOutputBytes?: number,
): Promise<ProjectValidationBaseline> {
  return runProjectValidationBaseline(projectDir, {
    fs: {
      exists: () => false,
      readText: (path) => { throw new Error(`unexpected fixture read: ${path}`); },
    },
    declaredCommands: [{
      role: 'test',
      command: 'fixture-test',
      args: [],
      evidencePath: 'portable-brief.md#validation.commands.test',
    }],
    runCommand: () => response,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

function testResult(baseline: ProjectValidationBaseline): ValidationCommandResult {
  const result = baseline.results.find(({ role }) => role === 'test');
  if (!result) throw new Error('test result fixture is missing');
  return result;
}

function nativeTapFailures(names: readonly string[]): string {
  return [
    'TAP version 13',
    ...names.flatMap((name, index) => [
      `# Subtest: ${name}`,
      `not ok ${index + 1} - ${name}`,
      '  ---',
      "  failureType: 'testCodeFailure'",
      "  code: 'ERR_TEST_FAILURE'",
      '  ...',
    ]),
    `1..${names.length}`,
    `# tests ${names.length}`,
    '# pass 0',
    `# fail ${names.length}`,
  ].join('\n');
}

describe('baseline failure identity extraction', () => {
  it('identifies every named failure from complete native Node TAP', async () => {
    const names = Array.from(
      { length: 10 },
      (_, index) => `native failure ${String(index + 1).padStart(2, '0')}`,
    );

    const baseline = await baselineFor({ exitCode: 1, stdout: nativeTapFailures(names) });

    expect(testResult(baseline)).toMatchObject({
      state: 'failed',
      exitCode: 1,
      failureCount: 10,
      failureIdentifiers: names,
      failureIdentity: 'known',
      failureEvidence: 'complete',
    });
  });

  it('parses complete raw TAP before bounding only the stored output', async () => {
    const maxOutputBytes = 128;
    const rawOutput = [
      'TAP version 13',
      'not ok 1 - early native failure',
      `# ${'diagnostic '.repeat(400)}`,
      '1..1',
      '# tests 1',
      '# fail 1',
    ].join('\n');

    const baseline = await baselineFor({ exitCode: 1, stdout: rawOutput }, maxOutputBytes);
    const result = testResult(baseline);

    expect(Buffer.byteLength(rawOutput)).toBeGreaterThan(maxOutputBytes);
    expect(result).toMatchObject({
      failureCount: 1,
      failureIdentifiers: ['early native failure'],
      failureIdentity: 'known',
      failureEvidence: 'complete',
    });
    expect(result.output).toMatch(/^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]/);
    expect(result.output).not.toContain('not ok 1 - early native failure');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(maxOutputBytes + 64);
  });

  it('does not promote TODO records into baseline failures', async () => {
    const output = [
      'TAP version 13',
      'not ok 1 - expected future failure # TODO',
      'not ok 2 - actual failure',
      'ok 3 - skipped case # SKIP unavailable',
      '1..3',
      '# fail 1',
      '# skipped 1',
      '# todo 1',
    ].join('\n');

    expect(testResult(await baselineFor({ exitCode: 1, stdout: output }))).toMatchObject({
      failureCount: 1,
      failureIdentifiers: ['actual failure'],
      failureIdentity: 'known',
      failureEvidence: 'complete',
    });
  });

  it.each([
    {
      label: 'FAIL-prefixed name',
      output: 'FAIL spec/existing.test.ts\nTests 1 failed',
      identifier: 'spec/existing.test.ts',
    },
    {
      label: 'cross-marked name',
      output: '× preserves the exact identity 7ms',
      identifier: 'preserves the exact identity',
    },
    {
      label: 'compiler file-position diagnostic',
      output: 'src/example.ts:12:4 - error TS2322: Type mismatch',
      identifier: 'src/example.ts TS2322',
    },
  ])('preserves the legacy $label adapter', async ({ output, identifier }) => {
    const baseline = await baselineFor({ exitCode: 1, stdout: output });

    expect(testResult(baseline)).toMatchObject({
      failureCount: 1,
      failureIdentifiers: [identifier],
      failureIdentity: 'known',
      failureEvidence: 'complete',
    });
  });

  it('recovers a retained Vitest failure and observed count as partial evidence after truncation', async () => {
    const identifier = 'spec/portable-scenario.test.ts > Scenario A: retained failure identity';
    const output = [
      '[... 512 earlier bytes omitted ...]',
      `FAIL  ${identifier}`,
      'Test Files  1 failed | 158 passed (159)',
      'Tests  1 failed | 1665 passed | 4 skipped (1670)',
    ].join('\n');

    const baseline = await baselineFor({ exitCode: 1, stdout: output });
    const result = testResult(baseline);
    const criterion = baseline.gateCriteria.find(({ role }) => role === 'test');

    expect(result).toMatchObject({
      failureCount: 1,
      failureIdentifiers: [identifier],
      failureIdentity: 'known',
      failureEvidence: 'partial',
      reason: expect.stringMatching(/recovered.*partial.*truncated/i),
    });
    expect(criterion).toMatchObject({
      baselineFailureCount: 1,
      baselineFailureIdentifiers: [identifier],
      baselineFailureEvidence: 'partial',
      description: expect.stringMatching(/partial.*lower bound.*not a proven whole-run count.*unresolved/i),
    });
    expect(evaluateValidationDelta(baseline, [result]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'unresolved', newFailureIdentifiers: [] });
  });

  it('refuses red-to-red conclusions when either side has partial evidence, while green transitions stay decisive', async () => {
    const partialBaseline = await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/partial.test.ts\nTests 1 failed',
    });
    const completeBaseline = await baselineFor({
      exitCode: 1,
      stdout: 'FAIL spec/partial.test.ts\nTests 1 failed',
    });
    const partial = testResult(partialBaseline);
    const complete = testResult(completeBaseline);
    const passed: ValidationCommandResult = {
      role: 'test',
      state: 'passed',
      exitCode: 0,
      durationMs: 1,
      output: '',
      failureIdentifiers: [],
      failureIdentity: 'none',
    };
    const greenBaseline = await baselineFor({ exitCode: 0 });

    expect(evaluateValidationDelta(partialBaseline, [complete]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'unresolved', reason: expect.stringContaining('partial') });
    expect(evaluateValidationDelta(completeBaseline, [partial]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'unresolved', reason: expect.stringContaining('partial') });
    expect(evaluateValidationDelta(partialBaseline, [passed]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'pass', reason: expect.stringContaining('improved to green') });
    expect(evaluateValidationDelta(greenBaseline, [partial]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'regression', reason: expect.stringContaining('green') });
  });

  it('keeps opaque non-TAP unknown, records its cause, and leaves the delta unresolved', async () => {
    const baseline = await baselineFor({
      exitCode: 9,
      stderr: 'opaque failure; no runner-specific identity is available',
    });
    const result = testResult(baseline);
    const criterion = baseline.gateCriteria.find(({ role }) => role === 'test');

    expect(result).toMatchObject({
      state: 'failed',
      failureIdentifiers: [],
      failureIdentity: 'unknown',
      reason: expect.stringContaining('non-TAP output format is not recognized'),
    });
    if (!result.reason) throw new Error('unknown failure cause was not recorded');
    expect(criterion).toMatchObject({
      rule: 'no_regression_from_baseline',
      description: expect.stringContaining(result.reason),
    });

    const current: ValidationCommandResult = {
      role: 'test',
      state: 'failed',
      exitCode: 1,
      durationMs: 1,
      output: 'FAIL spec/new.test.ts',
      failureCount: 1,
      failureIdentifiers: ['spec/new.test.ts'],
      failureIdentity: 'known',
    };
    expect(evaluateValidationDelta(baseline, [current]).find(({ role }) => role === 'test'))
      .toMatchObject({ state: 'unresolved', newFailureIdentifiers: [] });
  });

  it('distinguishes empty output from opaque output', async () => {
    const baseline = await baselineFor({ exitCode: 1 });
    const result = testResult(baseline);

    expect(result).toMatchObject({
      failureIdentifiers: [],
      failureIdentity: 'unknown',
      reason: expect.stringContaining('produced no output'),
    });
    expect(baseline.gateCriteria.find(({ role }) => role === 'test')?.description)
      .toContain(result.reason);
  });

  it.each([
    {
      label: 'truncated',
      output: '[... 512 earlier bytes omitted ...]\nTAP version 13\nnot ok 1 - partial\n1..1\n# fail 1',
      cause: /truncated before parsing/,
    },
    {
      label: 'bailed out',
      output: 'TAP version 13\nnot ok 1 - partial\nBail out! infrastructure stopped\n1..1\n# fail 1',
      cause: /contains a bailout/,
    },
    {
      label: 'plan-less',
      output: 'TAP version 13\nnot ok 1 - partial',
      cause: /no top-level plan/,
    },
    {
      label: 'incomplete',
      output: 'TAP version 13\nnot ok 1 - partial\n1..2\n# fail 1',
      cause: /records do not match the top-level plan/,
    },
    {
      label: 'ambiguous',
      output: 'TAP version 13\nnot ok 1 - partial\n1..1\n1..1\n# fail 1',
      cause: /multiple top-level plans/,
    },
    {
      label: 'contradictory summary',
      output: 'TAP version 13\nnot ok 1 - partial\n1..1\n# fail 0',
      cause: /failure summary does not match/,
    },
  ])('fails closed for $label TAP', async ({ output, cause }) => {
    const baseline = await baselineFor({ exitCode: 1, stdout: output });
    const result = testResult(baseline);

    expect(result).toMatchObject({
      failureIdentifiers: [],
      failureIdentity: 'unknown',
      reason: expect.stringMatching(cause),
    });
    expect(result.failureCount).toBeUndefined();
    expect(baseline.gateCriteria.find(({ role }) => role === 'test')?.description)
      .toContain(result.reason);
  });

  it('retains a structural TAP cause while using complete line-oriented evidence from the full buffer', async () => {
    const baseline = await baselineFor({
      exitCode: 1,
      stdout: 'TAP version 13\nnot ok 1 - incomplete TAP record\nFAIL spec/recovered.test.ts',
    });
    const result = testResult(baseline);

    expect(result).toMatchObject({
      failureCount: 1,
      failureIdentifiers: ['spec/recovered.test.ts'],
      failureIdentity: 'known',
      failureEvidence: 'complete',
      reason: expect.stringMatching(/recovered.*structural TAP.*no top-level plan/i),
    });
    expect(baseline.gateCriteria.find(({ role }) => role === 'test')?.description)
      .toMatch(/no top-level plan/);
  });

  it('does not claim known-zero failures when a nonzero command emits complete passing TAP', async () => {
    const baseline = await baselineFor({
      exitCode: 1,
      stdout: 'TAP version 13\nok 1 - reported pass\n1..1\n# fail 0',
    });
    const result = testResult(baseline);

    expect(result).toMatchObject({
      failureIdentifiers: [],
      failureIdentity: 'unknown',
      reason: expect.stringContaining('no failing top-level records despite the nonzero exit'),
    });
    expect(result.failureCount).toBeUndefined();
    expect(baseline.gateCriteria.find(({ role }) => role === 'test')?.description)
      .toContain(result.reason);
  });
});
