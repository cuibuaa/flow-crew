import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addNode, readKG } from '../src/knowledge-graph.js';
import { runDir } from '../src/store.js';

describe('re-evaluation KG/terminal isolation probe', () => {
  it('keeps simultaneous KG and terminal artifacts isolated by unique run id', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'm1-reeval-kg-'));
    const firstRunId = `m1-reeval-a-${randomBytes(6).toString('hex')}`;
    const secondRunId = `m1-reeval-b-${randomBytes(6).toString('hex')}`;

    try {
      addNode(projectDir, firstRunId, { type: 'goal', label: 'first run only' });
      addNode(projectDir, secondRunId, { type: 'goal', label: 'second run only' });
      writeFileSync(join(runDir(projectDir, firstRunId), 'verdict_terminal_gate.json'), '{"pass":true}\n', 'utf-8');

      expect(readKG(projectDir, firstRunId).nodes.map((node) => node.label)).toEqual(['first run only']);
      expect(readKG(projectDir, secondRunId).nodes.map((node) => node.label)).toEqual(['second run only']);
      expect(existsSync(join(runDir(projectDir, secondRunId), 'verdict_terminal_gate.json'))).toBe(false);
    } finally {
      rmSync(runDir(projectDir, firstRunId), { recursive: true, force: true });
      rmSync(runDir(projectDir, secondRunId), { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
