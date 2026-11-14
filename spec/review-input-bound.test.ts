import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { providerFailureFromEvent } from '../src/provider-result.js';
import { loadEngineDefaults } from '../src/config.js';
import { adapterInputLimit } from '../src/adapter-input.js';
import { appendEvidence, evidenceContext } from '../src/evidence-ledger.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, readStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const CODEX_LIMIT = 1_048_576;
const agents = join(import.meta.dirname, '../config/agents');
const contract = { version: 1, produces: [], reads: [] };
const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Produce docs/report.md with a greeting.\"}]\n---\n# Coherent change\n\n## Acceptance criteria\n1. Produce docs/report.md with a greeting.\n";
const role: AgentConfig = { name: 'planner', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: '' };
let root: string, project: string, prior: string;

const git = (...args: string[]) => isolatedProjectCommand('git', args, project, root);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-input-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  git('init', '-q', '--separate-git-dir', join(root, 'git'));
});
afterEach(() => { setFcGlobalDir(prior); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('declares the codex limit with its reason in configuration', () => {
  expect(loadEngineDefaults().adapter_input_limit_chars.codex).toBe(CODEX_LIMIT);
  expect(adapterInputLimit({ sessionKind: 'codex' })).toBe(CODEX_LIMIT);
  expect(adapterInputLimit({})).toBe(Math.min(...Object.values(loadEngineDefaults().adapter_input_limit_chars)));
});

describe('review stages keep their evidence inside the adapter limit', () => {
  const attemptFacts = (stageId: string, files: number) => appendEvidence(created.runDirPath, { kind: 'attempt', stageId, attemptIndex: 1, attemptStartedAt: '2026-11-08T00:00:00.000Z',
    exitCode: 0, status: 'complete', treeHash: null, measurements: { inputTokens: null, outputTokens: null, durationMs: 1, provenance: 'adapter-reported' },
    files: Array.from({ length: files }, (_, i) => ({ path: `docs/evidence/${stageId}/note_${String(i).padStart(5, '0')}.jsonl`, mode: 0o644, content: { state: 'absent' as const } })) });
  let created: ReturnType<typeof createRun>;

  async function reviewPrompt(): Promise<string> {
    let prompt = '';
    // No declared adapter kind: the smallest declared limit applies.
    const adapter: Adapter = { async run(text) { prompt = text; return { output: '', exitCode: 1, duration_ms: 1 }; } };
    await runStage(adapter, { stageId: 'review', role, dependsOn: [], promptTemplate: 'Review.', timeout_ms: 60_000, projectDir: project, runId: created.runId,
      runDir: created.runDirPath, retries: 0, artifactContract: fixtureArtifactContract('review') });
    return prompt;
  }
  beforeEach(() => { created = createRun(project, 'fixture', 'name: fixture', ['review']); });

  it('inlines the ledger facts when they fit, and names the ledger with its counts when they do not', async () => {
    attemptFacts('author', 20);
    expect(await reviewPrompt()).toContain('Ledger facts:\n{"version":1');
    // About 3 x 250,000 characters of per-file attempt facts: over what 600,000 leaves after the reserve.
    for (const id of ['a', 'b', 'c']) attemptFacts(id, 2_500);
    const prompt = await reviewPrompt();
    expect(prompt.length).toBeLessThan(adapterInputLimit({}));
    expect(prompt).not.toContain('Ledger facts:\n{');
    expect(prompt).toMatch(/Ledger facts are not inlined \(ledger_exceeds_inline_bound\): \d+ facts from \d+ ledger entries, \d+ characters against the \d+ that fit/);
    expect(prompt).toContain(runRecordPath(created.runDirPath, 'evidence-ledger.jsonl'));
    expect(prompt).not.toContain('note_00001');
  }, 60_000);

  it('applies the budget it is given and leaves an unbounded caller as before', () => {
    attemptFacts('author', 20);
    expect(evidenceContext(project, created.runDirPath, 'review')).toContain('Ledger facts:\n{"version":1');
    expect(evidenceContext(project, created.runDirPath, 'review', null, 100)).toContain('ledger_exceeds_inline_bound');
  });
});

describe('an adapter that refuses the input by size', () => {
  const message = 'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":21509436}';

  it('is a typed condition, read from the provider code and never replayed', () => {
    expect(classifyAdapterFailure(message)).toBe('input_too_large');
    expect(classifyAdapterFailure('anything', 'input_too_large')).toBe('input_too_large');
    expect(isRetryableAdapterFailure('input_too_large')).toBe(false);
    // The same text without the provider's code is not interpreted as prose; Claude has no observed size-refusal code, so its refusal stays unclassified.
    expect(classifyAdapterFailure('Input exceeds the maximum length of 1048576 characters.')).toBeUndefined();
    expect(classifyAdapterFailure('Prompt is too long')).toBeUndefined();
    expect(providerFailureFromEvent('codex', { type: 'error', message: 'too long', error: { code: -32602, data: { input_error_code: 'input_too_large' } } }))
      .toMatchObject({ kind: 'input_too_large', provider: 'codex' });
  });

  // The real CLI prints thread.started, then its error line; the recorded #2456 log merges the streams,
  // so the error line is delivered on either one.
  it.each([{ stream: 'stdout', diagnostic: message, typed: true }, { stream: 'stderr', diagnostic: message, typed: true },
    { stream: 'stdout', diagnostic: '401 unauthorized', typed: false },
    { stream: 'stdout', diagnostic: 'rate limit', typed: false }])('after a JSON event ($stream, typed=$typed)', async ({ stream, diagnostic, typed }) => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const calls = join(project, 'calls.txt'); writeFileSync(calls, '');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FC_FIXTURE_CALLS, 'call\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a1ba92-1221-7410-9b54-3baa3eb139dd' }));
  (process.env.FC_FIXTURE_STREAM === 'stdout' ? console.log : console.error)(process.env.FC_FIXTURE_MESSAGE);
  if (process.env.FC_FIXTURE_STREAM === 'stdout' && process.env.FC_FIXTURE_MESSAGE.includes('input_error_code')) console.error('rate limit');
  process.exitCode = 1;
});
`, { mode: 0o700 });
    for (const directory of ['codex-source', 'plugins', 'skills']) mkdirSync(join(root, directory));
    vi.stubEnv('CODEX_HOME', join(root, 'codex-source'));
    vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
    vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    vi.stubEnv('FC_FIXTURE_CALLS', calls);
    vi.stubEnv('FC_FIXTURE_STREAM', stream);
    vi.stubEnv('FC_FIXTURE_MESSAGE', diagnostic);
    setEngineDefaults({ stage_technical_retries: 2 });
    const workflow = WorkflowConfigSchema.parse({ name: 'size-fixture', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: 'work', role: 'fixture', scope: ['calls.txt'], prompt_template: 'fixture', artifact_contract: fixtureArtifactContract('work') }] });
    const run = createRun(project, workflow.name, stringify(workflow), ['work']);
    await executeReadyBatch(workflow.stages, readRunState(project, run.runId), project, run.runId, run.runDirPath, workflow,
      new CodexAdapter(), new Map([['fixture', { ...role, name: 'fixture' }]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    const observed = readStageStatus(project, run.runId, 'work');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [], JSON.stringify(observed)).toHaveLength(1);
    if (typed) { const state = readRunState(project, run.runId); expect(state, JSON.stringify({ status: state.status, reasonCode: state.reasonCode, failureReason: state.failureReason, observed })).toMatchObject({ status: 'failed', reasonCode: 'input_too_large' }); }
    const status = readStageStatus(project, run.runId, 'work');
    if (typed) expect(status).toMatchObject({ status: 'failed', retries: 0 });
    else expect(status.retries).toBe(1);
    expect(status.attempts).toHaveLength(1);
    if (typed) expect(status.attempts![0].providerFailure).toMatchObject({ kind: 'input_too_large', provider: 'codex' });
    else expect(status.attempts![0].providerFailure).toBeUndefined();
  }, 60_000);
});
