import { resolveImmutableEvidenceBindings, firstImmutableEvidenceConflict } from '../src/scheduler/sched_scope/path-capabilities.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { loadWorkflow, } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
import { fcGlobalDir, setFcGlobalDir, runDir, readRunState, writeRunState, writeStageStatus, writeStageOutput } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { parseBriefFrontmatter, entryWorkflow } from '../src/scheduler/sched_admission/brief-contract.js';
import { inspectBrief } from '../src/brief-preflight.js';
import { literalProjectScope } from '../src/scheduler/sched_admission/scope-services.js';
import { initializeResearchInstrument, researchInstrumentState, researchDirectory, researchAuthorContext } from '../src/research-measurement.js';
import { runResearchLoop, researchStages, admitResearchStages, researchReviewContract } from '../src/scheduler/sched_policy/research.js';
import { type ResearchConfig } from '../src/research-instrument.js';
import { makeInstrument } from './test-support/research-instrument-fixture.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { reconcileResearchConclusion, cancelRunStateAtPath, projectResearchConclusion } from '../src/scheduler/sched_policy/run-completion.js';
import { captureEngineCheckpoint, reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { createRun } from './test-support/create-run.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import * as engineFiles from '../src/engine-fs.js';
import * as commands from '../src/adapters/base.js';
import * as researchOwner from '../src/scheduler/sched_policy/research.js';
import { readRunEvents } from '../src/run-events.js';
import { runLand } from '../src/cli-land.js';
import { renderRunSummary } from '../src/run-summary.js';
import { scheduleDeadline } from '../src/attempt-deadline.js';
import { controlResearchTime, manualResearchClock as manualClock } from './test-support/research-clock.js';
import type { Adapter } from '../src/adapters/base.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { TaskRegistry } from '../src/task-registry.js';
import { claimLaunchIntent, releaseLaunchIntent, withProjectWriteOwnership, readRunLockWaits } from '../src/run-lock.js';
import { readEvidence, captureProjectTree, validationForTree } from '../src/evidence-ledger.js';
import * as validationOwner from '../src/project-validation.js';
import * as validationBoundary from '../src/scheduler/sched_settlement/gate-validation.js';

const agents = join(import.meta.dirname, '../config/agents');
const delivered = JSON.stringify({ status: 'delivered', summary: 'Advisory author note: keep -999999; claimed measurement 1.', caveats: [], remaining_work: [], blocks: null });
let root: string, project: string, previousStore: string;
let time: ReturnType<typeof controlResearchTime>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'research-loop-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ max_iterations: 1, max_retries: 0, stage_technical_retries: 0, gate_retry_loops: 0 });
  isolatedProjectCommand('git', ['init', '-q', '--separate-git-dir', join(root, 'git')], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline'], project, root);
  time = controlResearchTime();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function researchReady(child: ReturnType<typeof spawn>, closed: Promise<unknown>) {
  return Promise.race([
    once(child, 'message').then(([message]) => message as { runId: string; directory: string }),
    closed.then(() => { throw new Error('Research scheduler closed before readiness'); }),
  ]);
}

function brief(edit: (config: ResearchConfig) => void = () => {}) {
  const config = makeInstrument(project, { publication: 'reports/result.md', budget: { max_rounds: 1, invocation_seconds: 10 } });
  edit(config); return `---\n${stringify({ research: config })}---\nPropose candidates within the declared mechanism.\n`;
}
function verdict(config: ResearchConfig, pass = true) {
  const criteria = extractBriefCriteria(researchReviewContract(config)).criteria;
  return JSON.stringify({ pass, reason: pass ? 'Project criteria hold.' : 'Project criterion failed.', remaining_work: [],
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: pass ? 'pass' : 'fail', evidence: 'Independent project property inspection.' }])),
    audit_findings: { version: 1, findings: [] }, ...(pass ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: 'Another candidate can satisfy the project criterion.' } }) });
}
const proposal = (value?: number, extra = {}) => new ScriptedAdapter({ produce: { output: delivered,
  ...(value === undefined ? {} : { projectFiles: { 'candidate.json': JSON.stringify({ value, ...extra }) } }) } });
async function run(text: string, adapter: ScriptedAdapter) {
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
  const state = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, text, true);
  return { state, directory: runDir(project, state.runId) };
}

/** Recreate the old engine's durable boundary; new runs hand facts to review. */
function historicValidationPause() {
  const validate = validationBoundary.validateSettledTree;
  return vi.spyOn(validationBoundary, 'validateSettledTree').mockImplementation(async (project, runId) => {
    const ready = await validate(project, runId);
    if (!readEvidence(runDir(project, runId)).some(entry => entry.kind === 'validation')) return ready;
    const state = readRunState(project, runId);
    state.status = 'parked';
    state.recovery = { kind: 'resumable', cause: 'unknown', at: new Date().toISOString(), interruptedStages: [], reason: 'Validation unfinished' };
    writeRunState(project, runId, state);
    return false;
  });
}

describe('versioned declaration-owned research loop', () => {
  it('engine-runs-it: research report publication cannot inherit validation from an earlier tree', async () => {
    const text = brief(config => { config.budget.invocation_seconds = 30; config.publication = 'report.md'; });
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'check.cjs'), "process.exit(require('node:fs').existsSync('report.md')?7:0);");
    writeFileSync(join(project, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.cjs'] } } }));
    const { state, directory } = await run(text, proposal(200));
    expect(existsSync(join(project, 'report.md'))).toBe(true);
    const records = readEvidence(directory).filter(entry => entry.kind === 'validation');
    expect(records).toHaveLength(2); expect(records.every(record => record.pass)).toBe(true);
    expect(validationForTree(records, captureProjectTree(project, text, directory).hash!)).toBeUndefined();
    expect(state.status).toBe('incomplete'); expect(state.reasonCode).toBe('validation_unresolved');
    expect(state.validation?.map(command => command.exitCode)).toEqual([null]);
    expect(readRunState(project, state.runId).validation).toEqual(state.validation);
  });

  it('engine-runs-it: a restored research baseline requires its own completed validation for acceptance', async () => {
    const text = brief(config => { config.budget.invocation_seconds = 30; delete config.publication; });
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'check.cjs'), "process.exit(JSON.parse(require('node:fs').readFileSync('candidate.json','utf8')).value===200?0:7);");
    writeFileSync(join(project, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.cjs'] } } }));
    const { state, directory } = await run(text, proposal(200));
    expect(read(join(project, 'candidate.json')).value).toBe(100);
    expect(state.status).toBe('incomplete'); expect(state.reasonCode).toBe('validation_unresolved');
    expect(state.validation?.map(command => command.exitCode)).toEqual([7]);
    const records = readEvidence(directory).filter(entry => entry.kind === 'validation');
    expect(records).toHaveLength(2); expect(records.map(record => record.pass)).toEqual([true, false]);
    expect(records[1].treeHash).toBe(captureProjectTree(project, text, directory).hash);
  });

  it('unfinished-is-resource-state: expired historic research resume settles validation before stopping without another author or review', async () => {
    const text = brief(config => { config.budget.invocation_seconds = 30; config.budget.wall_seconds = 300;
      config.review = { role: 'qa', criteria: ['Check candidate value'] }; delete config.publication; });
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'check.cjs'), 'process.exit(0);');
    writeFileSync(join(project, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.cjs'] } } }));
    setEngineDefaults({ validation_attempts: 1 });
    const runner = vi.spyOn(validationOwner, 'runValidationCommand').mockResolvedValue({ exitCode: null, unfinished: true });
    const adapter = proposal(80);
    const pause = historicValidationPause();
    const { state: parked } = await run(text, adapter);
    pause.mockRestore();
    expect(parked.status).toBe('parked');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['produce']);
    setEngineDefaults({ validation_attempts: 2 }); runner.mockImplementation(validationOwner.runProjectCommand);
    time.advanceTo(600_000);
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const resumed = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, parked.runId, text, true);
    expect(resumed.status).toBe('incomplete'); expect(resumed.reasonCode).toBe('validation_unresolved');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['produce']);
    expect(resumed.stages.produce.attempts).toHaveLength(1); expect(resumed.stages.review.attempts ?? []).toHaveLength(0);
    const records = readEvidence(runDir(project, resumed.runId)).filter(entry => entry.kind === 'validation');
    expect(records.map(record => record.resourceState)).toEqual(['unfinished', 'complete']);
    expect(records.at(-1)?.executions.map(execution => execution.commands[0].exitCode)).toEqual([null, 0]);
    expect(readRunEvents(project, resumed.runId).filter(event => event.type === 'stage_complete').map(event => event.stageId)).toEqual(['produce']);
  });

  it.each([false, true])('unfinished-is-resource-state: research review consumes recorded author validation (historic pause=%s)', async historic => {
    const text = brief(config => { config.budget.invocation_seconds = 30; config.review = { role: 'qa', criteria: ['Check candidate value'] }; });
    mkdirSync(join(project, 'config'));
    writeFileSync(join(project, 'check.cjs'), 'process.exit(0);');
    writeFileSync(join(project, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.cjs'] } } }));
    setEngineDefaults({ validation_attempts: 1 });
    const runner = vi.spyOn(validationOwner, 'runValidationCommand').mockResolvedValue({ exitCode: null, unfinished: true });
    const calls: string[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'produce') {
        writeFileSync(join(project, 'candidate.json'), '{"value":80}');
        return { output: delivered, exitCode: 0, duration_ms: 1, writes: ['candidate.json'], writeAttribution: 'structured' };
      }
      const fact = readEvidence(opts.runDir).filter(entry => entry.kind === 'validation').at(-1)!;
      expect(fact.resourceState).toBe(historic ? 'complete' : 'unfinished');
      expect(fact.treeHash).toBe(captureProjectTree(project, text, opts.runDir).hash);
      expect(fact.executions.map(execution => execution.commands.map(command => command.exitCode))).toEqual(historic ? [[null], [0]] : [[null]]);
      expect(prompt).toContain(JSON.stringify(fact));
      return { output: verdict(parseBriefFrontmatter(text).research!), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const execute = (existing?: string) => runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, existing, text, true);
    const pause = historic ? historicValidationPause() : undefined;
    let resumed = await execute();
    pause?.mockRestore();
    if (historic) {
      expect(resumed.status).toBe('parked'); expect(calls).toEqual(['produce']);
      setEngineDefaults({ validation_attempts: 2 }); runner.mockImplementation(validationOwner.runProjectCommand);
      resumed = await execute(resumed.runId);
    }
    expect(resumed.status).toBe('incomplete'); expect(resumed.reasonCode).toBe('validation_unresolved');
    expect(resumed.validation?.map(command => command.exitCode)).toEqual([null]); expect(calls).toEqual(['produce', 'review']);
    expect(resumed.stages.produce.attempts).toHaveLength(1); expect(resumed.stages.review.attempts).toHaveLength(1);
    const fact = readEvidence(runDir(project, resumed.runId)).filter(entry => entry.kind === 'validation').at(-1)!;
    expect(fact.executions).toHaveLength(historic ? 2 : 1);
    expect(runner).toHaveBeenCalledTimes(historic ? 2 : 1);
    expect(readRunEvents(project, resumed.runId).filter(event => event.type === 'stage_complete').map(event => event.stageId)).toEqual(['produce', 'review']);
  });
  it('runs initialize → keep → reject with stop → finalize, publishes the project report and restores best', async () => {
    const text = brief(config => { config.budget.max_rounds = 5; config.budget.wall_seconds = 300; });
    const contexts: any[] = [];
    const adapter = new ScriptedAdapter({ produce: [
      { output: delivered, projectFiles: { 'candidate.json': '{"value":80}' } },
      { output: delivered, projectFiles: { 'candidate.json': '{"value":200,"stop":true}' } },
    ] });
    const execute = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => {
      const line = prompt.split('Committed instrument context (lossless JSON):\n')[1]?.split('\n')[0];
      expect(line).toBeDefined(); contexts.push(JSON.parse(line!)); return execute(prompt, role, opts);
    };
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('complete'); expect(state.failureReason).toBe('instrument_stop');
    expect(adapter.calls.map(c => c.stageId)).toEqual(['produce', 'produce']);
    const manifest = read(runRecordPath(directory, 'research_manifest.json'));
    expect(manifest.engine_stop_reason).toBe('instrument_stop');
    expect(manifest.history.map((h: any) => h.outcome)).toEqual(['baseline', 'keep', 'reject', 'finalized']);
    expect(manifest.incumbent).toEqual(manifest.history[1].candidate);
    expect(researchInstrumentState(directory).incumbent).toEqual(manifest.incumbent);
    expect(read(join(project, 'candidate.json')).value).toBe(80);
    expect(contexts.map(c => c.history.length)).toEqual([1, 2]);
    expect(JSON.stringify(contexts[1].history[1].response.diagnostics)).toBe(JSON.stringify(manifest.history[1].response.diagnostics));
    expect(JSON.stringify(contexts[1].history[1].response.observations)).toBe(JSON.stringify(manifest.history[1].response.observations));
    expect(JSON.stringify(contexts[1].previous_state)).toBe(JSON.stringify(manifest.history[1].response.next_state));
    expect(manifest.history.map((h: any) => h.phase)).toEqual(['initialize', 'evaluate', 'evaluate', 'finalize']);
    expect(manifest.history.map((h: any) => h.round)).toEqual([0, 1, 2, 2]);
    const requests = manifest.history.map((h: any) => read(h.request.path));
    expect(new Set(requests.map((r: any) => r.invocation_id)).size).toBe(4);
    for (const [n, history] of [[], ['baseline'], ['baseline', 'keep'], ['baseline', 'keep', 'reject']].entries()) {
      const request = requests[n];
      expect(request.protocol).toBe('research-instrument/v1'); expect(request.run_id).toBe(state.runId);
      expect(request.phase).toBe(manifest.history[n].phase); expect(request.round).toBe(manifest.history[n].round);
      expect(request.instrument_sha256).toBe(manifest.instrument_sha256);
      expect(request.history.map((h: any) => h.outcome)).toEqual(history);
      expect(request.initial).toEqual(manifest.initial);
      expect(request.candidate).toEqual(manifest.history[n].candidate);
      expect(request.incumbent).toEqual(n < 2 ? manifest.initial : manifest.incumbent);
      expect(request.previous_state).toEqual(n === 0 ? null : manifest.history[n - 1].response.next_state);
      expect(request.remaining_budget.rounds).toBe([5, 5, 4, 3][n]);
      expect(request.remaining_budget.invocation_ms).toBe(10000);
      expect(request.remaining_budget.wall_ms).toBeGreaterThan(0);
      expect(request.remaining_budget.wall_ms).toBeLessThanOrEqual(n === 0 ? 300000 : requests[n - 1].remaining_budget.wall_ms);
      expect(manifest.history[n].response.diagnostics.readOnly).toEqual({ request: true, candidate: true, instrument: true, config: true });
      for (const entry of request.history) for (const ref of [entry.request, entry.result, entry.raw]) {
        expect(createHash('sha256').update(readFileSync(ref.path)).digest('hex')).toBe(ref.sha256);
      }
    }
    expect(requests[3].engine_stop_reason).toBe('instrument_stop');
    expect(manifest.history[2].response.stop).toEqual({ reason: 'Project is done', outcome: { arbitrary: ['project', 'outcome'] } });
    expect(JSON.stringify(requests[2].history[1].response.diagnostics)).toBe(JSON.stringify(contexts[1].history[1].response.diagnostics));
    expect(JSON.stringify(requests[2].history[1].response.observations.extra)).toBe(JSON.stringify(contexts[1].history[1].response.observations.extra));
    const report = readFileSync(manifest.report.path, 'utf8'); expect(report).toContain('# Project report');
    expect(readFileSync(join(project, 'reports/result.md'), 'utf8')).toBe(report);
    expect(read(runRecordPath(directory, 'research_publication.json')).status).toBe('published');
    expect(renderRunSummary(project, directory, state)).toContain('research-instrument/v1');
  });
  it('cannot turn an author note or forged -999999 into a verdict or observation', async () => {
    const adapter = proposal(); const { state, directory } = await run(brief(), adapter);
    expect(state.status, state.failureReason).toBe('complete');
    const journal = researchInstrumentState(directory);
    expect(journal.history.map(h => h.outcome)).toEqual(['baseline', 'no_candidate', 'finalized']);
    expect(journal.history[1].response).toBeUndefined(); expect(journal.history[1].author).toMatchObject({ summary: expect.stringContaining('-999999') });
    expect(journal.incumbent).toEqual(journal.initial); expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it('keeps a project reject authoritative despite an author claiming keep -999999', async () => {
    const { state, directory } = await run(brief(), proposal(200));
    expect(state.status).toBe('complete');
    const journal = researchInstrumentState(directory), outcome = journal.history[1];
    expect(outcome.author).toMatchObject({ summary: expect.stringContaining('keep -999999') });
    expect(outcome.outcome).toBe('reject'); expect(outcome.response?.observations).toMatchObject({ value: 200 });
    expect(journal.incumbent).toEqual(journal.initial); expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it('spends hard round budget beyond the engineering iteration bound', async () => {
    const adapter = new ScriptedAdapter({ produce: [80, 60, 40].map(value => ({ output: delivered, projectFiles: { 'candidate.json': JSON.stringify({ value }) } })) });
    const { state, directory } = await run(brief(config => { config.budget.max_rounds = 3; }), adapter);
    expect(state.status, state.failureReason).toBe('complete'); expect(state.currentIteration).toBe(3);
    expect(researchInstrumentState(directory).history.map(h => h.outcome)).toEqual(['baseline', 'keep', 'keep', 'keep', 'finalized']);
    expect(read(runRecordPath(directory, 'research_manifest.json')).engine_stop_reason).toBe('round_budget_exhausted');
  });
  it.each([true, false])('runs only a declared review with its project criteria (pass=%s)', async pass => {
    const text = brief(config => { config.review = { role: 'qa', criteria: ['Candidate retains the project property explicitly selected here.'] }; });
    const rc = parseBriefFrontmatter(text).research!;
    const adapter = new ScriptedAdapter({ produce: { output: delivered, projectFiles: { 'candidate.json': '{"value":1}' } }, review: { output: verdict(rc, pass) } });
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('complete'); expect(adapter.calls.map(c => c.stageId)).toEqual(['produce', 'review']);
    expect(adapter.calls[1].prompt).toContain(rc.review!.criteria[0]);
    const history = researchInstrumentState(directory).history;
    expect(history[1]).toMatchObject({ outcome: pass ? 'keep' : 'review_rejected', review: { pass, record: { criteria: JSON.parse(verdict(rc, pass)).criteria } } });
    if (!pass) { expect(history[1].response).toBeUndefined(); expect(read(join(project, 'candidate.json')).value).toBe(100); }
  });
  it('defers a declared publication product until terminal instead of requiring it from candidate review', async () => {
    const text = brief(config => { config.review = { role: 'qa', criteria: ['Candidate satisfies the project compatibility property.'] }; })
      .replace('---\n', '---\noutputs:\n  - {path: reports/result.md}\n');
    const rc = parseBriefFrontmatter(text).research!;
    const adapter = new ScriptedAdapter({ produce: { output: delivered, projectFiles: { 'candidate.json': '{"value":80}' } }, review: { output: verdict(rc) } });
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('complete');
    expect(researchInstrumentState(directory).history[1].outcome).toBe('keep');
    expect(read(join(project, 'candidate.json')).value).toBe(80);
    expect(existsSync(join(project, 'reports/result.md'))).toBe(true);
  });
  it('preserves a declared irreparable review catch without making it a measurement', async () => {
    const text = brief(config => { config.budget.max_rounds = 3; config.review = { role: 'qa', criteria: ['The project once-only operation must not be repeated.'] }; });
    const review = JSON.parse(verdict(parseBriefFrontmatter(text).research!, false));
    review.repairability = { version: 1, disposition: 'irreparable', evidence: 'Project once-only allowance was already spent.' };
    const adapter = new ScriptedAdapter({ produce: { output: delivered, projectFiles: { 'candidate.json': '{"value":1}' } }, review: { output: JSON.stringify(review) } });
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('escalated'); expect(state.reasonCode).toBe('irreparable_gate_rejection');
    expect(researchInstrumentState(directory).history.map(h => h.outcome)).toEqual(['baseline', 'review_rejected', 'finalized']);
    expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it('fails an author execution without measuring unfinished candidate bytes', async () => {
    const { state, directory } = await run(brief(), new ScriptedAdapter({ produce: { exitCode: 1, projectFiles: { 'candidate.json': '{"value":1}' } } }));
    expect(state.status).toBe('failed'); expect(researchInstrumentState(directory).history.map(h => h.phase)).toEqual(['initialize', 'finalize']);
    expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it('fails initialize exit2 before any author and still finalizes committed failure history', async () => {
    const text = brief(); writeFileSync(join(project, 'candidate.json'), '{"value":100,"fail":true}');
    const adapter = proposal(1); const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('failed'); expect(adapter.calls).toEqual([]);
    const history = researchInstrumentState(directory).history;
    expect(history[0]).toMatchObject({ outcome: 'execution_error', reason: 'instrument_exit_2' });
    expect(read(history.at(-1)!.request!.path).history[0].outcome).toBe('execution_error');
  });
  it('refuses an undispatchable author rather than using a fallback candidate', async () => {
    const shape = researchOwner.researchStages;
    vi.spyOn(researchOwner, 'researchStages').mockImplementation(rc => shape(rc).map(stage => ({ ...stage, role: 'missing_role' })));
    const adapter = proposal(1); const { state } = await run(brief(), adapter);
    expect(state.status).toBe('failed'); expect(adapter.calls).toEqual([]);
  });
  it('restores frozen project config when an author attempts a permanent edit', async () => {
    const text = brief(), original = readFileSync(join(project, 'instrument/config.json'), 'utf8');
    isolatedProjectCommand('git', ['add', '.'], project, root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=' + ['fixture', 'example.invalid'].join('@'), 'commit', '-qm', 'Pin frozen instrument'], project, root);
    const adapter = new ScriptedAdapter({ produce: { output: delivered, projectFiles: { 'candidate.json': '{"value":1}', 'instrument/config.json': '{"value":1}' } } });
    const { state, directory } = await run(text, adapter);
    expect(adapter.calls.map(c => c.stageId)).toEqual(['produce']); expect(state.status).toBe('failed');
    expect(readFileSync(join(project, 'instrument/config.json'), 'utf8')).toBe(original);
    expect(researchInstrumentState(directory).history.some(h => h.phase === 'evaluate')).toBe(false);
    expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it.each(['instrument/config.json', 'instrument/run.cjs'])('detects transient author edits of frozen %s even when bytes are restored', async target => {
    const text = brief(); const adapter = proposal(1); const execute = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => {
      const path = join(project, target), before = readFileSync(path, 'utf8');
      writeFileSync(path, '{}'); writeFileSync(path, before); return execute(prompt, role, opts);
    };
    const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('failed'); expect(read(runRecordPath(directory, 'research_manifest.json')).engine_stop_reason).toBe('frozen_inputs_changed');
    expect(researchInstrumentState(directory).history.some(h => h.phase === 'evaluate')).toBe(false);
  });
  it('replays finalizer settlement and its stop intent without restarting an author after a manifest crash', async () => {
    const text = brief(config => { config.budget.max_rounds = 3; }); const rc = parseBriefFrontmatter(text).research!;
    const stages = researchStages(rc), { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml')); config.stages = stages;
    const created = createRun(project, 'research', stringify(config), stages.map(s => s.id), text);
    const state = readRunState(project, created.runId); state.research = rc; writeRunState(project, state.runId, state);
    const write = engineFiles.atomicWrite;
    const crash = vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (path === runRecordPath(created.runDirPath, 'research_manifest.json')) throw new Error('controlled manifest crash');
      return write(path, data, options);
    });
    await expect(runResearchLoop(project, state.runId, created.runDirPath, config, new ScriptedAdapter({ produce: { exitCode: 1 } }), new Map(), agents, undefined, text)).rejects.toThrow('controlled manifest crash');
    crash.mockRestore(); const spawn = vi.spyOn(commands, 'spawnOwnedCommand'), adapter = proposal(1);
    const settled = await runResearchLoop(project, state.runId, created.runDirPath, config, adapter, new Map(), agents, undefined, text);
    expect(settled.status).toBe('failed'); expect(settled.reasonCode).toBe('stage_failed');
    expect(adapter.calls).toEqual([]); expect(spawn).not.toHaveBeenCalled();
    expect(read(runRecordPath(created.runDirPath, 'research_manifest.json')).engine_stop_reason).toBe('author_execution_error');
    expect(researchInstrumentState(created.runDirPath).history.map(h => h.phase)).toEqual(['initialize', 'finalize']);
  });
  it('preserves retained author work across continuation and measures only its completed submission', async () => {
    const text = brief(config => { config.budget.max_rounds = 3; }); const rc = parseBriefFrontmatter(text).research!;
    const stages = researchStages(rc); const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml')); config.stages = stages;
    const created = createRun(project, 'research', stringify(config), stages.map(s => s.id), text);
    await initializeResearchInstrument(project, created.runDirPath, rc);
    const state = readRunState(project, created.runId); state.research = rc; state.currentIteration = 1;
    state.stages.produce = { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'work/stages/produce/output_attempt_1.md' } };
    writeStageStatus(project, created.runId, 'produce', state.stages.produce);
    writeStageOutput(project, created.runId, 'produce', JSON.stringify({ ...JSON.parse(delivered), remaining_work: ['Candidate unfinished.'] }));
    writeRunState(project, created.runId, state); writeFileSync(join(project, 'candidate.json'), '{"value":50}');
    const adapter = proposal(25, { stop: true }); const execute = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => { expect(read(join(project, 'candidate.json')).value).toBe(50); return execute(prompt, role, opts); };
    const settled = await runResearchLoop(project, state.runId, created.runDirPath, config, adapter, new Map(), agents, undefined, text);
    expect(settled.status, settled.failureReason).toBe('complete');
    expect(researchInstrumentState(created.runDirPath).history.map(h => h.outcome)).toEqual(['baseline', 'keep', 'finalized']);
    expect(read(join(project, 'candidate.json')).value).toBe(25);
  });
  it('finishes a retained project review before evaluating the submitted snapshot', async () => {
    const text = brief(config => { config.review = { role: 'qa', criteria: ['Preserve the declared project property.'] }; });
    const rc = parseBriefFrontmatter(text).research!, stages = researchStages(rc);
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml')); config.stages = stages;
    const created = createRun(project, 'research', stringify(config), stages.map(s => s.id), text);
    await initializeResearchInstrument(project, created.runDirPath, rc);
    const state = readRunState(project, created.runId); state.research = rc; state.currentIteration = 1;
    state.stages.produce = { status: 'complete', retries: 0 };
    state.stages.review = { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'work/stages/review/output_attempt_1.md' } };
    for (const stage of stages) writeStageStatus(project, state.runId, stage.id, state.stages[stage.id]);
    writeStageOutput(project, state.runId, 'produce', delivered); writeStageOutput(project, state.runId, 'review', verdict(rc));
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_review.json'), verdict(rc));
    writeRunState(project, state.runId, state); writeFileSync(join(project, 'candidate.json'), '{"value":50}');
    const adapter = new ScriptedAdapter({ review: { output: verdict(rc, false) } });
    const result = await runResearchLoop(project, state.runId, created.runDirPath, config, adapter, new Map(), agents, undefined, text);
    expect(result.status).toBe('complete'); expect(adapter.calls.map(c => c.stageId)).toEqual(['review']);
    expect(researchInstrumentState(created.runDirPath).history.map(h => h.outcome)).toEqual(['baseline', 'review_rejected', 'finalized']);
    expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
});

it.each([false, true])('settles declared allowance handoffs without measuring unfinished author work (exhausted=%s)', async exhausted => {
  setEngineDefaults({ max_iterations: 3, max_retries: 0, stage_technical_retries: 0, gate_retry_loops: 0 });
  let text = brief(config => { config.budget.max_rounds = 3; }).replace('---\n', '---\nstage_duration_ms: 20000\n');
  if (exhausted) text = text.replace('---\n', '---\nmax_continuations: 0\n');
  let time = manualClock(); const calls: string[] = [];
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(`${opts.attemptIndex}:${prompt.includes('# Stage budget wrap-up') ? 'wrap' : 'ordinary'}`);
    if (opts.attemptIndex === 1) {
      if (!prompt.includes('# Stage budget wrap-up')) {
        writeFileSync(join(project, 'candidate.json'), '{"value":80}');
        time.advanceTo(20000);
        return { exitCode: 137, output: 'Closed at warning.', duration_ms: 1 };
      }
      return { exitCode: 0, output: JSON.stringify({ ...JSON.parse(delivered), remaining_work: ['Finish the candidate.'] }), duration_ms: 1 };
    }
    writeFileSync(join(project, 'candidate.json'), '{"value":50,"stop":true}');
    return { exitCode: 0, output: delivered, duration_ms: 1 };
  } };
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
  const result = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, text, true, undefined, true, undefined,
    () => { time = manualClock(); return time.clock; });
  const journal = researchInstrumentState(runDir(project, result.runId));
  expect(result.status).toBe(exhausted ? 'incomplete' : 'complete');
  expect(calls).toEqual(exhausted ? ['1:ordinary'] : ['1:ordinary', '2:ordinary']);
  expect(journal.history.map(h => h.outcome)).toEqual(exhausted ? ['baseline', 'finalized'] : ['baseline', 'keep', 'finalized']);
  expect(result.stages.produce.attempts?.[0].continuation).toBeDefined();
  expect(read(join(project, 'candidate.json')).value).toBe(exhausted ? 100 : 50);
});
it('uses overflow-safe timer chunks without extending the absolute hard deadline', () => {
  const time = manualClock(), expired = vi.fn(), duration = 3_000_000_000;
  const cancel = scheduleDeadline(expired, () => duration - time.clock.monotonicNow(), time.clock);
  expect([...time.timers.values()].map(timer => timer.at)).toEqual([2_147_483_647]);
  time.advanceTo(2_147_483_647); expect(expired).not.toHaveBeenCalled();
  expect([...time.timers.values()].map(timer => timer.at)).toEqual([duration]);
  time.advanceTo(duration); expect(expired).toHaveBeenCalledTimes(1); cancel(); expect(time.timers.size).toBe(0);
});
it('retires author work at the absolute wall cap even inside an attempt finishing interval', async () => {
  const text = brief(config => { config.budget.wall_seconds = 60; });
  const events: string[] = [];
  let authorPid = 0;
  let authorResult: Awaited<ReturnType<typeof commands.execWithStdin>> | undefined;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    const markAbort = () => { events.push('abort'); };
    if (opts.abortSignal?.aborted) markAbort(); else opts.abortSignal?.addEventListener('abort', markAbort, { once: true });
    const result = await commands.execWithStdin(process.execPath, ['-e', 'console.log("PID=" + process.pid); setInterval(() => {}, 1000)'], '', {
      cwd: project, timeout_ms: 15000, abortSignal: opts.abortSignal,
      onChild: ({ pid }) => { authorPid = pid ?? 0; },
      onStdout: text => {
        if (!text.includes('PID=')) return;
        events.push('ready');
        time.advanceTo(4999);
        expect(opts.abortSignal?.aborted).toBe(false);
        events.push('before-cap');
        time.advanceTo(5000);
        expect(opts.abortSignal?.aborted).toBe(true);
      },
    });
    events.push('closed'); authorResult = result;
    return result;
  } };
  const rc = parseBriefFrontmatter(text).research!, stages = researchStages(rc);
  const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml')); config.stages = stages;
  const created = createRun(project, 'research', stringify(config), stages.map(s => s.id), text);
  await initializeResearchInstrument(project, created.runDirPath, rc);
  // A resumed fixture has already spent 55 seconds. Freeze/setup is complete
  // before advancing its last five logical seconds after child readiness.
  const initial = readRunState(project, created.runId); initial.research = rc;
  initial.engineCheckpoint = captureEngineCheckpoint(project, initial.runId);
  initial.startedAt = new Date(Date.now() - 55000).toISOString();
  const measured = researchInstrumentState(created.runDirPath);
  measured.startedAt = initial.startedAt; measured.deadline = Date.parse(initial.startedAt) + 60000;
  engineFiles.atomicWrite(join(researchDirectory(created.runDirPath), 'state.json'), JSON.stringify(measured));
  writeRunState(project, initial.runId, initial);
  const state = await runResearchLoop(project, initial.runId, created.runDirPath, config, adapter, new Map(), agents, undefined, text, undefined, () => time.clock);
  expect(authorPid).toBeGreaterThan(0);
  expect(events).toEqual(['ready', 'before-cap', 'abort', 'closed']);
  expect(authorResult).toMatchObject({ exitCode: 137, processSignal: 'SIGTERM', timedOut: false });
  expect(() => process.kill(authorPid, 0)).toThrow();
  const manifest = read(runRecordPath(runDir(project, state.runId), 'research_manifest.json'));
  expect(manifest.engine_stop_reason).toBe('wall_budget_exhausted');
  expect(manifest.history.some((h: any) => h.phase === 'evaluate')).toBe(false);
});

describe('terminal publication is separate and never recovered into project files', () => {
  it('keeps the project report run-local when no publication destination is declared', async () => {
    const { state, directory } = await run(brief(config => { delete config.publication; }), proposal(50));
    expect(state.status).toBe('complete'); expect(existsSync(runRecordPath(directory, 'research_report.md'))).toBe(true);
    expect(existsSync(join(project, 'reports'))).toBe(false);
    expect(existsSync(runRecordPath(directory, 'research_publication.json'))).toBe(false);
  });
  it('refuses a physical publication alias into frozen config without changing the run result', async () => {
    const text = brief(config => { config.publication = 'report-alias/config.json'; });
    const before = readFileSync(join(project, 'instrument/config.json'));
    symlinkSync('instrument', join(project, 'report-alias'));
    const { state, directory } = await run(text, proposal(50));
    expect(state.status).toBe('complete');
    expect(read(runRecordPath(directory, 'research_publication.json'))).toMatchObject({ status: 'failed', error: expect.stringContaining('publication overlaps instrument inputs') });
    expect(readFileSync(join(project, 'instrument/config.json'))).toEqual(before);
  });
  it('removing a published report and its parent cannot flip the finished run status', async () => {
    const { state, directory } = await run(brief(), proposal(50)); expect(state.status).toBe('complete');
    const before = readFileSync(join(directory, 'run.json'), 'utf8'); const manifest = readFileSync(runRecordPath(directory, 'research_manifest.json'), 'utf8');
    rmSync(join(project, 'reports'), { recursive: true });
    const writes = vi.spyOn(engineFiles, 'atomicWrite');
    expect(reconcileHostInterruptedRun(project, state.runId).status).toBe('complete');
    expect(reconcileResearchConclusion(project, state.runId).status).toBe('complete');
    projectResearchConclusion(readRunState(project, state.runId), () => { throw new Error('Unexpected result mutation'); });
    expect(existsSync(join(project, 'reports/result.md'))).toBe(false);
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(before);
    expect(readFileSync(runRecordPath(directory, 'research_manifest.json'), 'utf8')).toBe(manifest);
    expect(writes.mock.calls.some(([path]) => String(path).startsWith(join(project, 'reports')))).toBe(false);
  });
  it('land --remove removes the published project worktree without rewriting the recorded result on recovery or reads', async () => {
    const primary = project;
    project = join(root, 'topic-worktree');
    isolatedProjectCommand('git', ['worktree', 'add', '-qb', 'research-topic', project], primary, root);
    const { state, directory } = await run(brief(), proposal(50));
    expect(state.status).toBe('complete');
    isolatedProjectCommand('git', ['add', '.'], project, root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Retain project result'], project, root);
    isolatedProjectCommand('git', ['merge', '--ff-only', 'research-topic'], primary, root);
    const paths = [join(directory, 'run.json'), runRecordPath(directory, 'research_manifest.json'),
      runRecordPath(directory, 'research_report.md'), runRecordPath(directory, 'research_publication.json')];
    const before = paths.map(path => readFileSync(path));
    const report = await runLand(['land', '--run', state.runId, '--remove', '--acknowledge-regenerable=0']);
    expect(report.state, JSON.stringify(report)).toBe('removed');
    expect(existsSync(project)).toBe(false);
    const writes = vi.spyOn(engineFiles, 'atomicWrite');
    expect(reconcileHostInterruptedRun(project, state.runId).status).toBe('complete');
    expect(reconcileResearchConclusion(project, state.runId).status).toBe('complete');
    expect(renderRunSummary(project, directory, readRunState(project, state.runId))).toContain('round_budget_exhausted');
    await expect(runLand(['land', '--run', state.runId])).rejects.toThrow('run project directory does not exist');
    expect(readRunState(project, state.runId).status).toBe('complete');
    expect(existsSync(project)).toBe(false);
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    expect(writes.mock.calls.some(([path]) => String(path).startsWith(project + '/'))).toBe(false);
  });
  it('terminal launch and shared recovery never publish when the receipt is absent', async () => {
    const text = brief(); const { state, directory } = await run(text, proposal(50));
    rmSync(runRecordPath(directory, 'research_publication.json'));
    rmSync(join(project, 'reports'), { recursive: true });
    const before = readFileSync(join(directory, 'run.json'));
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const adapter = proposal(1);
    expect((await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, state.runId, text)).status).toBe('complete');
    expect(reconcileHostInterruptedRun(project, state.runId).status).toBe('complete');
    expect(adapter.calls).toEqual([]);
    expect(existsSync(join(project, 'reports'))).toBe(false);
    expect(existsSync(runRecordPath(directory, 'research_publication.json'))).toBe(false);
    expect(readFileSync(join(directory, 'run.json'))).toEqual(before);
  });
  it('a failed initial publication is recorded without changing the run result or retrying delivery', async () => {
    const text = brief(); writeFileSync(join(project, 'reports'), 'blocks report parent');
    const { state, directory } = await run(text, proposal(50));
    expect(state.status, state.failureReason).toBe('complete');
    expect(read(runRecordPath(directory, 'research_publication.json'))).toMatchObject({ status: 'failed', error: expect.any(String) });
    expect(read(runRecordPath(directory, 'research_manifest.json')).incumbent.sha256).toBe(researchInstrumentState(directory).incumbent.sha256);
    rmSync(join(project, 'reports')); reconcileHostInterruptedRun(project, state.runId);
    expect(existsSync(join(project, 'reports'))).toBe(false); expect(readRunState(project, state.runId).status).toBe('complete');
  });
  it('publication receipt storage failure cannot rewrite a committed run result', async () => {
    const text = brief(), write = engineFiles.atomicWrite;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (String(path).endsWith('/research_publication.json')) throw new Error('controlled publication receipt storage failure');
      return write(path, data, options);
    });
    const { state, directory } = await run(text, proposal(50));
    expect(state.status).toBe('complete'); expect(readRunState(project, state.runId).status).toBe('complete');
    expect(read(runRecordPath(directory, 'research_manifest.json')).engine_stop_reason).toBe('round_budget_exhausted');
    expect(existsSync(join(project, 'reports/result.md'))).toBe(false);
  });
  it('older recovery cannot overwrite a later report at the shared destination', async () => {
    const first = await run(brief(), proposal(50)); const second = await run(brief(), proposal(25));
    const newer = readFileSync(join(project, 'reports/result.md'), 'utf8');
    rmSync(runRecordPath(first.directory, 'research_publication.json'));
    expect(readFileSync(runRecordPath(first.directory, 'research_report.md'), 'utf8')).not.toBe(newer);
    reconcileHostInterruptedRun(project, first.state.runId); reconcileResearchConclusion(project, first.state.runId);
    expect(readFileSync(join(project, 'reports/result.md'), 'utf8')).toBe(newer); expect(readRunState(project, second.state.runId).status).toBe('complete');
    expect(existsSync(runRecordPath(first.directory, 'research_publication.json'))).toBe(false);
  });
  it('a recovery conclusion never publishes a finalized report before first delivery', async () => {
    const text = brief(); const { state, directory } = await run(text, proposal(50));
    rmSync(runRecordPath(directory, 'research_publication.json'));
    rmSync(join(project, 'reports'), { recursive: true });
    const interrupted = readRunState(project, state.runId);
    interrupted.status = 'running'; delete interrupted.engineCheckpoint;
    writeRunState(project, state.runId, interrupted);
    const recovered = reconcileHostInterruptedRun(project, state.runId);
    expect(recovered.reasonCode).toBe('recovery_blocked');
    expect(existsSync(join(project, 'reports'))).toBe(false);
    expect(existsSync(runRecordPath(directory, 'research_publication.json'))).toBe(false);
  });
  it('atomically reserves publication when another terminal publisher wins the receipt race', async () => {
    const text = brief(), write = engineFiles.atomicWrite; let reserved = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (!reserved && String(path).endsWith('/research_publication.json')) {
        reserved = true; write(path, data, { exclusive: true });
      }
      return write(path, data, options);
    });
    const { state, directory } = await run(text, proposal(50));
    expect(reserved).toBe(true); expect(state.status).toBe('complete');
    expect(read(runRecordPath(directory, 'research_publication.json')).status).toBe('started');
    expect(existsSync(join(project, 'reports/result.md'))).toBe(false);
  });
  it('does not repeat a publication after its write acknowledgement is lost', async () => {
    const write = engineFiles.atomicWrite; let writes = 0; const attempts: any[] = [];
    const text = brief(); vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (String(path).endsWith('/research_publication.json')) attempts.push(JSON.parse(String(data)));
      const result = write(path, data, options);
      if (path === join(project, 'reports/result.md')) { writes++; throw new Error('controlled lost publication acknowledgement'); }
      return result;
    });
    const { state, directory } = await run(text, proposal(50)); expect(state.status).toBe('complete');
    reconcileHostInterruptedRun(project, state.runId); projectResearchConclusion(state, () => {});
    expect(writes).toBe(1); expect(read(runRecordPath(directory, 'research_publication.json')).status).toBe('failed');
    expect(attempts.map(a => a.status)).toEqual(['started', 'failed']);
    expect(attempts[0].publication_id).toEqual(expect.any(String));
    expect(new Set(attempts.map(a => a.publication_id)).size).toBe(1);
    expect(attempts[0].run_id).toBe(state.runId);
  });
  it('records cancellation winning between finalizer and terminal commit in the authoritative manifest', async () => {
    const text = brief(), write = engineFiles.atomicWrite; let cancelled = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (!cancelled && String(path).endsWith('/research_manifest.json')) {
        cancelled = true; cancelRunStateAtPath(String(path).slice(0, -'/engine/research_manifest.json'.length), new Date().toISOString());
      }
      return result;
    });
    const { state, directory } = await run(text, proposal(80));
    expect(cancelled).toBe(true); expect(state.status).toBe('cancelled');
    expect(read(runRecordPath(directory, 'research_manifest.json'))).toMatchObject({ engine_stop_reason: 'cancelled', conclusion: { status: 'cancelled' } });
    expect(read(join(project, 'candidate.json')).value).toBe(80);
  });
  it('preserves cancellation and restores best even when author returns a candidate late', async () => {
    const text = brief(); const adapter = proposal(1); const execute = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => { const result = await execute(prompt, role, opts); cancelRunStateAtPath(opts.runDir!, new Date().toISOString()); return result; };
    const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('cancelled'); expect(readRunState(project, state.runId).status).toBe('cancelled');
    expect(read(join(project, 'candidate.json')).value).toBe(100);
    expect(researchInstrumentState(directory).history.some(h => h.phase === 'evaluate')).toBe(false);
  });
  it.each([false, true])('settles native cancellation after SIGTERM retires the scheduler before its research finish closure (deferred=%s)', async deferred => {
    const repo = join(import.meta.dirname, '..'), home = join(root, 'store'), script = join(root, 'scheduler.mts');
    writeFileSync(script, `
      import { writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { loadWorkflow } from ${JSON.stringify(join(repo, 'src/scheduler.ts'))};
      import { runPreparedWorkflow as runWorkflow } from ${JSON.stringify(join(repo, 'spec/test-support/ready-setup.ts'))};
      import { setFcGlobalDir } from ${JSON.stringify(join(repo, 'src/store.ts'))};
      import { makeInstrument } from ${JSON.stringify(join(repo, 'spec/test-support/research-instrument-fixture.ts'))};
      const project = process.argv[2]; setFcGlobalDir(process.argv[3]);
      const research = makeInstrument(project, { publication: 'reports/cancelled.md', budget: { max_rounds: 2, invocation_seconds: 10 } });
      const brief = '---\\n' + JSON.stringify({ research }) + '\\n---\\nPropose candidates.\\n';
      const { config, raw } = loadWorkflow(${JSON.stringify(join(repo, 'config/workflows/entry.yaml'))});
      const adapter = { async run(_prompt, _role, opts) {
        writeFileSync(join(project, 'candidate.json'), '{"value":1}');
        process.send({ runId: JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId, directory: opts.runDir });
        await new Promise(() => {});
        return { exitCode: 0, duration_ms: 1, output: ${JSON.stringify(delivered)} };
      } };
      await runWorkflow(config, raw, project, adapter, new Map(), undefined, ${JSON.stringify(agents)}, undefined, brief);
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', script, project, home], {
      cwd: repo, env: { ...process.env, HOME: root, FC_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closed = once(child, 'close'), ready = researchReady(child, closed);
    child.stdout.resume(); child.stderr.resume();
    try {
      const binding = await ready;
      const units = { isActive: async () => ({ kind: 'absent' as const }), stopUnit: async () => {}, runUnit: async () => {}, journalTail: async () => '' };
      const options = { registry: new TaskRegistry({ baseDir: home }), units, runsDir: join(home, 'runs'),
        signalGraceMs: 100, timeoutMs: 1500,
        isSchedulerPidAlive: (pid: number) => pid === child.pid && child.exitCode === null && child.signalCode === null,
        canSignalScheduler: (pid: number) => pid === child.pid,
        signalScheduler: (pid: number, signal: NodeJS.Signals) => { expect(pid).toBe(child.pid); child.kill(signal); },
      };
      if (deferred) {
        const unbound = new RunCancellationCoordinator({ ...options, signalGraceMs: 0, timeoutMs: 0, canSignalScheduler: () => false });
        const pending = await unbound.cancelRun(binding.runId);
        expect(pending.observation.schedulerAlive).toBe(true);
        expect(readRunState(project, binding.runId).status).toBe('cancelled');
        expect(read(join(project, 'candidate.json')).value).toBe(1);
        expect(existsSync(runRecordPath(binding.directory, 'research_manifest.json'))).toBe(false);
      }
      const coordinator = new RunCancellationCoordinator(options);
      const result = await coordinator.cancelRun(binding.runId); await closed;
      expect(child.signalCode).toBe('SIGTERM'); expect(result.status).toBe('cancelled');
      expect(result.observation.schedulerAlive).toBe(false); expect(result.observation.activeCommandPids ?? []).toEqual([]);
      expect(readRunState(project, binding.runId).status).toBe('cancelled');
      expect(researchInstrumentState(binding.directory).incumbent.label).toBe('baseline');
      expect(read(join(project, 'candidate.json')).value).toBe(100);
      const manifestPath = runRecordPath(binding.directory, 'research_manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = read(manifestPath);
      expect(manifest).toMatchObject({ engine_stop_reason: 'cancelled', conclusion: { status: 'cancelled' }, incumbent: { label: 'baseline' },
        finalizer: { outcome: 'execution_error', reason: expect.stringContaining('research_cancelled') } });
      expect(read(manifest.finalizer.raw.path).started).toBe(false);
      expect(manifest.history.some((h: any) => h.phase === 'evaluate')).toBe(false);
      const settled = readFileSync(manifestPath, 'utf8');
      reconcileHostInterruptedRun(project, binding.runId); await coordinator.cancelRun(binding.runId);
      expect(readFileSync(manifestPath, 'utf8')).toBe(settled);
      expect(readRunState(project, binding.runId).status).toBe('cancelled');
      expect(existsSync(join(project, 'reports/cancelled.md'))).toBe(false);
      expect(existsSync(runRecordPath(binding.directory, 'research_publication.json'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 30000);
  it.each(['live', 'complete'])('delayed cancellation preserves a newer %s run\'s project write ownership', async successor => {
    const repo = join(import.meta.dirname, '..'), home = join(root, 'store'), script = join(root, 'scheduler.mts');
    writeFileSync(script, `
      import { writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { loadWorkflow } from ${JSON.stringify(join(repo, 'src/scheduler.ts'))};
      import { runPreparedWorkflow as runWorkflow } from ${JSON.stringify(join(repo, 'spec/test-support/ready-setup.ts'))};
      import { setFcGlobalDir } from ${JSON.stringify(join(repo, 'src/store.ts'))};
      import { makeInstrument } from ${JSON.stringify(join(repo, 'spec/test-support/research-instrument-fixture.ts'))};
      const project = process.argv[2]; setFcGlobalDir(process.argv[3]);
      const research = makeInstrument(project, { publication: 'reports/result.md', budget: { max_rounds: 2, invocation_seconds: 10 } });
      const brief = '---\\n' + JSON.stringify({ research }) + '\\n---\\nPropose candidates.\\n';
      const { config, raw } = loadWorkflow(${JSON.stringify(join(repo, 'config/workflows/entry.yaml'))});
      const adapter = { async run(_prompt, _role, opts) {
        writeFileSync(join(project, 'candidate.json'), JSON.stringify({ value: Number(process.argv[4]) }));
        process.send({ runId: JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId, directory: opts.runDir });
        if (process.argv[5] === 'live') await new Promise(() => {});
        return { exitCode: 0, duration_ms: 1, output: ${JSON.stringify(delivered)} };
      } };
      await runWorkflow(config, raw, project, adapter, new Map(), undefined, ${JSON.stringify(agents)}, undefined, brief);
    `);
    const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown>; ready: Promise<{ runId: string; directory: string }>; stderr: string }> = [];
    const start = (value: number, mode: string) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, project, home, String(value), mode], {
        cwd: repo, env: { ...process.env, HOME: root, FC_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const closed = once(child, 'close');
      const entry = { child, closed, ready: researchReady(child, closed), stderr: '' }; children.push(entry);
      child.stdout!.resume(); child.stderr!.on('data', b => { entry.stderr += b.toString(); });
      return entry;
    };
    try {
      const older = start(1, 'live'), old = await older.ready;
      const units = { isActive: async () => ({ kind: 'absent' as const }), stopUnit: async () => {}, runUnit: async () => {}, journalTail: async () => '' };
      const coordinator = new RunCancellationCoordinator({ registry: new TaskRegistry({ baseDir: home }), units, runsDir: join(home, 'runs'),
        signalGraceMs: 0, timeoutMs: 0,
        isSchedulerPidAlive: pid => pid === older.child.pid && older.child.exitCode === null && older.child.signalCode === null,
        canSignalScheduler: () => false, signalScheduler: () => { throw new Error('Unbound cancellation cannot signal a scheduler'); },
      });
      expect((await coordinator.cancelRun(old.runId)).observation.schedulerAlive).toBe(true);
      expect(existsSync(runRecordPath(old.directory, 'research_manifest.json'))).toBe(false);
      older.child.kill('SIGTERM'); await older.closed;
      const newer = start(25, successor), current = await newer.ready;
      expect(current.runId).not.toBe(old.runId);
      if (successor === 'complete') {
        await newer.closed; expect(newer.child.exitCode, newer.stderr).toBe(0);
        expect(readRunState(project, current.runId).status).toBe('complete');
        expect(read(join(researchInstrumentState(current.directory).incumbent.path, 'candidate.json')).value).toBe(25);
      } else expect(readRunState(project, current.runId).status).toBe('running');
      const before = readFileSync(join(project, 'candidate.json'));
      expect(JSON.parse(before.toString()).value).toBe(25);
      await coordinator.cancelRun(old.runId);
      expect(readFileSync(join(project, 'candidate.json')), 'Stale cancellation must preserve the successor candidate').toEqual(before);
      const manifestPath = runRecordPath(old.directory, 'research_manifest.json'), manifest = read(manifestPath);
      expect(manifest).toMatchObject({ engine_stop_reason: 'cancelled', conclusion: { status: 'cancelled' }, incumbent: { label: 'baseline' },
        restoration_skipped: 'project_ownership_changed_or_unknown', finalizer: { outcome: 'execution_error', reason: expect.stringContaining('research_cancelled') } });
      expect(read(manifest.finalizer.raw.path).started).toBe(false);
      expect(readRunState(project, old.runId).status).toBe('cancelled');
      const settled = readFileSync(manifestPath);
      reconcileHostInterruptedRun(project, old.runId); await coordinator.cancelRun(old.runId);
      expect(readFileSync(manifestPath)).toEqual(settled); expect(readFileSync(join(project, 'candidate.json'))).toEqual(before);
      expect(newer.child.signalCode).toBeNull();
      expect(existsSync(runRecordPath(old.directory, 'research_publication.json'))).toBe(false);
    } finally {
      for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
      await Promise.all(children.map(entry => entry.closed));
    }
  }, 30000);
  it('excludes admission throughout a restoration regardless of elapsed time', async () => {
    const home = fcGlobalDir(), current = createRun(project, 'fixture', '', []), next = createRun(project, 'fixture', '', []);
    const unknownWrite = vi.fn(); expect(withProjectWriteOwnership(project, current.runDirPath, unknownWrite)).toBe(false);
    expect(unknownWrite).not.toHaveBeenCalled();
    expect(claimLaunchIntent(project, current.runId).claimed).toBe(true); releaseLaunchIntent(project, current.runId);
    const queued = join(root, 'admission-queued');
    let child: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
    let output = '', errors = '';
    try {
      expect(withProjectWriteOwnership(project, current.runDirPath, () => {
        child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
        import fs from 'node:fs';
        import { claimLaunchIntent } from ${JSON.stringify(join(import.meta.dirname, '../src/run-lock.ts'))};
        import { setFcGlobalDir } from ${JSON.stringify(join(import.meta.dirname, '../src/store.ts'))};
        setFcGlobalDir(${JSON.stringify(home)});
        const wait = Atomics.wait;
        Atomics.wait = (...args) => { fs.writeFileSync(${JSON.stringify(queued)}, 'queued'); return wait(...args); };
        console.log(JSON.stringify(claimLaunchIntent(${JSON.stringify(project)}, ${JSON.stringify(next.runId)}, Date.now() + 120_000)));
      `], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: home } });
        closed = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
        child.stdout!.on('data', data => { output += data; });
        child.stderr!.on('data', data => { errors += data; });
        // Wait only for queue entry. Waiting for child completion here would
        // prevent this synchronous restoration from ever releasing its lock.
        while (!existsSync(queued)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        expect(readRunLockWaits(project, current.runDirPath)).toEqual([expect.objectContaining({
          holder: expect.objectContaining({ pid: process.pid }), waiter: expect.objectContaining({ pid: child.pid }),
        })]);
        expect(output).toBe('');
      })).toBe(true);
      await closed;
      expect(child!.exitCode, errors).toBe(0);
      expect(JSON.parse(output)).toEqual({ claimed: true });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    releaseLaunchIntent(project, next.runId);
    const staleWrite = vi.fn(); expect(withProjectWriteOwnership(project, current.runDirPath, staleWrite)).toBe(false);
    expect(staleWrite).not.toHaveBeenCalled();
  });
});

it('declares only the protocol mechanism and makes review explicitly optional', () => {
  const text = brief(), parsed = parseBriefFrontmatter(text); expect(parsed.workflowError).toBeUndefined(); expect(entryWorkflow(parsed).workflow).toBe('research');
  const stages = researchStages(parsed.research!); expect(stages).toHaveLength(1);
  expect(admitResearchStages(parsed.research!, stages, project, join(root, 'admission')).pass).toBe(true);
  const findings = inspectBrief(text).findings;
  expect(findings.some(f => f.code === 'brief_criteria_missing')).toBe(false);
  expect(findings.some(f => f.code === 'research_measurement_valid' && f.level === 'ok')).toBe(true);
});
it('cannot release protocol-frozen instrument roots through ordinary output declarations', () => {
  const text = brief().replace('---\n', '---\noutputs:\n  - {path: instrument/config.json}\n');
  const bindings = resolveImmutableEvidenceBindings(project, text);
  expect(firstImmutableEvidenceConflict(['instrument/config.json'], bindings, project)).toMatchObject({ inputPath: 'instrument' });
});
it.each(['baseline: 100', 'measurement: {replicates: 2}', 'protocol: research-instrument/v2'])('refuses legacy or unknown research declaration %s', field => {
  expect(parseBriefFrontmatter(`---\nresearch:\n  ${field}\n---\nTask`).frontmatterError).toContain('research');
});
it('retains literal candidate work-division notes through protocol construction and admission', () => {
  for (const path of ['src', 'a b/file.json', 'src/[a].json', 'src/a?file.json', 'src/a*file', 'src/{one,two}', 'src/@(one|two)', 'src/[!]', 'src/[*]', 'src/one]two']) {
    const config = parseBriefFrontmatter(brief(rc => { rc.candidate = [path]; }));
    expect(config.workflowError).toBeUndefined();
    const stages = researchStages(config.research!);
    expect(stages[0].scope).toEqual([literalProjectScope(path)]);
    expect(admitResearchStages(config.research!, stages, project, root).pass).toBe(true);
  }
});
it('refuses nonportable roots, overlapping authority, duplicate declarations and nonfinite caps', () => {
  const drive = 'C:';
  for (const path of [drive + '/candidate.json', drive + '\\candidate.json', drive, drive + 'candidate.json', 'src/../candidate', 'src//candidate', 'src/./candidate', 'src/.git/config', ' src/file']) {
    const parsed = parseBriefFrontmatter(brief(rc => { rc.candidate = [path]; }));
    expect(parsed.research, path).toBeUndefined(); expect(parsed.frontmatterError, path).toContain('research.candidate.0');
  }
  for (const edit of [(rc: ResearchConfig) => { rc.candidate = ['instrument/config.json']; },
    (rc: ResearchConfig) => { rc.publication = 'instrument/result.md'; },
    (rc: ResearchConfig) => { rc.budget.wall_seconds = Infinity; },
    (rc: ResearchConfig) => { rc.budget.invocation_seconds = Number.MAX_VALUE; },
    (rc: ResearchConfig) => { rc.environment.NODE_OPTIONS = '--invalid'; }]) {
    expect(parseBriefFrontmatter(brief(edit)).research).toBeUndefined();
  }
  const text = brief().replace('---\n', '---\nobjective: {}\n');
  expect(parseBriefFrontmatter(text).research).toBeUndefined();
  expect(parseBriefFrontmatter(text).frontmatterError).toContain('objective');
});
