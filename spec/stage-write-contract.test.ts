import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { archiveDeclaredOutputs } from '../src/declared-output-archive.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { scopeRevisionContract } from '../src/live-constraint-guard.js';
import { runStateContext } from '../src/run-state-access.js';
import { readGateVerdict } from '../src/scheduler.js';
import { createRun, fcGlobalDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-write-contract-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  ({ runId, runDirPath: directory } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['review']));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

const role = { name: 'reviewer', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Review the candidate.' };
const stageOptions = () => ({ stageId: 'review', role, dependsOn: [], promptTemplate: scopeRevisionContract({
  runDir: directory, runId, stageId: 'review', attemptIndex: 1, scope: [], scopePresence: 'present', gate: true,
}), projectDir: project, runId, runDir: directory, retries: 0, timeout_ms: 10000, projectWriteScope: [],
outputSchema: HANDOFF_SCHEMA, artifactContract: { version: 1 as const, produces: [], reads: [], groups: [], replays: [] } });
const delivered = () => ({ output: JSON.stringify({ status: 'delivered', summary: 'Reviewed', files_modified: [], checks: [], caveats: [] }), exitCode: 0, duration_ms: 1 });
function declare(path = 'report.md', expectedType: 'file' | 'directory' = 'file') {
  updateRunState(project, runId, state => { state.declaredOutputs = [{ path, expectedType }]; });
  writeFileSync(join(directory, 'verdict_review.json'), '{"pass":true}');
}
const verdict = () => readGateVerdict(project, 'review', runId, undefined, false, false);

describe('stage writes follow the run product contract', () => {
  it('puts protected products after conflicting GUIDE in the reviewer input and archives the retained report', async () => {
    declare(); writeFileSync(join(project, 'report.md'), 'Required report');
    appendGuidanceEnvelope({ runDir: directory, target: 'review', source: 'supervisor', knownStageIds: ['review'], body: 'Remove report.md; change code and tests only.' });
    let observed = false;
    const adapter: Adapter = { async run(prompt) {
      observed = true;
      expect(prompt).toContain('Remove report.md');
      expect(prompt).toContain('Required declared outputs (current engine facts)');
      expect(prompt).toContain('"path":"report.md","expectedType":"file","available":true');
      expect(prompt.lastIndexOf('Guidance cannot remove these obligations')).toBeGreaterThan(prompt.indexOf('Remove report.md'));
      return delivered();
    } };
    expect((await runStage(adapter, stageOptions())).exitCode).toBe(0); expect(observed).toBe(true);
    expect(verdict()?.pass).toBe(true);
    expect(archiveDeclaredOutputs(project, directory, [{ path: 'report.md', expectedType: 'file' }]).complete).toBe(true);
    expect(readFileSync(join(directory, 'declared_outputs/report.md'), 'utf8')).toBe('Required report');
  });

  it('refreshes required-output facts on a resumed worker after guidance arrives', async () => {
    declare(); writeFileSync(join(project, 'report.md'), 'Required report');
    const prompts: string[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      prompts.push(prompt);
      if (prompts.length > 1) return delivered();
      opts.onCommandLifecycle?.({ phase: 'started', id: 'inspect', command: 'cat report.md', timestamp: new Date().toISOString() });
      // Simulate a changed product between invocations; the next observation
      // must describe current bytes rather than inherit a stale snapshot.
      rmSync(join(project, 'report.md'));
      appendGuidanceEnvelope({ runDir: directory, target: 'review', source: 'supervisor', knownStageIds: ['review'], body: 'Inspect the required report again.' });
      opts.onCommandLifecycle?.({ phase: 'completed', id: 'inspect', timestamp: new Date().toISOString() });
      return { output: 'Inspection interrupted for guidance', exitCode: opts.abortSignal?.aborted ? 137 : 0, duration_ms: 1, sessionId: '11111111-1111-4111-8111-111111111111' };
    } };
    const result = await runStage(adapter, stageOptions());
    expect(result.exitCode, result.output).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('"available":true');
    expect(prompts[1]).toContain('"available":false');
    expect(prompts[1]).not.toContain('"available":true');
    expect(verdict()?.pass).toBe(false);
  });

  it.each(['deleted', 'wrong-type'] as const)('returns an unarchivable %s product to repair before accepting PASS', kind => {
    const path = 'report.md';
    declare(path);
    writeFileSync(join(project, path), 'Required report'); rmSync(join(project, path));
    if (kind === 'wrong-type') mkdirSync(join(project, path));
    expect(verdict()).toMatchObject({ pass: false, reason: expect.stringContaining('DECLARED_OUTPUT_REQUIRED') });
    expect(runStateContext(project, runId)).toContain('"available":false');
    // The prompt states the refusal exercised above instead of asking the gate to re-check availability.
    expect(runStateContext(project, runId)).toContain('The engine refuses gate PASS while one is unavailable, except products assigned to later ordinary work');
    expect(runStateContext(project, runId)).not.toContain('A gate must check its required products');
    rmSync(join(project, path), { recursive: true, force: true }); writeFileSync(join(project, path), 'Required report');
    expect(verdict()?.pass).toBe(true);
    expect(archiveDeclaredOutputs(project, directory, [{ path, expectedType: 'file' }]).complete).toBe(true);
  });

  it('accepts and archives a directory product containing a confined link', () => {
    declare('reports', 'directory'); mkdirSync(join(project, 'reports'));
    writeFileSync(join(project, 'reports/report.md'), 'Required report');
    symlinkSync('report.md', join(project, 'reports/alias.md'));
    expect(verdict()?.pass).toBe(true);
    expect(runStateContext(project, runId)).toContain('"available":true');
    expect(archiveDeclaredOutputs(project, directory, [{ path: 'reports', expectedType: 'directory' }]).complete).toBe(true);
  });
});
