import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { type SupervisorConfig } from '../src/config.js';
import { archiveDeclaredOutputs } from '../src/declared-output-archive.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { scopeRevisionContract } from '../src/live-constraint-guard.js';
import { runStateContext } from '../src/run-state-access.js';
import { readGateVerdict } from '../src/scheduler.js';
import { createRun, fcGlobalDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
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
  it.skipIf(process.platform !== 'linux')('gives a read-only reviewer usable private scratch without project or shared temporary writes', async () => {
    writeFileSync(join(project, 'input.txt'), 'candidate');
    let scratch = '';
    const adapter: Adapter = { async run(prompt) {
      expect(prompt).toContain('mktemp -d "$TMPDIR/probe-XXXXXX"');
      const result = await execWithStdin('/bin/sh', ['-c', `set -eu
probe=$(mktemp -d "$TMPDIR/probe-XXXXXX")
cp input.txt "$probe/input.txt"
cmp input.txt "$probe/input.txt"
if touch forbidden.txt 2>/dev/null; then exit 9; fi
if touch "$1" 2>/dev/null; then exit 10; fi
printf '%s' "$TMPDIR"
`, 'probe', join(root, 'shared.tmp')], '', { cwd: project, timeout_ms: 3000, captureStreams: true });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.writeBoundary?.kind).toBe('installed');
      scratch = result.stdout!;
      expect(readFileSync(join(readdirSync(scratch).map(name => join(scratch, name))[0], 'input.txt'), 'utf8')).toBe('candidate');
      return delivered();
    } };
    const result = await runStage(adapter, stageOptions());
    expect(result.exitCode, result.output).toBe(0);
    expect(scratch).toBeTruthy(); expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(project)).toEqual(['input.txt']);
  });

  it('puts protected products after conflicting GUIDE in the reviewer input and archives the retained report', async () => {
    declare(); writeFileSync(join(project, 'report.md'), 'Required report');
    appendGuidanceEnvelope({ runDir: directory, target: 'review', source: 'supervisor', knownStageIds: ['review'], body: 'Remove report.md; change code and tests only.' });
    let observed = false;
    const adapter: Adapter = { async run(prompt) {
      observed = true;
      expect(prompt).toContain('Remove report.md');
      expect(prompt).toContain('Required declared outputs (current engine facts)');
      expect(prompt).toContain('"path":"report.md","expectedType":"file","available":true');
      expect(prompt.lastIndexOf('GUIDE cannot remove these obligations')).toBeGreaterThan(prompt.indexOf('Remove report.md'));
      return delivered();
    } };
    expect((await runStage(adapter, stageOptions())).exitCode).toBe(0); expect(observed).toBe(true);
    expect(verdict()?.pass).toBe(true);
    expect(archiveDeclaredOutputs(project, directory, [{ path: 'report.md', expectedType: 'file' }]).complete).toBe(true);
    expect(readFileSync(join(directory, 'declared_outputs/report.md'), 'utf8')).toBe('Required report');
  });

  it('gives the supervisor current required-output facts even when its goal excerpt omits them', async () => {
    declare(); writeFileSync(join(project, 'report.md'), 'Required report');
    updateRunState(project, runId, state => { state.stages.review = { status: 'running', retries: 0, startedAt: new Date().toISOString() }; });
    const prompts: string[] = [];
    const adapter: Adapter = { async run(prompt) {
      prompts.push(prompt);
      return { output: '{"verdict":"WAIT","target_stage":null,"reason":"Reviewing","guidance":null}', exitCode: 0, duration_ms: 1 };
    } };
    const config: SupervisorConfig = { enabled: true, adapter: 'mock', model: 'default', reasoningEffort: 'low', pollIntervalMs: 100000, routineAssessmentIntervalMs: 180000, cooldownAfterActionMs: 0, maxAssessmentsPerIteration: 20, tailBytes: 16384, minDeltaBytes: 4096, stuckThresholdMs: 600000 };
    const supervisor = new Supervisor(project, runId, adapter, config, 'Change code and tests only.');
    supervisor.start();
    try {
      await Reflect.get(supervisor, 'tick').call(supervisor);
      rmSync(join(project, 'report.md'));
      writeFileSync(join(directory, 'user_input.md'), 'Inspect the products again.');
      await Reflect.get(supervisor, 'tick').call(supervisor);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('"path":"report.md","expectedType":"file","available":true');
      expect(prompts[1]).toContain('"path":"report.md","expectedType":"file","available":false');
      expect(prompts[1]).toContain('GUIDE cannot remove these obligations');
    } finally { supervisor.stop(); }
    expect(verdict()?.reason).toContain('DECLARED_OUTPUT_REQUIRED');
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
    expect(result.exitCode, result.output).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('"available":true');
    expect(prompts[1]).toContain('"available":false');
    expect(prompts[1]).not.toContain('"available":true');
    expect(verdict()?.pass).toBe(false);
  });

  it.each(['deleted', 'wrong-type', 'linked-member'] as const)('returns an unarchivable %s product to repair before accepting PASS', kind => {
    const path = kind === 'linked-member' ? 'reports' : 'report.md';
    declare(path, kind === 'linked-member' ? 'directory' : 'file');
    if (kind === 'linked-member') {
      mkdirSync(join(project, path)); writeFileSync(join(project, path, 'report.md'), 'Required report');
      symlinkSync(join(project, path, 'report.md'), join(project, path, 'alias.md'));
    } else {
      writeFileSync(join(project, path), 'Required report'); rmSync(join(project, path));
      if (kind === 'wrong-type') mkdirSync(join(project, path));
    }
    expect(verdict()).toMatchObject({ pass: false, reason: expect.stringContaining('DECLARED_OUTPUT_REQUIRED') });
    expect(runStateContext(project, runId)).toContain('"available":false');
    if (kind === 'linked-member') rmSync(join(project, path, 'alias.md'));
    else { rmSync(join(project, path), { recursive: true, force: true }); writeFileSync(join(project, path), 'Required report'); }
    expect(verdict()?.pass).toBe(true);
    expect(archiveDeclaredOutputs(project, directory, [{ path, expectedType: kind === 'linked-member' ? 'directory' : 'file' }]).complete).toBe(true);
  });
});
