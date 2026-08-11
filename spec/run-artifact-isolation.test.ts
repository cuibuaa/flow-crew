import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addNode, readKG } from '../src/knowledge-graph.js';
import { runDir } from '../src/store.js';

const roots: string[] = [];
const runArtifacts: Array<{ projectDir: string; runId: string }> = [];
const sharedRunId = 'artifact-isolation-shared-run-id';

function tempProject(label: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), `flowcrew-artifact-isolation-${label}-`));
  roots.push(projectDir);
  return projectDir;
}

function trackRun(projectDir: string, runId: string): void {
  runArtifacts.push({ projectDir, runId });
}

afterEach(() => {
  for (const { projectDir, runId } of runArtifacts.splice(0)) {
    rmSync(runDir(projectDir, runId), { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('run artifact isolation', () => {
  it('does not carry KG or terminal artifacts into a later test using the same run id', () => {
    const firstProject = tempProject('first');
    trackRun(firstProject, sharedRunId);
    addNode(firstProject, sharedRunId, { type: 'goal', label: 'stale goal' });
    mkdirSync(runDir(firstProject, sharedRunId), { recursive: true });
    writeFileSync(join(runDir(firstProject, sharedRunId), 'verdict_terminal_gate.json'), '{"pass":true}\n', 'utf-8');

    const secondProject = tempProject('second');
    trackRun(secondProject, sharedRunId);
    rmSync(runDir(secondProject, sharedRunId), { recursive: true, force: true });

    expect(readKG(secondProject, sharedRunId).nodes).toHaveLength(0);
    expect(existsSync(join(runDir(secondProject, sharedRunId), 'verdict_terminal_gate.json'))).toBe(false);
  });

  it('keeps simultaneous KG and terminal artifacts isolated by unique run id', () => {
    const projectDir = tempProject('simultaneous');
    const firstRunId = `artifact-isolation-a-${randomBytes(6).toString('hex')}`;
    const secondRunId = `artifact-isolation-b-${randomBytes(6).toString('hex')}`;
    trackRun(projectDir, firstRunId);
    trackRun(projectDir, secondRunId);

    addNode(projectDir, firstRunId, { type: 'goal', label: 'first run only' });
    addNode(projectDir, secondRunId, { type: 'goal', label: 'second run only' });
    writeFileSync(join(runDir(projectDir, firstRunId), 'verdict_terminal_gate.json'), '{"pass":true}\n', 'utf-8');

    expect(readKG(projectDir, firstRunId).nodes.map((node) => node.label)).toEqual(['first run only']);
    expect(readKG(projectDir, secondRunId).nodes.map((node) => node.label)).toEqual(['second run only']);
    expect(existsSync(join(runDir(projectDir, secondRunId), 'verdict_terminal_gate.json'))).toBe(false);
  });
});
