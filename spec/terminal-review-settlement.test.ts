import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { parseDispatchedStageConfig, runWorkflow, tryTerminateOnTerminalState, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, isSuccessfulRunStatus, runDir, setFcGlobalDir } from '../src/store.js';
import { artifacts, producedRead } from './spec_contracts/declared-fixtures.js';

const repository = resolve(import.meta.dirname, '..');
const previousGlobalDir = fcGlobalDir();
const temporary: string[] = [];
afterEach(() => {
  setFcGlobalDir(previousGlobalDir);
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function runReviewedTerminal(reviewAfterFinalizer: boolean, changeProduct = true, ignoredProduct = false) {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-review-'));
  temporary.push(directory);
  const project = join(directory, 'project');
  mkdirSync(project);
  if (ignoredProduct) {
    execFileSync(process.execPath, ['-e', "require('node:child_process').execFileSync('git', ['init', '-q', '.'])"], {
      cwd: project, env: { ...process.env, HOME: directory, FC_HOME: join(directory, 'state') },
    });
    writeFileSync(join(project, '.gitignore'), 'value.json\n');
  }
  setFcGlobalDir(join(directory, 'state'));
  const stage = parseDispatchedStageConfig;
  const work = stage({
    id: 'work', role: 'coder', scope: ['value.json'],
    artifact_contract: artifacts([{ id: 'value', root: 'project', path: 'value.json' }]),
  });
  const finalizer = stage({
    id: 'finalize', role: 'coder', depends_on: [reviewAfterFinalizer ? 'work' : 'review'],
    scope: ['report.md', 'value.json'],
    artifact_contract: artifacts([
      { id: 'report', root: 'project', path: 'report.md' },
      { id: 'value', root: 'project', path: 'value.json' },
    ]),
  });
  const review = stage({
    id: 'review', role: 'qa', is_gate: true,
    depends_on: [reviewAfterFinalizer ? 'finalize' : 'work'],
    artifact_contract: artifacts(
      [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }],
      [producedRead('value_input', 'value.json', reviewAfterFinalizer ? 'finalize' : 'work', 'value')],
    ),
  });
  const repair = stage({
    id: 'repair', role: 'coder', scope: ['value.json'],
    depends_on: ['review'], retry_to: ['review'], artifact_contract: artifacts(),
  });
  const workflow = WorkflowConfigSchema.parse({
    name: 'reviewed-terminal', defaults: { max_iterations: 1, max_retries: 0 },
    stages: reviewAfterFinalizer ? [work, finalizer, review, repair] : [work, review, repair, finalizer],
  });
  const reviewedValues: string[] = [];
  const adapter = new ScriptedAdapter({
    work: { output: 'original product', projectFiles: { 'value.json': '{"value":"original"}\n' } },
    finalize: {
      output: 'terminal report and changed product',
      projectFiles: { 'report.md': 'Candidate terminal report.\n', 'value.json': changeProduct ? '{"value":"changed"}\n' : '{"value":"original"}\n' },
    },
    review: {
      output: 'independent review',
      runFiles: { 'verdict_review.json': JSON.stringify({ pass: true, reason: 'Accepted the product bytes observed by this review.' }) },
    },
    _summary: { output: 'summary' },
  });
  const run = adapter.run.bind(adapter);
  adapter.run = async (prompt, role, options) => {
    if (options.stageId === 'review') reviewedValues.push(readFileSync(join(options.workDir, 'value.json'), 'utf8'));
    return run(prompt, role, options);
  };
  const final = await runWorkflow(
    workflow, '', project, adapter, new Map(), undefined, join(repository, 'config/agents'), undefined,
    '---\nterminal_states:\n  complete:\n    paths: [report.md]\n---\n# Produce an independently reviewed result.\n', true,
  );
  return { final, project, adapter, reviewedValues };
}

describe('terminal production preserves reviewed product bytes', () => {
  it('refuses terminal settlement for product changes made after its independent review', async () => {
    const { final, project, adapter, reviewedValues } = await runReviewedTerminal(false);
    expect(adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(['work', 'review', 'finalize']);
    expect(reviewedValues).toEqual(['{"value":"original"}\n']);
    expect(isSuccessfulRunStatus(final.status)).toBe(false);
    expect(readFileSync(join(project, 'value.json'), 'utf8')).toBe('{"value":"changed"}\n');
    expect(final.failureReason).toContain('unreviewed product writes (value.json)');
    const audit = final.stages.finalize.attempts?.at(-1)?.constraintAudit;
    expect(audit).toBeDefined();
    const receipt = JSON.parse(readFileSync(join(runDir(project, final.runId), audit!.path), 'utf8')) as { durableWrites: string[]; rolledBackWrites: string[] };
    expect(receipt.durableWrites).toContain('value.json');
    expect(receipt.rolledBackWrites).toEqual([]);
  });

  it('allows gitignored product changes after review, preserving the exemption', async () => {
    const { final, project } = await runReviewedTerminal(false, true, true);
    const audit = final.stages.finalize.attempts!.at(-1)!.constraintAudit!;
    expect(JSON.parse(readFileSync(join(runDir(project, final.runId), audit.path), 'utf8')).exemptedWrites).toContain('value.json');
    expect(final.status, final.failureReason).toBe('complete');
  });

  it('retains product changes independently reviewed after terminal production', async () => {
    const { final, project, adapter, reviewedValues } = await runReviewedTerminal(true);
    expect(final.status, final.failureReason).toBe('complete');
    expect(adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(['work', 'finalize', 'review']);
    expect(reviewedValues).toEqual(['{"value":"changed"}\n']);
    expect(readFileSync(join(project, 'value.json'), 'utf8')).toBe(reviewedValues[0]);
  });

  it('allows validation to rewrite identical product bytes after review', async () => {
    const { final, project, reviewedValues } = await runReviewedTerminal(false, false);
    expect(final.status, final.failureReason).toBe('complete');
    expect(readFileSync(join(project, 'value.json'), 'utf8')).toBe(reviewedValues[0]);
  });


  it('does not reuse an older downstream review after the terminal producer changes product again', async () => {
    const { final, project } = await runReviewedTerminal(true);
    expect(final.status).toBe('complete');
    const completedAt = new Date(Date.now() + 1000).toISOString();
    const owner = final.stages.finalize;
    owner.attempts!.push({ index: 2, startedAt: completedAt, completedAt, status: 'complete', writes: ['report.md', 'value.json'] });
    owner.completedAt = completedAt;
    final.status = 'running';
    writeFileSync(join(project, 'value.json'), '{"value":"changed again"}\n');
    const result = await tryTerminateOnTerminalState(final, {
      projectDir: project, runId: final.runId, runDirPath: runDir(project, final.runId), iteration: 1, adapter: new ScriptedAdapter({}),
    });
    expect(result.decision).toBe('deferred');
    expect(final.status).toBe('running');
    if (result.decision === 'deferred') expect(result.reasons.join(';')).toContain('unreviewed product writes (value.json)');
  });

});
