import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNode, readKG } from '../src/knowledge-graph.js';
import { runDir } from '../src/store.js';

const roots: string[] = [];
const sharedRunId = 'verify-m1-shared-run-id';

function tempProject(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `verify-m1-${label}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(runDir(root, sharedRunId), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

describe('regression probe: KG and terminal artifacts are isolated by test cleanup', () => {
  it('does not carry KG or terminal artifacts into a later test using the same run id', () => {
    const firstProject = tempProject('first');
    addNode(firstProject, sharedRunId, { type: 'goal', label: 'stale goal' });
    mkdirSync(runDir(firstProject, sharedRunId), { recursive: true });
    writeFileSync(join(runDir(firstProject, sharedRunId), 'verdict_terminal_gate.json'), '{"pass":true}\n', 'utf-8');

    const secondProject = tempProject('second');
    rmSync(runDir(secondProject, sharedRunId), { recursive: true, force: true });

    expect(readKG(secondProject, sharedRunId).nodes).toHaveLength(0);
    expect(existsSync(join(runDir(secondProject, sharedRunId), 'verdict_terminal_gate.json'))).toBe(false);
  });
});
