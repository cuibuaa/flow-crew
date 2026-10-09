import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';


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
describe('historical replay observations', () => {
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
