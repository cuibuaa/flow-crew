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
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import {
  readShipSetupReadyValidationBaseline,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';

const portableProject = resolve('portable-partial-evidence-audit');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function baselineFor(
  response: ValidationRunResponse,
  options: { projectDir?: string; maxOutputBytes?: number } = {},
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
    }],
    runCommand: () => response,
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

    const baseline = await baselineFor({ exitCode: 1, stdout: output });
    const result = testResult(baseline);
    const criterion = baseline.gateCriteria.find(({ role }) => role === 'test');

    expect(result).toMatchObject({
      state: 'failed',
      failureIdentity: 'known',
      failureEvidence: 'partial',
      failureIdentifiers: [identifier],
      failureCount: 1,
      reason: expect.stringMatching(/recovered.*partial.*truncated/i),
    });
    expect(criterion).toMatchObject({
      rule: 'no_regression_from_baseline',
      baselineFailureEvidence: 'partial',
      baselineFailureIdentifiers: [identifier],
      baselineFailureCount: 1,
      description: expect.stringMatching(/lower bound.*not a proven whole-run count.*unresolved/i),
    });
    expect(testDelta(baseline, result)).toMatchObject({ state: 'unresolved' });
  });

  it('marks a count-only fact recovered after truncation as observed partial evidence', async () => {
    const result = testResult(await baselineFor({
      exitCode: 1,
      stdout: '[... 128 earlier bytes omitted ...]\nTests 4 failed | 20 passed (24)',
    }));

    expect(result).toMatchObject({
      failureIdentity: 'known',
      failureEvidence: 'partial',
      failureIdentifiers: [],
      failureCount: 4,
      reason: expect.stringContaining('truncated'),
    });
  });

  it('keeps complete TAP complete even when only its separately persisted output is bounded', async () => {
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
      { maxOutputBytes: 128 },
    ));

    expect(result).toMatchObject({
      failureIdentity: 'known',
      failureEvidence: 'complete',
      failureIdentifiers: ['actual failure'],
      failureCount: 1,
    });
    expect(result.reason).toBeUndefined();
    expect(result.output).toMatch(/^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]/);
  });

  it('keeps all three untruncated line-oriented formats complete', async () => {
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
      const result = testResult(await baselineFor({ exitCode: 1, stdout: fixture.output }));
      expect(result, fixture.identifier).toMatchObject({
        failureIdentity: 'known',
        failureEvidence: 'complete',
        failureIdentifiers: [fixture.identifier],
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
      const criterion = baseline.gateCriteria.find(({ role }) => role === 'test');
      expect(result, fixture.label).toMatchObject({
        failureIdentity: 'unknown',
        failureIdentifiers: [],
        reason: expect.stringMatching(fixture.cause),
      });
      expect(result.failureCount, fixture.label).toBeUndefined();
      expect(result.failureEvidence, fixture.label).toBeUndefined();
      expect(criterion?.description, fixture.label).toContain(result.reason);
    }
  });

  it('preserves decisive transitions and refuses every red-to-red partial comparison', async () => {
    const partialBaseline = await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/existing.test.ts\nTests 1 failed',
    });
    const completeBaseline = await baselineFor({
      exitCode: 1,
      stdout: 'FAIL spec/existing.test.ts\nTests 1 failed',
    });
    const unknownBaseline = await baselineFor({ exitCode: 1, stdout: 'opaque stop' });
    const greenBaseline = await baselineFor({ exitCode: 0 });
    const partialCurrent = testResult(await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/new.test.ts\nTests 1 failed',
    }));
    const completeSame = testResult(completeBaseline);
    const completeNew = testResult(await baselineFor({
      exitCode: 1,
      stdout: 'FAIL spec/new.test.ts\nTests 1 failed',
    }));
    const completeCountIncrease = { ...completeSame, failureCount: 2 };
    const passed: ValidationCommandResult = {
      role: 'test', state: 'passed', exitCode: 0, durationMs: 1, output: '',
      failureIdentifiers: [], failureIdentity: 'none',
    };

    expect(testDelta(partialBaseline, completeNew)).toMatchObject({ state: 'unresolved' });
    expect(testDelta(completeBaseline, partialCurrent)).toMatchObject({ state: 'unresolved' });
    expect(testDelta(unknownBaseline, completeNew)).toMatchObject({
      state: 'unresolved', reason: 'Baseline failure identity/count was unavailable',
    });
    expect(testDelta(completeBaseline, completeSame)).toMatchObject({ state: 'pass' });
    expect(testDelta(completeBaseline, completeNew)).toMatchObject({
      state: 'regression', newFailureIdentifiers: ['spec/new.test.ts'],
    });
    expect(testDelta(completeBaseline, completeCountIncrease)).toMatchObject({
      state: 'regression', reason: 'Known failure count increased',
    });
    expect(testDelta(greenBaseline, partialCurrent)).toMatchObject({ state: 'regression' });
    expect(testDelta(partialBaseline, passed)).toMatchObject({ state: 'pass' });
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
    }, { projectDir: canonicalProject });
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
    delete legacy.gateCriteria.find(({ role }) => role === 'test')?.baselineFailureEvidence;
    writeRecord(legacy);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toEqual(legacy);

    const mismatch = structuredClone(partial);
    const mismatchCriterion = mismatch.gateCriteria.find(({ role }) => role === 'test');
    if (!mismatchCriterion) throw new Error('portable baseline omitted its test criterion');
    mismatchCriterion.baselineFailureEvidence = 'complete';
    writeRecord(mismatch);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toBeUndefined();

    const causeless = structuredClone(partial);
    delete testResult(causeless).reason;
    writeRecord(causeless);
    expect(readShipSetupReadyValidationBaseline(canonicalProject, brief, globalRoot)).toBeUndefined();
  });

  it('renders partial identities and counts as lower-bound observed evidence', async () => {
    const baseline = await baselineFor({
      exitCode: 1,
      stdout: '[... 64 earlier bytes omitted ...]\nFAIL spec/retained.test.ts\nTests 1 failed',
    });
    const brief = [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/final.md]',
      '---',
      '# Portable contract',
    ].join('\n');
    const checks = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: project validation remains acceptable',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: fixture-test',
      '```',
    ].join('\n');

    const report = inspectRealityChecks(brief, checks, { validationBaseline: baseline });
    const finding = report.blockingTierFindings.find(({ code }) => code === 'hard_check_cannot_pass');

    expect(finding?.message).toMatch(/partial failure evidence.*observed partial-evidence count of 1/i);
    expect(finding?.message).toMatch(/identities \(lower bound\).*red-to-red comparison must remain unresolved/i);
    expect(finding?.evidence).toContain('baseline_failure_evidence=partial');
    expect(finding?.evidence).toContain('baseline_observed_failure_count=1');
    expect(finding?.evidence).toContain('baseline_failure_identities_lower_bound=');
    expect(finding?.evidence).not.toContain('baseline_failure_count=');
  });
});
