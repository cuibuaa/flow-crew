import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { vitestReplayTests } from '../src/declared-replay-results.js';
import { readRecordedArtifactContract } from '../src/recorded-artifact-contract.js';
import { providerFailureFromEvent } from '../src/provider-result.js';

// Auditor-owned constructions use only disposable directories and the real
// collection/execution boundary. No recorded command, store or model is used.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-independent-contract-'));
  roots.push(root);
  const project = join(root, 'project'), run = join(root, 'run');
  mkdirSync(project); mkdirSync(run);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  return { root, project, run };
}
function contract(paths: string[], failures: Array<{ artifact: string; test: string }>, argv: string[] = []) {
  return ArtifactContractSchema.parse({
    version: 1, produces: [],
    reads: paths.map((path, index) => ({ id: `input_${index}`, root: 'project', path, source: { kind: 'input' } })),
    replays: [{ id: 'independent', runner: 'node_test', targets: paths.map((_, index) => `input_${index}`),
      argv, expected: { exit_code: failures.length ? 1 : 0, failures } }],
  });
}
async function replay(f: ReturnType<typeof fixture>, c: ReturnType<typeof contract>) {
  const deadline = performance.now() + 15_000;
  return verifyStageArtifactContract({ stageId: 'audit', template: 'Read the declared evidence.',
    projectDir: f.project, runDir: f.run, artifactContract: c }, { remainingMs: () => deadline - performance.now() });
}
function failing(name: string) {
  return `import {test} from 'node:test';import assert from 'node:assert/strict';test(${JSON.stringify(name)},()=>assert.equal(1,2));\n`;
}

describe('independent declared replay boundaries', () => {
  it('executes a quoted space and unicode filename as one exact argv target', async () => {
    const f = fixture(), path = "case ' ; café.test.mjs", title = 'évidence 日本語';
    writeFileSync(join(f.project, path), failing(title));
    const result = await replay(f, contract([path], [{ artifact: 'input_0', test: title }]));
    expect(result.replayExecutions[0]).toMatchObject({ status: 'passed', exitCode: 1, executedTests: 1 });
  });
  it('refuses a canonically different unicode failure identity', async () => {
    const f = fixture(), title = 'café';
    writeFileSync(join(f.project, 'case.test.mjs'), failing(title));
    const result = await replay(f, contract(['case.test.mjs'], [{ artifact: 'input_0', test: title.normalize('NFD') }]));
    expect(result.violations[0].reason).toContain('REPLAY_FAILURE_MISMATCH');
  });
  it('binds the same failing title in two files to two distinct artifact IDs', async () => {
    const f = fixture(), files = ['one.test.mjs', 'two.test.mjs'];
    for (const file of files) writeFileSync(join(f.project, file), failing('same title'));
    const result = await replay(f, contract(files, files.map((_, index) => ({ artifact: `input_${index}`, test: 'same title' }))));
    expect(result.replayExecutions[0]).toMatchObject({ status: 'passed', failedTests: 2, executedTests: 2 });
  });
  it('refuses duplicate leaf titles in distinct Node suites rather than guessing the failure', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'case.test.mjs'), "import{describe,it}from'node:test';import assert from'node:assert/strict';describe('left',()=>it('same',()=>assert.equal(1,2)));describe('right',()=>it('same',()=>assert.equal(1,1)));\n");
    const result = await replay(f, contract(['case.test.mjs'], [{ artifact: 'input_0', test: 'same' }]));
    expect(result.violations[0].reason).toContain('ambiguous');
  });
  it('refuses an expected failure selected away by the declared name pattern', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'case.test.mjs'), failing('required failure') + "test('other success',()=>assert.equal(1,1));\n");
    const result = await replay(f, contract(['case.test.mjs'], [{ artifact: 'input_0', test: 'required failure' }], ['--test-name-pattern', '^other success$']));
    expect(result.violations[0].reason).toContain('REPLAY_EXIT_MISMATCH');
  });
  it('refuses a replay read that physically resolves outside its declared root', async () => {
    const f = fixture(), outside = join(f.root, 'outside.test.mjs');
    writeFileSync(outside, failing('outside'));
    symlinkSync(outside, join(f.project, 'case.test.mjs'));
    await expect(replay(f, contract(['case.test.mjs'], [{ artifact: 'input_0', test: 'outside' }]))).rejects.toThrow('ARTIFACT_PATH_ESCAPE');
  });
});

describe('independent evidence readers', () => {
  function vitestRecord(file: string) {
    return { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0,
      testResults: [{ name: file, assertionResults: [{ fullName: 'failure', status: 'failed' }] }] };
  }
  it('refuses a parseable Vitest report whose totals contradict its named assertions', () => {
    const file = join(fixture().project, 'case.test.ts'), value = vitestRecord(file);
    value.numTotalTests = 2;
    expect(vitestReplayTests(JSON.stringify(value), [file]).get(file)?.error).toContain('totals');
  });
  it('refuses a Vitest report substituting a neighbouring file with the same test title', () => {
    const f = fixture(), target = join(f.project, 'case.test.ts');
    expect(vitestReplayTests(JSON.stringify(vitestRecord(join(f.project, 'decoy.test.ts'))), [target]).get(target)?.error).toContain('unbound');
  });
  it('keeps old command-looking replay records readable without executing them', () => {
    const f = fixture(), marker = join(f.project, 'marker'), path = join(f.run, 'artifact_contract.json');
    const record = { version: 1, stageId: 'old', checkedAt: '2026-01-01T00:00:00Z', obligations: [],
      producedPromptArtifacts: [], violations: [], replayExecutions: [{ command: `touch ${marker}`, exitCode: 1 }],
      extension: { oldData: ['retain', null] } };
    writeFileSync(path, JSON.stringify(record));
    const bytes = readFileSync(path);
    expect(readRecordedArtifactContract(path)).toEqual({ status: 'readable', legacy: true, record });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
  });
});

describe('independent provider attribution', () => {
  const refusal = 'This content was flagged for possible cybersecurity risk.';
  it('ignores native-looking diagnostics inside assistant/tool records', () => {
    const nested = { type: 'item.completed', item: { type: 'agent_message', text: refusal,
      error: { type: 'turn.failed', message: refusal } } };
    expect(providerFailureFromEvent('codex', nested)).toBeUndefined();
  });
  it('redacts display credentials while preserving the original terminal diagnostic hash', () => {
    const message = `${refusal} authorization=synthetic-only-token`;
    const result = providerFailureFromEvent('codex', { type: 'turn.failed', error: { message } });
    expect(result).toMatchObject({ kind: 'refusal', reason: `${refusal} authorization=[redacted]`,
      diagnosticSha256: createHash('sha256').update(message).digest('hex') });
  });
});
