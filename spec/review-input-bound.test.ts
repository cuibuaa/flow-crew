import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { providerFailureFromEvent } from '../src/provider-result.js';
import { adapterInputLimit, loadEngineDefaults } from '../src/config.js';
import { changedPaths, decisionInput } from '../src/decision-context.js';
import { decisionSchema } from '../src/decision-graph.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, readStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const CODEX_LIMIT = 1_048_576;
const stage = StageConfigSchema.parse({ id: 'assess', role: 'planner', scope: [],
  decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } });
const role: AgentConfig = { name: 'planner', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: '' };
let root: string, project: string, prior: string;

const sha = (path: string) => createHash('sha256').update(readFileSync(join(project, path))).digest('hex');
const git = (...args: string[]) => isolatedProjectCommand('git', args, project, root);
function commitFile(path: string, content: string) {
  mkdirSync(join(project, path, '..'), { recursive: true });
  writeFileSync(join(project, path), content);
  git('add', '--', path);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', `add ${path}`);
}
/** The diff text the engine produced before the input was bounded: git's tracked diff, then each untracked file as an added file. */
function legacyDiff(untracked: string[]): string {
  let diff = git('diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--');
  for (const file of untracked) diff += isolatedProjectCommand('sh', ['-c', 'git diff --no-index --no-ext-diff --no-textconv -- /dev/null "$0" || true', file], project, root);
  return diff;
}
/** What the adapter receives for the review decision, through the real worker. */
async function adapterInput(limit?: number): Promise<{ prompt: string; facts: Record<string, any> }> {
  const created = createRun(project, 'fixture', 'name: fixture', ['assess']);
  const input = decisionInput(stage, project, created.runDirPath, readRunState(project, created.runId), limit);
  let prompt = '';
  const adapter: Adapter = { async run(user) { prompt = user; return { output: '', exitCode: 1, duration_ms: 1 }; } };
  await runStage(adapter, { stageId: 'assess', role, dependsOn: [], promptTemplate: '', timeout_ms: 60_000, projectDir: project, runId: created.runId,
    runDir: created.runDirPath, retries: 0, artifactContract: fixtureArtifactContract('assess'), outputSchema: decisionSchema(stage),
    decisionResult: true, isolatedInput: input });
  return { prompt, facts: JSON.parse(input.user) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-input-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  git('init', '-q');
  commitFile('src/app.ts', 'export const greeting = "hello";\n');
});
afterEach(() => { setFcGlobalDir(prior); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('review input stays within the adapter limit', () => {
  it('declares the codex limit with its reason in configuration', () => {
    expect(loadEngineDefaults().adapter_input_limit_chars.codex).toBe(CODEX_LIMIT);
    expect(adapterInputLimit({ sessionKind: 'codex' })).toBe(CODEX_LIMIT);
    expect(adapterInputLimit({})).toBe(Math.min(...Object.values(loadEngineDefaults().adapter_input_limit_chars)));
    expect(readFileSync(join(import.meta.dirname, '../config/defaults.yaml'), 'utf8')).toMatch(/codex: 1048576/);
  });

  it('the #2456 shape: 25 MB of untracked evidence plus a small code change', async () => {
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "CODE_CHANGE_MARKER";\n');
    writeFileSync(join(project, 'src/added.ts'), 'export const added = true;\n');
    mkdirSync(join(project, 'evidence'));
    const line = `${JSON.stringify({ event: 'trace', payload: 'x'.repeat(200) })}\n`;
    for (let i = 0; i < 25; i++) writeFileSync(join(project, `evidence/trace_${String(i).padStart(2, '0')}.jsonl`), line.repeat(Math.ceil(1_000_000 / line.length)));
    const changed = ['src/app.ts', 'src/added.ts', ...Array.from({ length: 25 }, (_, i) => `evidence/trace_${String(i).padStart(2, '0')}.jsonl`)];

    const { prompt, facts } = await adapterInput(CODEX_LIMIT);
    expect(prompt.length).toBeLessThanOrEqual(CODEX_LIMIT);
    expect(JSON.stringify(facts).length).toBeLessThan(CODEX_LIMIT);
    // Every changed file is named with its status, size and content hash.
    expect(facts.manifest.map((entry: { path: string }) => entry.path).sort()).toEqual([...changed].sort());
    for (const entry of facts.manifest) {
      expect(entry.sha256).toBe(sha(entry.path));
      expect(entry.size).toBe(readFileSync(join(project, entry.path)).length);
    }
    expect(facts.manifest.find((entry: { path: string }) => entry.path === 'src/app.ts')).toMatchObject({ tracked: true, status: 'M', inlined: true });
    // The code change is shown; the evidence tree is named, not pasted.
    expect(facts.diff).toContain('CODE_CHANGE_MARKER');
    expect(facts.diff).toContain('export const added = true;');
    expect(facts.diff).not.toContain('"event"');
    const omitted = facts.manifest.filter((entry: { inlined: boolean }) => !entry.inlined);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((entry: { path: string }) => entry.path.startsWith('evidence/'))).toBe(true);
    expect(facts.note).toContain('read them from the worktree');
    expect(changedPaths(project, readRunState(project, createRun(project, 'fixture', 'name: fixture', ['x']).runId)).sort()).toEqual([...changed].sort());
  }, 60_000);

  it('a change that fits yields exactly the diff text git prints, in git order', async () => {
    commitFile('src/other.ts', 'export const other = 1;\n');
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "changed";\n');
    writeFileSync(join(project, 'src/other.ts'), 'export const other = 2;\n');
    // Size order and path order disagree, so a reordered diff would show.
    writeFileSync(join(project, 'a_large.txt'), 'line\n'.repeat(2000));
    writeFileSync(join(project, 'b_small.txt'), 'tiny\n');
    const { facts } = await adapterInput(CODEX_LIMIT);
    expect(facts.diff).toBe(legacyDiff(['a_large.txt', 'b_small.txt']));
    expect(facts.diff).toContain('diff --git a/src/other.ts');
    expect(facts.manifest.every((entry: { inlined: boolean }) => entry.inlined)).toBe(true);
    expect(facts.manifest.map((entry: { path: string }) => entry.path)).toEqual(['src/app.ts', 'src/other.ts', 'a_large.txt', 'b_small.txt']);
    expect(facts).not.toHaveProperty('note');
  });

  it('stays within a small limit by shortening the manifest, and says so', async () => {
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "CODE_CHANGE_MARKER";\n');
    mkdirSync(join(project, 'many'));
    for (let i = 0; i < 400; i++) writeFileSync(join(project, `many/file_${i}.txt`), `${i}\n`);
    const limit = 65_536 + 30_000;
    const { prompt, facts } = await adapterInput(limit);
    expect(prompt.length).toBeLessThanOrEqual(limit);
    expect(facts.manifest.length).toBeLessThan(401);
    expect(facts.note).toContain('beyond the manifest');
    expect(facts.diff).toContain('CODE_CHANGE_MARKER');
  });
});

describe('an adapter that refuses the input by size', () => {
  const message = 'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":21509436}';

  it('is a typed condition, read from the provider code and never replayed', () => {
    expect(classifyAdapterFailure(message)).toBe('input_too_large');
    expect(classifyAdapterFailure('anything', 'input_too_large')).toBe('input_too_large');
    expect(isRetryableAdapterFailure('input_too_large')).toBe(false);
    // The same text without the provider's code is not interpreted as prose.
    expect(classifyAdapterFailure('Input exceeds the maximum length of 1048576 characters.')).toBeUndefined();
    expect(providerFailureFromEvent('codex', { type: 'error', message: 'too long', error: { code: -32602, data: { input_error_code: 'input_too_large' } } }))
      .toMatchObject({ kind: 'input_too_large', provider: 'codex' });
  });

  it('records one attempt, spends no retry and concludes with its own reason code', async () => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const calls = join(root, 'calls.txt');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FC_FIXTURE_CALLS, 'call\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a1ba92-1221-7410-9b54-3baa3eb139dd' }));
  console.error(process.env.FC_FIXTURE_MESSAGE);
  process.exitCode = 1;
});
`, { mode: 0o700 });
    for (const directory of ['codex-source', 'plugins', 'skills']) mkdirSync(join(root, directory));
    vi.stubEnv('CODEX_HOME', join(root, 'codex-source'));
    vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
    vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    vi.stubEnv('FC_FIXTURE_CALLS', calls);
    vi.stubEnv('FC_FIXTURE_MESSAGE', message);
    setEngineDefaults({ default_timeout_ms: 5_000, stage_technical_retries: 2 });
    const workflow = WorkflowConfigSchema.parse({ name: 'size-fixture', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: 'work', role: 'fixture', scope: [], prompt_template: 'fixture', artifact_contract: fixtureArtifactContract('work') }] });
    const created = createRun(project, workflow.name, stringify(workflow), ['work']);
    await executeReadyBatch(workflow.stages, readRunState(project, created.runId), project, created.runId, created.runDirPath, workflow,
      new CodexAdapter(), new Map([['fixture', { ...role, name: 'fixture' }]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    expect(existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []).toHaveLength(1);
    const state = readRunState(project, created.runId);
    expect(state).toMatchObject({ status: 'failed', reasonCode: 'input_too_large' });
    const status = readStageStatus(project, created.runId, 'work');
    expect(status).toMatchObject({ status: 'failed', retries: 0 });
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts![0].providerFailure).toMatchObject({ kind: 'input_too_large', provider: 'codex' });
  }, 60_000);
});
