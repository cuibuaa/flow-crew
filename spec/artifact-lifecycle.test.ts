import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { createRun, fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(kind: 'file' | 'directory' = 'file', isGate = false) {
  const root = mkdtempSync(join(tmpdir(), 'fc-artifact-life-')); roots.push(root);
  const projectDir = join(root, 'project'), runDir = join(root, 'run'); mkdirSync(projectDir); mkdirSync(runDir);
  const name = isGate ? 'verdict_work.json' : 'product';
  const input = { stageId: 'work', template: 'stable admitted duties', projectDir, runDir, isGate,
    artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'product', root: 'run', path: name, kind }], reads: [], replays: [] }) };
  return { input, target: join(runDir, name) };
}

describe('admitted-stage artifact production across executions', () => {
  it.each([0, 1])('accepts unchanged intermediate outputs after direct exit %s without replaying the old invocation', async (firstExit) => {
    const f = fixture(), previous = fcGlobalDir();
    setFcGlobalDir(join(f.input.runDir, 'store'));
    try {
      const created = createRun(f.input.projectDir, 'artifacts', 'name: artifacts', ['work']);
      const target = join(created.runDirPath, 'product');
      const role = { name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low' as const, tools: [], prompt: 'fixture' };
      const options = { stageId: 'work', role, dependsOn: [], promptTemplate: 'current invocation',
        artifactObligationTemplate: f.input.template, artifactContract: f.input.artifactContract,
        projectDir: f.input.projectDir, runId: created.runId, runDir: created.runDirPath, timeout_ms: 60000, retries: 0 };
      let calls = 0;
      const adapter = { async run() { calls++; if (calls === 1) writeFileSync(target, 'owned output');
        return { output: `new invocation ${calls}`, exitCode: calls === 1 ? firstExit : 0, duration_ms: 1,
          writes: calls === 1 ? ['run:product'] : [], writeAttribution: 'structured' as const }; } };
      const first = await runStage(adapter, options);
      const second = await runStage(adapter, options);
      expect(first.exitCode).toBe(firstExit); expect(second.exitCode).toBe(0); expect(calls).toBe(2);
      expect(readStageStatus(f.input.projectDir, created.runId, 'work').attempts?.map(a => a.status))
        .toEqual([firstExit === 0 ? 'complete' : 'failed', 'complete']);
    } finally { setFcGlobalDir(previous); }
  });
});
