import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { providerFailureFromEvent } from '../src/provider-result.js';
import { adapterInputLimit, loadEngineDefaults } from '../src/config.js';
import { decisionInput } from '../src/decision-context.js';
import { appendEvidence, evidenceContext } from '../src/evidence-ledger.js';
import { decisionSchema, POST_AUTHOR_PROMPT } from '../src/decision-graph.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
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
const brief = '# Coherent change\n\n## Acceptance criteria\n1. Produce docs/report.md with a greeting.\n';
const stage = StageConfigSchema.parse({ id: 'assess', role: 'planner', scope: [],
  decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } });
const role: AgentConfig = { name: 'planner', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: '' };
let root: string, project: string, prior: string;

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
function gateVerdict(opts: RunOpts) {
  const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return JSON.stringify({ pass: true, reason: 'Independent experiment accepted.',
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: 'pass', evidence: 'Independent experiment on the produced output.' }])),
    audit_findings: { version: 1, findings: [] }, remaining_work: [] });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-input-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  git('init', '-q');
  commitFile('src/app.ts', 'export const greeting = "hello";\n');
});
afterEach(() => { setFcGlobalDir(prior); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('the review decision gets the whole diff or none of it', () => {
  it('declares the codex limit with its reason in configuration', () => {
    expect(loadEngineDefaults().adapter_input_limit_chars.codex).toBe(CODEX_LIMIT);
    expect(adapterInputLimit({ sessionKind: 'codex' })).toBe(CODEX_LIMIT);
    expect(adapterInputLimit({})).toBe(Math.min(...Object.values(loadEngineDefaults().adapter_input_limit_chars)));
    expect(readFileSync(join(import.meta.dirname, '../config/defaults.yaml'), 'utf8')).toMatch(/codex: 1048576/);
  });

  it('the #2456 shape: many tiny evidence files plus new source files, together over the bound, go to the full review without a model call', async () => {
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "CODE_CHANGE_MARKER";\n');
    mkdirSync(join(project, 'docs/evidence'), { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(project, `docs/evidence/note_${String(i).padStart(4, '0')}.jsonl`), `${JSON.stringify({ event: 'trace', n: i, payload: 'x'.repeat(560) })}\n`);
    mkdirSync(join(project, 'tools/consolidation'), { recursive: true });
    for (const name of ['parity', 'defects', 'closure']) writeFileSync(join(project, `tools/consolidation/${name}.py`), `# ${name}\n${'value = 1\n'.repeat(15_000)}`);
    const calls: Array<{ stageId: string; prompt: string }> = [];
    // Declares codex, so the engine's own lookup (adapterInputLimit(stageAdapter) in ordinary-stage) supplies the bound.
    const adapter: Adapter = { sessionKind: 'codex', async run(prompt, _role, opts) {
      calls.push({ stageId: opts.stageId, prompt });
      return { output: opts.stageId === 'review_full' ? gateVerdict(opts) : '', exitCode: 0, duration_ms: 1 };
    } };
    const workflow = WorkflowConfigSchema.parse({ name: 'oversize-change', stages: [
      { id: 'review_assess', role: 'qa', scope: [], decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' }, artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['review_assess'], is_gate: true, artifact_contract: fixtureArtifactContract('review', true) },
      { id: 'review_full', role: 'qa', scope: [], depends_on: ['review_assess'], is_gate: true, artifact_contract: fixtureArtifactContract('review_full', true) },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review', 'review_full'], retry_to: ['review', 'review_full'], condition: 'review.pass == false', artifact_contract: contract },
    ] });
    const state = await runWorkflow(workflow, JSON.stringify(workflow), project, adapter, new Map(), undefined, agents, undefined, brief, true);
    expect(state.status, state.failureReason).toBe('complete');
    // No model call for the decision, so no diff text and no file list was sent anywhere.
    expect(calls.map(call => call.stageId)).toEqual(['review_full']);
    const record = state.decisionGraph!.records.find(entry => entry.stageId === 'review_assess')!;
    expect(record).toMatchObject({ successor: 'review_full', outcome: 'chosen', risk_areas: [] });
    const [, measured, files, bound] = record.reason.match(/^diff_exceeds_inline_bound: .*at least (\d+) characters across (\d+) changed files, over the (\d+) characters/)!.map(Number);
    expect(files).toBe(1004);
    expect(bound).toBeLessThan(CODEX_LIMIT);
    expect(measured).toBeGreaterThan(bound);
    expect(state.stages.review.status).toBe('skipped');
    // The full review reads the worktree itself: its prompt carries the usual 3 KB excerpt and the path of the full patch, not the 1 MB diff.
    expect(calls[0].prompt.length).toBeLessThan(60_000);
    expect(calls[0].prompt).toContain('change.diff');
  }, 120_000);

  it('a change that fits gives the assessor exactly the input it got before', () => {
    commitFile('src/other.ts', 'export const other = 1;\n');
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "changed";\n');
    writeFileSync(join(project, 'src/other.ts'), 'export const other = 2;\n');
    writeFileSync(join(project, 'a_large.txt'), 'line\n'.repeat(2000));
    writeFileSync(join(project, 'b_small.txt'), 'tiny\n');
    const created = createRun(project, 'fixture', 'name: fixture', ['assess']);
    const state = readRunState(project, created.runId);
    const input = decisionInput(stage, project, created.runDirPath, state, CODEX_LIMIT);
    expect(input.adapter).toBeUndefined();
    expect(JSON.parse(input.user)).toEqual({ task: state.taskDescription, files: ['src/app.ts', 'src/other.ts', 'a_large.txt', 'b_small.txt'],
      diff: legacyDiff(['a_large.txt', 'b_small.txt']), validation: { status: 'No configured validation facts have been recorded.' } });
    // The prompt is the decision prompt as it was: no extra instruction, and still no tools.
    expect(input.system).toBe(POST_AUTHOR_PROMPT);
    expect(input.system).toContain('Do not use tools');
  });

  it('is decided by size alone: the same files over a small bound go to the full review whatever their names', () => {
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "changed";\n');
    writeFileSync(join(project, 'new_source.py'), 'x = 1\n'.repeat(100));
    const created = createRun(project, 'fixture', 'name: fixture', ['assess']);
    const state = readRunState(project, created.runId);
    const fits = decisionInput(stage, project, created.runDirPath, state, 65_536 + 5_000);
    expect(fits.adapter).toBeUndefined();
    const over = decisionInput(stage, project, created.runDirPath, state, 65_536 + 600);
    expect(over.adapter).toBeDefined();
    expect(over.user).not.toContain('x = 1');
    expect(over.user).not.toContain('CODE');
  });
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
    expect(prompt).toContain(join(created.runDirPath, 'evidence-ledger.jsonl'));
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
  it.each(['stdout', 'stderr'])('after a JSON event, the line on %s records one attempt, spends no retry and concludes with its own reason code', async stream => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const calls = join(root, 'calls.txt');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FC_FIXTURE_CALLS, 'call\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a1ba92-1221-7410-9b54-3baa3eb139dd' }));
  (process.env.FC_FIXTURE_STREAM === 'stdout' ? console.log : console.error)(process.env.FC_FIXTURE_MESSAGE);
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
    vi.stubEnv('FC_FIXTURE_MESSAGE', message);
    setEngineDefaults({ default_timeout_ms: 5_000, stage_technical_retries: 2 });
    const workflow = WorkflowConfigSchema.parse({ name: 'size-fixture', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: 'work', role: 'fixture', scope: [], prompt_template: 'fixture', artifact_contract: fixtureArtifactContract('work') }] });
    const run = createRun(project, workflow.name, stringify(workflow), ['work']);
    await executeReadyBatch(workflow.stages, readRunState(project, run.runId), project, run.runId, run.runDirPath, workflow,
      new CodexAdapter(), new Map([['fixture', { ...role, name: 'fixture' }]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    expect(existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []).toHaveLength(1);
    expect(readRunState(project, run.runId)).toMatchObject({ status: 'failed', reasonCode: 'input_too_large' });
    const status = readStageStatus(project, run.runId, 'work');
    expect(status).toMatchObject({ status: 'failed', retries: 0 });
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts![0].providerFailure).toMatchObject({ kind: 'input_too_large', provider: 'codex' });
  }, 60_000);
});
