import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { providerFailureFromEvent } from '../src/provider-result.js';
import { adapterInputLimit, INPUT_RESERVE_CHARS, loadEngineDefaults } from '../src/config.js';
import { decisionInput } from '../src/decision-context.js';
import { appendEvidence, evidenceContext } from '../src/evidence-ledger.js';
import { decisionSchema, POST_AUTHOR_PROMPT } from '../src/decision-graph.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, readStageStatus } from '../src/store.js';
import { latestInvocationInput } from '../src/run-state-view.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

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
  return isolatedProjectCommand(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    let diff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], options);
    for (const file of JSON.parse(process.argv[1])) {
      try { diff += execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], options); }
      catch (error) { if (error.status !== 1) throw error; diff += error.stdout; }
    }
    process.stdout.write(diff);
  `, JSON.stringify(untracked)], project, root);
}
function gateVerdict(opts: RunOpts) {
  const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return JSON.stringify({ pass: true, reason: 'Independent experiment accepted.',
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: 'pass', evidence: 'Independent experiment on the produced output.' }])),
    audit_findings: { version: 1, findings: [] }, remaining_work: [] });
}

beforeEach(() => {
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  root = mkdtempSync(join(process.cwd(), 'tmp/review-input-'));
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

  it.each([{ payload: 560, fits: false }, { payload: 20, fits: true }])('the #2456 shape through the real codex call site (fits=$fits)', async ({ payload, fits }) => {
    writeFileSync(join(project, 'src/app.ts'), 'export const greeting = "CODE_CHANGE_MARKER";\n');
    mkdirSync(join(project, 'docs/evidence'), { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(project, `docs/evidence/note_${String(i).padStart(4, '0')}.jsonl`), `${JSON.stringify({ event: 'trace', n: i, payload: 'x'.repeat(payload) })}\n`);
    mkdirSync(join(project, 'tools/consolidation'), { recursive: true });
    for (const name of ['parity', 'defects', 'closure']) writeFileSync(join(project, `tools/consolidation/${name}.py`), `# ${name}\n${'value = 1\n'.repeat(15_000)}`);
    const calls: Array<{ stageId: string; prompt: string }> = [];
    // Declares codex, so the engine's own lookup (adapterInputLimit(stageAdapter) in ordinary-stage) supplies the bound.
    const adapter: Adapter = { sessionKind: 'codex', async run(prompt, _role, opts) {
      calls.push({ stageId: opts.stageId, prompt });
      return { output: opts.stageId === 'review_full' ? gateVerdict(opts) : JSON.stringify({ successor: 'review_full', risk_areas: [], reason: 'Assessor chose full review.' }), exitCode: 0, duration_ms: 1 };
    } };
    const workflow = WorkflowConfigSchema.parse({ name: 'oversize-change', stages: [
      { id: 'review_assess', role: 'qa', scope: [], decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' }, artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['review_assess'], is_gate: true, artifact_contract: fixtureArtifactContract('review', true) },
      { id: 'review_full', role: 'qa', scope: [], depends_on: ['review_assess'], is_gate: true, artifact_contract: fixtureArtifactContract('review_full', true) },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review', 'review_full'], retry_to: ['review', 'review_full'], condition: 'review.pass == false', artifact_contract: contract },
    ] });
    const state = await runWorkflow(workflow, JSON.stringify(workflow), project, adapter, new Map(), undefined, agents, undefined, brief, true);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.map(call => call.stageId), JSON.stringify(state.decisionGraph?.records)).toEqual(fits ? ['review_assess', 'review_full'] : ['review_full']);
    const record = state.decisionGraph!.records.find(entry => entry.stageId === 'review_assess')!;
    expect(record).toMatchObject({ successor: 'review_full', outcome: 'chosen', risk_areas: [] });
    const directory = join(fcGlobalDir(), 'runs', state.runId);
    if (fits) {
      const input = JSON.parse(calls[0].prompt.split('\n')[0]);
      expect(input.diff.length).toBeGreaterThan(600_000);
      expect(input.diff.length).toBeLessThan(970_000);
      expect(input.diff).toBe(legacyDiff(input.files.filter((file: string) => file !== 'src/app.ts')));
    } else {
      const [, raw, encoded, nonDiff, files, bound] = record.reason.match(/^diff_exceeds_inline_bound: code decided review routing; measured at least (\d+) diff characters \((\d+) JSON-encoded diff characters\) and (\d+) non-diff JSON characters; (\d+) changed files including untracked; inline bound (\d+)/)!.map(Number);
      expect(files).toBe(1004);
      expect(bound).toBe(CODEX_LIMIT - INPUT_RESERVE_CHARS - JSON.stringify({ task: state.taskDescription }).length);
      expect(encoded + nonDiff).toBeGreaterThan(bound);
      expect(raw).toBeLessThan(encoded);
      expect(latestInvocationInput(directory, 'review_assess')).toBeUndefined();
      expect(existsSync(join(directory, 'stages/review_assess/invocations'))).toBe(false);
      expect(record).not.toHaveProperty('model');
    }
    expect(state.stages.review.status).toBe('skipped');
    // The full review reads the worktree itself: its prompt carries the usual 3 KB excerpt and the path of the full patch, not the 1 MB diff.
    expect(calls.at(-1)!.prompt.length).toBeLessThan(60_000);
    expect(calls.at(-1)!.prompt).toContain('change.diff');
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

  it.each([
    ['tracked', { code: 'ENOBUFS', status: 1, stdout: 'partial' }],
    ['untracked', { code: 'ENOBUFS', status: 1, stdout: 'partial' }],
    ['untracked', { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: 'partial' }],
    ['untracked', { status: 2, stdout: 'partial' }],
    ['paths', { code: 'ETIMEDOUT', stdout: 'partial' }],
  ])('an incomplete %s read cannot pass as complete even with a huge declared limit (%j)', async (piece, failure) => {
    writeFileSync(join(project, 'new.txt'), 'untracked');
    const created = createRun(project, 'fixture', 'name: fixture', ['assess']);
    const original = childProcess.execFileSync;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: string[], options: object) => {
      if (command === 'git' && (piece === 'paths' ? args[0] === 'ls-files' : piece === 'untracked' ? args.includes('--no-index') : args.includes('--no-textconv') && !args.includes('--no-index'))) throw failure;
      return original(command, args, options);
    }) as typeof childProcess.execFileSync);
    const input = decisionInput(stage, project, created.runDirPath, readRunState(project, created.runId), 100_000_000);
    expect(input.adapter).toBeDefined();
    expect(input.user).not.toContain('partial');
    const result = JSON.parse((await input.adapter!.run('', role, {} as RunOpts)).output);
    expect(result).toMatchObject({ successor: 'review_full' });
    expect(result.reason).toMatch(/^diff_unavailable: code decided/);
    expect(result.reason).toContain(piece === 'paths' ? 'changed-file count unavailable' : '1 changed files including untracked');
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
  it.each([{ stream: 'stdout', diagnostic: message, typed: true }, { stream: 'stderr', diagnostic: message, typed: true },
    { stream: 'stdout', diagnostic: '401 unauthorized', typed: false },
    { stream: 'stdout', diagnostic: 'rate limit', typed: false }])('after a JSON event ($stream, typed=$typed)', async ({ stream, diagnostic, typed }) => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const calls = join(root, 'calls.txt');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
import fs from 'node:fs';
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
    setEngineDefaults({ default_timeout_ms: 30_000, stage_technical_retries: 2 });
    const workflow = WorkflowConfigSchema.parse({ name: 'size-fixture', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: 'work', role: 'fixture', scope: [], prompt_template: 'fixture', artifact_contract: fixtureArtifactContract('work') }] });
    const run = createRun(project, workflow.name, stringify(workflow), ['work']);
    await executeReadyBatch(workflow.stages, readRunState(project, run.runId), project, run.runId, run.runDirPath, workflow,
      new CodexAdapter(), new Map([['fixture', { ...role, name: 'fixture' }]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    const observed = readStageStatus(project, run.runId, 'work');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [], JSON.stringify(observed)).toHaveLength(1);
    if (typed) expect(readRunState(project, run.runId)).toMatchObject({ status: 'failed', reasonCode: 'input_too_large' });
    const status = readStageStatus(project, run.runId, 'work');
    if (typed) expect(status).toMatchObject({ status: 'failed', retries: 0 });
    else expect(status.retries).toBe(1);
    expect(status.attempts).toHaveLength(1);
    if (typed) expect(status.attempts![0].providerFailure).toMatchObject({ kind: 'input_too_large', provider: 'codex' });
    else expect(status.attempts![0].providerFailure).toBeUndefined();
  }, 60_000);
});
