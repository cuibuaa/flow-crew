import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectValidationBaseline } from '../src/project-validation.js';
import {
  readShipSetupReadyValidationBaseline,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baseline(projectDir: string): ProjectValidationBaseline {
  return {
    version: 1,
    projectDir,
    discovery: {
      state: 'partial',
      configPath: join(projectDir, 'pyproject.toml'),
      commands: [{
        role: 'test', command: 'python', args: ['-m', 'pytest', 'tests'], display: 'python -m pytest tests',
      }],
      missingRoles: ['build', 'lint'],
    },
    results: [{
      role: 'test', display: 'python -m pytest tests', state: 'failed', exitCode: 1,
      durationMs: 1, output: '', failureCount: 1,
      failureIdentifiers: ['tests/test_one.py::test_known'], failureIdentity: 'known',
    }],
    gateCriteria: [{
      role: 'test', rule: 'no_regression_from_baseline', baselineFailureCount: 1,
      baselineFailureIdentifiers: ['tests/test_one.py::test_known'],
      description: 'test may not regress from the recorded identity',
    }],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ship-record-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const globalRoot = join(root, 'fc-home');
  mkdirSync(projectDir);
  const canonicalTarget = realpathSync.native(projectDir);
  const brief = '# Exact brief\n';
  const briefDigest = shipSetupBriefDigest(brief);
  const recordPath = shipSetupReadyRecordPath(canonicalTarget, briefDigest, globalRoot);
  const validationBaseline = baseline(canonicalTarget);
  const record = {
    version: 1,
    state: 'ready',
    ready: true,
    projectDir: canonicalTarget,
    targetDir: canonicalTarget,
    targetCanonicalDir: canonicalTarget,
    briefPath: join(projectDir, 'brief.md'),
    briefDigest,
    readyRecordPath: recordPath,
    validationBaseline,
  };
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, 'utf-8');
  return { projectDir, globalRoot, brief, recordPath, record, validationBaseline };
}

describe('ship-setup ready-record baseline reader', () => {
  it('loads only the exact canonical-target and exact-brief ready record', () => {
    const item = fixture();
    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toEqual(item.validationBaseline);
    expect(item.validationBaseline.results[0].failureEvidence).toBeUndefined();
    expect(item.validationBaseline.gateCriteria[0].baselineFailureEvidence).toBeUndefined();
    expect(readShipSetupReadyValidationBaseline(item.projectDir, `${item.brief}\n`, item.globalRoot))
      .toBeUndefined();
  });

  it('round-trips the recorded cause of an unknown failed baseline', () => {
    const item = fixture();
    const result = item.validationBaseline.results[0];
    result.failureIdentifiers = [];
    result.failureIdentity = 'unknown';
    result.reason = 'Failure identity is unavailable because the non-TAP output format is not recognized';
    delete result.failureCount;
    item.validationBaseline.gateCriteria[0].baselineFailureIdentifiers = [];
    delete item.validationBaseline.gateCriteria[0].baselineFailureCount;
    item.validationBaseline.gateCriteria[0].description = `test remains unresolved. ${result.reason}`;
    writeFileSync(item.recordPath, `${JSON.stringify(item.record)}\n`, 'utf-8');

    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toEqual(item.validationBaseline);
  });

  it('round-trips partial known evidence and its matching gate marker', () => {
    const item = fixture();
    const result = item.validationBaseline.results[0];
    result.failureEvidence = 'partial';
    result.reason = 'Failure identity was recovered from retained lines after output truncation';
    item.validationBaseline.gateCriteria[0].baselineFailureEvidence = 'partial';
    item.validationBaseline.gateCriteria[0].description = 'retained identities are a lower bound';
    writeFileSync(item.recordPath, `${JSON.stringify(item.record)}\n`, 'utf-8');

    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toEqual(item.validationBaseline);
  });

  it.each([
    ['partial result without a cause', (item: ReturnType<typeof fixture>) => {
      item.validationBaseline.results[0].failureEvidence = 'partial';
      item.validationBaseline.gateCriteria[0].baselineFailureEvidence = 'partial';
    }],
    ['result and criterion evidence mismatch', (item: ReturnType<typeof fixture>) => {
      item.validationBaseline.results[0].failureEvidence = 'complete';
      item.validationBaseline.gateCriteria[0].baselineFailureEvidence = 'partial';
    }],
    ['evidence marker on an unknown result', (item: ReturnType<typeof fixture>) => {
      const result = item.validationBaseline.results[0];
      result.failureIdentity = 'unknown';
      result.failureEvidence = 'partial';
      result.reason = 'unavailable';
      item.validationBaseline.gateCriteria[0].baselineFailureEvidence = 'partial';
    }],
  ])('rejects inconsistent failure evidence: %s', (_label, mutate) => {
    const item = fixture();
    mutate(item);
    writeFileSync(item.recordPath, `${JSON.stringify(item.record)}\n`, 'utf-8');

    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toBeUndefined();
  });

  it.each([
    ['record version mismatch', (record: Record<string, unknown>) => { record.version = 2; }],
    ['not ready', (record: Record<string, unknown>) => { record.state = 'refused'; }],
    ['target mismatch', (record: Record<string, unknown>) => { record.targetCanonicalDir = '/another/project'; }],
    ['brief mismatch', (record: Record<string, unknown>) => { record.briefDigest = '0'.repeat(64); }],
    ['baseline target mismatch', (record: Record<string, unknown>) => {
      (record.validationBaseline as Record<string, unknown>).projectDir = '/another/project';
    }],
  ])('fails closed for %s', (_label, mutate) => {
    const item = fixture();
    mutate(item.record);
    writeFileSync(item.recordPath, `${JSON.stringify(item.record)}\n`, 'utf-8');
    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toBeUndefined();
  });

  it('fails closed for malformed JSON and malformed baseline shapes', () => {
    const item = fixture();
    writeFileSync(item.recordPath, '{', 'utf-8');
    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toBeUndefined();
    writeFileSync(item.recordPath, JSON.stringify({ ...item.record, validationBaseline: { version: 1 } }), 'utf-8');
    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toBeUndefined();
  });

  it('rejects a non-string validation result reason', () => {
    const item = fixture();
    (item.validationBaseline.results[0] as unknown as Record<string, unknown>).reason = 42;
    writeFileSync(item.recordPath, `${JSON.stringify(item.record)}\n`, 'utf-8');

    expect(readShipSetupReadyValidationBaseline(item.projectDir, item.brief, item.globalRoot))
      .toBeUndefined();
  });
});
