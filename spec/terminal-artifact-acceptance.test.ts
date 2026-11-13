import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { runWorkflow, tryTerminateOnTerminalState, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir, terminalArtifactSnapshotName } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import fixture from './fixtures/terminal-repair-publication.json';

let root: string, project: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-acceptance-'));
  project = join(root, 'project'); mkdirSync(join(project, 'docs'), { recursive: true });
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

async function execute(writer: 'author' | 'repair' | 'prepare' | 'absent' | 'identical' | 'review' | 'counterfeit' | 'rejected') {
  // prepare is an ordinary authorized author. Planning scope is metadata; the
  // gate remains read-only. late was the sole final owner under old admission.
  const workflow = WorkflowConfigSchema.parse({ name: 'terminal-publication',
    defaults: { max_iterations: 1, max_retries: 0 }, stages: [
      { id: 'prepare', role: 'coder', scope: [fixture.terminalPath] },
      { id: 'author', role: 'coder', depends_on: ['prepare'], scope: [fixture.terminalPath] },
      { id: 'late', role: 'coder', depends_on: ['author'], scope: [fixture.terminalPath] },
      { id: 'review', role: 'qa', is_gate: true, depends_on: ['late'], scope: [] },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [fixture.terminalPath] },
    ],
  });
  if (writer === 'repair') {
    workflow.stages = workflow.stages.filter(stage => !['prepare', 'late'].includes(stage.id));
    workflow.stages.find(stage => stage.id === 'author')!.depends_on = [];
    workflow.stages.find(stage => stage.id === 'review')!.depends_on = ['author'];
  }
  if (writer === 'identical') writeFileSync(join(project, fixture.terminalPath), fixture.content);
  const files = { [fixture.terminalPath]: fixture.content };
  const review = (pass: boolean, reason = 'Independent result review.') => ({
    runFiles: { 'verdict_review.json': JSON.stringify({ pass, reason }) },
  });
  const adapter = new ScriptedAdapter({
    prepare: { output: 'Preparation completed.', ...(writer === 'prepare' ? { projectFiles: files } : {}) },
    author: { output: 'Author completed.', ...(['author', 'identical', 'counterfeit', 'rejected'].includes(writer) ? { projectFiles: files } : {}) },
    late: { output: 'Required work completed without rewriting the result.' },
    review: writer === 'repair' ? fixture.reviews.map(verdict => review(verdict.pass, verdict.reason))
      : { ...review(writer !== 'rejected'), ...(writer === 'review' ? { projectFiles: files } : {}) },
    repair: { output: 'Authorized repair completed.', ...(writer === 'repair' ? { projectFiles: files } : {}) },
  });
  const original = adapter.run.bind(adapter);
  adapter.run = async (prompt, role, opts) => {
    const result = await original(prompt, role, opts);
    if (writer === 'identical' && opts.stageId === 'author') {
      const touched = new Date(Date.now() + 1000);
      utimesSync(join(project, fixture.terminalPath), touched, touched);
    }
    if (writer === 'counterfeit' && opts.stageId === 'author') {
      writeFileSync(runRecordPath(opts.runDir, 'workflow.yaml'), 'counterfeit engine approval');
    }
    return result;
  };
  const state = await runWorkflow(workflow, '', project, withConfirmedRejections(adapter), new Map(), undefined,
    join(import.meta.dirname, '../config/agents'), undefined,
    `---\nterminal_states:\n  complete: [${fixture.terminalPath}]\n---\nProduce a reviewed result.\n`, true);
  return { state, adapter };
}

describe('declared terminal artifact acceptance', () => {
  it('counts the scrubbed repair publication after the subsequent review passes', async () => {
    const { state, adapter } = await execute('repair');
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.author.attempts?.flatMap(attempt => attempt.writes ?? [])).toEqual(fixture.authorWrites);
    expect(state.stages.repair.attempts?.[0].writes).toEqual(fixture.repairWrites);
    expect(state.stages.review.attempts).toHaveLength(2);
    expect(state.stages.review.gate?.pass).toBe(true);
    expect(adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId))
      .toEqual(['author', 'review', 'repair', 'review']);
    expect(readFileSync(join(project, fixture.terminalPath), 'utf8')).toBe(fixture.content);
  });

  it.each(['author', 'prepare'] as const)('counts the authorized %s without final-owner attribution', async writer => {
    const { state } = await execute(writer);
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.late.attempts?.flatMap(attempt => attempt.writes ?? [])).toEqual([]);
  });

  it('uses current content and gate evidence when write attribution is superseded', async () => {
    const { state } = await execute('author');
    expect(state.status).toBe('complete');
    state.stages.author.writes = [];
    state.stages.author.attempts![0] = {
      ...state.stages.author.attempts![0], status: 'failed', disposition: 'superseded', writes: [],
    };
    state.status = 'running';
    delete state.terminalArtifact;
    const result = await tryTerminateOnTerminalState(state, {
      projectDir: project, runId: state.runId, runDirPath: runDir(project, state.runId), iteration: 1,
      stages: [],
    });
    expect(result.decision).toBe('matched');
    expect(state.status).toBe('complete');
  });

  it('refuses unchanged launch content even when rewritten and touched', async () => {
    const { state } = await execute('identical');
    expect(state.stages.author.status).toBe('complete');
    expect(state.stages.review.gate?.pass).toBe(true);
    expect(state.status).toBe('incomplete');
    expect(state.failureReason).toContain('content is unchanged');
  });

  it('refuses an absent terminal artifact after a passing gate', async () => {
    const { state } = await execute('absent');
    expect(state.stages.review.gate?.pass).toBe(true);
    expect(state.status).toBe('incomplete');
    expect(state.failureReason).toContain(`${fixture.terminalPath} is absent`);
  });

  it('does not substitute an engine snapshot for an absent declared artifact', async () => {
    const { state } = await execute('absent');
    const directory = runDir(project, state.runId);
    const snapshot = runRecordPath(directory, terminalArtifactSnapshotName(fixture.terminalPath));
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, fixture.content);
    state.status = 'running';
    const result = await tryTerminateOnTerminalState(state, {
      projectDir: project, runId: state.runId, runDirPath: directory, iteration: 1, stages: [],
    });
    expect(result.decision).toBe('not_matched');
    expect(state.status).toBe('running');
  });

  it('refuses unauthorized reviewer writes through existing write enforcement', async () => {
    const { state } = await execute('review');
    expect(state.stages.review.attempts?.[0].constraintAudit?.violationCount).toBeGreaterThan(0);
    expect(readFileSync(join(project, fixture.terminalPath), 'utf8')).toBe(fixture.content);
    expect(state.status).not.toBe('complete');
  });

  it('refuses counterfeit engine records before publication', async () => {
    const { state } = await execute('counterfeit');
    expect(state.stages.author.attempts?.[0]).toMatchObject({ status: 'failed', exitCode: 125, engineVoid: true });
    expect(state.status).not.toBe('complete');
    expect(readFileSync(runRecordPath(runDir(project, state.runId), 'workflow.yaml'), 'utf8')).not.toContain('counterfeit');
  });

  it('refuses a status unsupported by the gate outcome', async () => {
    const { state } = await execute('rejected');
    expect(readFileSync(join(project, fixture.terminalPath), 'utf8')).toBe(fixture.content);
    expect(state.status).not.toBe('complete');
    expect(state.stages.review.gate?.pass).toBe(false);
  });
});
