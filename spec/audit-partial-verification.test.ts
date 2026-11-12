import { validationReport } from './test-support/structured-validation.js';
import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateValidationDelta,
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
  type ValidationRunResponse,
} from '../src/project-validation.js';
import {
  readShipSetupReadyValidationBaseline,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';

const encoded = (id: string) => JSON.stringify([id, 'case.test', 'test-failure']);
const portableProject = resolve('portable-partial-evidence-audit');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function baselineFor(
  response: ValidationRunResponse,
  options: { projectDir?: string; maxOutputBytes?: number; ids?: string[]; complete?: boolean } = {},
): Promise<ProjectValidationBaseline> {
  return runProjectValidationBaseline(options.projectDir ?? portableProject, {
    fs: {
      exists: () => false,
      readText: (path) => { throw new Error(`unexpected fixture read: ${path}`); },
    },
    declaredCommands: [{
      role: 'test',
      command: 'fixture-test',
      args: [],
      evidencePath: 'portable-brief.md#validation.commands.test',
      ...(options.ids ? { report: { format: 'vitest-json' as const } } : {}),
    }],
    runCommand: () => ({ ...response, ...(options.ids ? { report: validationReport(options.ids, { complete: options.complete }) } : {}) }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
}

function testResult(baseline: ProjectValidationBaseline): ValidationCommandResult {
  const result = baseline.results.find(({ role }) => role === 'test');
  if (!result) throw new Error('portable baseline omitted its test result');
  return result;
}

function testDelta(
  baseline: ProjectValidationBaseline,
  current: ValidationCommandResult,
) {
  const delta = evaluateValidationDelta(baseline, [current]).find(({ role }) => role === 'test');
  if (!delta) throw new Error('portable comparison omitted its test delta');
  return delta;
}

describe('partial failure evidence audit', () => {
  it('recovers the retained Vitest-shaped identity and count as explicitly partial evidence', async () => {
    const identifier = 'spec/portable-scenario.test.ts > Scenario A: retained failure identity';
    const output = [
      '[... 512 earlier bytes omitted ...]',
      `FAIL  ${identifier}`,
      'Test Files  1 failed | 158 passed (159)',
      'Tests  1 failed | 1665 passed | 4 skipped (1670)',
    ].join('\n');

    const baseline = await baselineFor({ exitCode: 1, stdout: output }, { ids: [identifier], complete: false });
    const result = testResult(baseline);

    expect(result).toMatchObject({
      state: 'failed',
      failureIdentity: 'known',
      failureEvidence: 'partial',
      failureIdentifiers: [encoded(identifier)],
      failureCount: 1,
      reason: expect.stringContaining('partial'),
    });
    expect(testDelta(baseline, result)).toMatchObject({ state: 'unverified' });
  });

  it('keeps a count-only line unknown without a permitted identity owner', async () => {
    const result = testResult(await baselineFor({
      exitCode: 1,
      stdout: '[... 128 earlier bytes omitted ...]\nTests 4 failed | 20 passed (24)',
    }));

    expect(result).toMatchObject({
      failureIdentity: 'unknown',
      failureIdentifiers: [],
      reason: expect.stringContaining('No declared structured reporter'),
    });
  });

  it('bounds opaque TAP display while a declared partial reporter keeps identity partial', async () => {
    const rawOutput = [
      'TAP version 13',
      'not ok 1 - actual failure',
      'not ok 2 - future work # TODO later',
      'ok 3 - unavailable # SKIP platform',
      `# ${'diagnostic '.repeat(400)}`,
      '1..3',
      '# fail 1',
    ].join('\n');

    const result = testResult(await baselineFor(
      { exitCode: 1, stdout: rawOutput },
      { maxOutputBytes: 128, ids: ['actual failure'], complete: false },
    ));

    expect(result).toMatchObject({
      failureIdentity: 'known',
      failureEvidence: 'partial',
      failureIdentifiers: [encoded('actual failure')],
      failureCount: 1,
    });
    expect(result.reason).toContain('partial');
    expect(result.output).toMatch(/^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]/);
  });

  it('uses declared complete reporters independently of three opaque display formats', async () => {
    const cases = [
      {
        output: 'FAIL  spec/existing.test.ts > exact case\nTests 1 failed',
        identifier: 'spec/existing.test.ts > exact case',
      },
      { output: '× exact cross-marked case 7ms', identifier: 'exact cross-marked case' },
      {
        output: 'src/example.ts:12:4 - error TS2322: Type mismatch',
        identifier: 'src/example.ts TS2322',
      },
    ];

    for (const fixture of cases) {
      const result = testResult(await baselineFor({ exitCode: 1, stdout: fixture.output }, { ids: [fixture.identifier] }));
      expect(result, fixture.identifier).toMatchObject({
        failureIdentity: 'known',
        failureEvidence: 'complete',
        failureIdentifiers: [encoded(fixture.identifier)],
        failureCount: 1,
      });
      expect(result.reason, fixture.identifier).toBeUndefined();
    }
  });

  it('keeps each unknown cause distinct and operator-visible', async () => {
    const cases: Array<{ label: string; response: ValidationRunResponse; cause: RegExp }> = [
      { label: 'no output', response: { exitCode: 1 }, cause: /produced no output/ },
      {
        label: 'truncated without line facts',
        response: {
          exitCode: 1,
          stdout: '[... 128 earlier bytes omitted ...]\nTAP version 13\nnot ok 1 - partial',
        },
        cause: /truncated before parsing/,
      },
      {
        label: 'structurally incomplete TAP',
        response: { exitCode: 1, stdout: 'TAP version 13\nnot ok 1 - incomplete' },
        cause: /structurally incomplete.*no top-level plan/i,
      },
      {
        label: 'complete TAP without a failing record',
        response: { exitCode: 1, stdout: 'TAP version 13\nok 1 - pass\n1..1\n# fail 0' },
        cause: /no failing top-level records/,
      },
      {
        label: 'unrecognized format',
        response: { exitCode: 1, stderr: 'custom runner stopped unexpectedly' },
        cause: /non-TAP output format is not recognized/,
      },
    ];

    expect(cases).toHaveLength(5);
    for (const fixture of cases) {
      const baseline = await baselineFor(fixture.response);
      const result = testResult(baseline);
      expect(result, fixture.label).toMatchObject({
        failureIdentity: 'unknown',
        failureIdentifiers: [],
        reason: expect.stringContaining('No declared structured reporter'),
      });
      expect(result.failureCount, fixture.label).toBeUndefined();
      expect(result.failureEvidence, fixture.label).toBeUndefined();
    }
  });

  it('records every partial or complete red result as unverified without a causal comparison', async () => {
    const partialBaseline = await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/existing.test.ts\nTests 1 failed',
    }, { ids: ['spec/existing.test.ts'], complete: false });
    const completeBaseline = await baselineFor({
      exitCode: 1,
      stdout: 'FAIL spec/existing.test.ts\nTests 1 failed',
    }, { ids: ['spec/existing.test.ts'] });
    const unknownBaseline = await baselineFor({ exitCode: 1, stdout: 'opaque stop' });
    const greenBaseline = await baselineFor({ exitCode: 0 });
    const partialCurrent = testResult(await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/new.test.ts\nTests 1 failed',
    }, { ids: ['spec/new.test.ts'], complete: false }));
    const completeSame = testResult(completeBaseline);
    const completeNew = testResult(await baselineFor({
      exitCode: 1,
      stdout: 'FAIL spec/new.test.ts\nTests 1 failed',
    }, { ids: ['spec/new.test.ts'] }));
    const completeCountIncrease = { ...completeSame, failureCount: 2 };
    const passed: ValidationCommandResult = {
      role: 'test', state: 'passed', exitCode: 0, durationMs: 1, output: '',
      failureIdentifiers: [], failureIdentity: 'none',
    };

    const unlaunched = { role: 'test' as const, state: 'failed' as const, exitCode: 127, durationMs: 1,
      output: 'sh: karma: not found', failureIdentifiers: [], failureIdentity: 'unknown' as const };
    for (const base of [partialBaseline, completeBaseline, unknownBaseline, greenBaseline, { ...unknownBaseline, results: [unlaunched] }]) {
      for (const current of [partialCurrent, completeSame, completeNew, completeCountIncrease, unlaunched, testResult(unknownBaseline)]) {
        expect(testDelta(base, current)).toMatchObject({ state: 'unverified', newFailureIdentifiers: [] });
      }
      expect(testDelta(base, passed)).toMatchObject({ state: 'verified' });
    }
  });

  it('round-trips partial and legacy records while rejecting inconsistent completeness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'partial-evidence-record-audit-'));
    temporaryRoots.push(root);
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    const canonicalProject = realpathSync.native(projectDir);
    const brief = '# Portable exact brief\n';
    const briefDigest = shipSetupBriefDigest(brief);
    const recordPath = shipSetupReadyRecordPath(canonicalProject, briefDigest, globalRoot);
    const partial = await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/retained.test.ts\nTests 1 failed',
    }, { projectDir: canonicalProject, ids: ['spec/retained.test.ts'], complete: false });
    const writeRecord = (validationBaseline: ProjectValidationBaseline) => {
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, `${JSON.stringify({
        version: 1,
        state: 'ready',
        ready: true,
        targetCanonicalDir: canonicalProject,
        briefDigest,
        readyRecordPath: recordPath,
        validationBaseline,
      })}\n`, 'utf-8');
    };

    writeRecord(partial);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toEqual(partial);

    const legacy = structuredClone(partial);
    delete testResult(legacy).failureEvidence;
    // Older receipts carried causal criteria; readers ignore them and decide nothing from them.
    legacy.gateCriteria = [{ role: 'test', rule: 'no_regression_from_baseline', baselineFailureIdentifiers: [], description: 'Historical criterion' }];
    writeRecord(legacy);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toEqual(legacy);

    const causeless = structuredClone(partial);
    delete testResult(causeless).reason;
    writeRecord(causeless);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toBeUndefined();
  });

});
