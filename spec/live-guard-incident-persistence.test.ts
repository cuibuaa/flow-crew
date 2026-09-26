import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LiveConstraintGuard,
  resolvePersistedLiveConstraintIncident,
  type LiveConstraintIncident,
} from '../src/live-constraint-guard.js';

// Run 2026-09-26T04-55-39-131f79: one fallback scan reported 12,888 paths and
// every persisted incident embedded the same ~1.8 MB instruction naming all of
// them, so the incident file reached 23 GB and the synchronous appends stalled
// the scheduler. These cases pin the persisted size to the incident count.

let projectDir: string;
let stateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-incident-persist-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-incident-persist-state-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

async function runOneScan(paths: readonly string[]) {
  const aborts: string[] = [];
  let emitted = false;
  let instructionCalls = 0;
  const guard = new LiveConstraintGuard({
    projectDir,
    runDir: stateDir,
    stageId: 'writer',
    attemptIndex: 1,
    effectiveScope: () => ['src/allowed.ts'],
    fallbackScanMs: 1_000,
    monitorDeadlineMs: 100,
    watchProject: () => undefined,
    scanAndRestore: () => {
      if (emitted) return { scannedPaths: paths.length, violations: [] };
      emitted = true;
      return {
        scannedPaths: paths.length,
        violations: paths.map((path) => ({
          path,
          reason: 'outside scope',
          restored: false,
          entryKind: 'untracked' as const,
        })),
      };
    },
    scopeRevisionInstruction: (violating) => {
      instructionCalls += 1;
      return `revise:${JSON.stringify(violating)}`;
    },
  });
  const monitor = guard.beginInvocation(1, (reason) => aborts.push(reason));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  const result = await monitor.finish();
  return { result, aborts, instructionCalls };
}

function stageFiles(): string[] {
  return readdirSync(join(stateDir, 'stages', 'writer')).sort();
}

describe('live constraint incident persistence', () => {
  it('stores a many-path scan in space linear in its incident count', async () => {
    const paths = Array.from({ length: 2_000 }, (_, index) => `node_modules/pkg-${index}/index.js`);
    const { result, aborts } = await runOneScan(paths);

    expect(aborts).toContain('live_constraint_rollback_failure');
    expect(result.incidents).toHaveLength(2_000);
    const instruction = result.incidents[0].scopeRevisionInstruction!;
    expect(instruction.length).toBeGreaterThan(60_000);
    expect(result.incidents.every((incident) => incident.scopeRevisionInstruction === instruction)).toBe(true);

    const files = stageFiles();
    const sidecars = files.filter((name) => name.startsWith('live_constraint_instruction_'));
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(stateDir, 'stages', 'writer', sidecars[0]), 'utf-8')).toBe(instruction);

    const incidentPath = join(stateDir, 'stages', 'writer', 'live_constraint_incidents_attempt_1.jsonl');
    // Embedding the instruction per incident would cost 2,000 × its length.
    expect(statSync(incidentPath).size).toBeLessThan(2_000 * 1_500);
    const lines = readFileSync(incidentPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2_000);
    const persisted = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('scopeRevisionInstruction');
    expect(persisted.scopeRevisionInstructionRef).toMatchObject({ bytes: Buffer.byteLength(instruction, 'utf-8') });
  });

  it('restores the exact instruction bytes when a persisted incident is read back', async () => {
    const { result } = await runOneScan(['config/defaults.yaml', 'README.md']);
    const stageDir = join(stateDir, 'stages', 'writer');
    const lines = readFileSync(join(stageDir, 'live_constraint_incidents_attempt_1.jsonl'), 'utf-8').trim().split('\n');
    const restored = lines.map((line) => resolvePersistedLiveConstraintIncident(stageDir, JSON.parse(line) as LiveConstraintIncident));
    expect(restored.map((incident) => incident.scopeRevisionInstruction))
      .toEqual(result.incidents.map((incident) => incident.scopeRevisionInstruction));
    expect(restored[0]).not.toHaveProperty('scopeRevisionInstructionRef');
  });

  it('still reads an older record that carries its instruction inline', () => {
    const stageDir = join(stateDir, 'stages', 'writer');
    const legacy = { kind: 'live_constraint_incident', path: 'a.ts', scopeRevisionInstruction: 'inline text' } as unknown as LiveConstraintIncident;
    expect(resolvePersistedLiveConstraintIncident(stageDir, legacy).scopeRevisionInstruction).toBe('inline text');
  });

  it('leaves the instruction absent when its stored text no longer matches the reference', async () => {
    await runOneScan(['config/defaults.yaml']);
    const stageDir = join(stateDir, 'stages', 'writer');
    const sidecar = stageFiles().find((name) => name.startsWith('live_constraint_instruction_'))!;
    const line = readFileSync(join(stageDir, 'live_constraint_incidents_attempt_1.jsonl'), 'utf-8').trim();
    const record = JSON.parse(line) as LiveConstraintIncident;
    rmSync(join(stageDir, sidecar));
    expect(resolvePersistedLiveConstraintIncident(stageDir, record).scopeRevisionInstruction).toBeUndefined();
  });
});
