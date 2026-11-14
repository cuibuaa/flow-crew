import { evidenceContext } from '../src/evidence-ledger.js';
import { runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { loadWorkflow, } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
import { appendEvidence, captureProjectTree, readEvidence, stagePredecessor } from '../src/evidence-ledger.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { decisionInput } from '../src/decision-context.js';
import { decisionSchema } from '../src/decision-graph.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { runStage } from '../src/worker.js';
import { fcGlobalDir, setFcGlobalDir, readRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { executeOrdinaryStage } from '../src/scheduler/sched_loop/ordinary-stage.js';

let root: string, project: string, prior: string;
const engine = join(import.meta.dirname, '..');
const uuid = '11111111-1111-4111-8111-111111111111';
const delivered = (summary: string, remaining_work: string[] = []) => JSON.stringify({ status: 'delivered', summary, caveats: [], remaining_work });
const task = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"UNIQUE_CRITERION_TEXT: deliver the required greeting.\"}]\n---\n# Unique admitted request\n\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-handoff-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base']]) {
    isolatedProjectCommand('git', args, project, root);
  }
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

describe('ledger handoff at the rendered adapter boundary', () => {
  it.each(['qa', 'planner'])('gives %s gates and repairs criterion IDs and paths without reprinting the request', async roleName => {
    const refs = extractBriefCriteria(task).criteria.map(criterion => criterion.id);
    for (const kind of ['gate', 'repair']) {
      const created = createRun(project, 'fixture', 'name: fixture', [kind], task);
      writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), task);
      const criteriaPath = runRecordPath(created.runDirPath, 'brief_criteria.json');
      writeFileSync(criteriaPath, JSON.stringify(extractBriefCriteria(task)));
      const calls: Array<{ system: string; user: string }> = [];
      const adapter: Adapter = { async run(user, role) {
        calls.push({ user, system: role.prompt });
        return { output: '', exitCode: 1, duration_ms: 1 };
      } };
      await runStage(adapter, { stageId: kind, role: { name: roleName, description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Inspect the assigned criteria.' },
        dependsOn: [], promptTemplate: 'Inspect current files.', timeout_ms: 60_000,
        projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0,
        taskDescription: task, criterionRefs: refs, isGate: kind === 'gate', artifactContract: fixtureArtifactContract(kind) });
      expect(calls).toHaveLength(1);
      expect((calls[0].system + calls[0].user).split('UNIQUE_CRITERION_TEXT')).toHaveLength(2);
      for (const id of refs) expect(calls[0].user).toContain(id);
      expect(calls[0].user).toContain(criteriaPath);
      expect(JSON.parse(readFileSync(criteriaPath, 'utf8')).criteria.map((c: { id: string }) => c.id)).toEqual(refs);
    }
  });

  it.each(['correction', 'guidance'] as const)('refreshes facts and the full immutable diff for a cold %s child, keeping the attempt predecessor', async mode => {
    writeFileSync(join(project, 'value.txt'), 'BASE_VALUE\n');
    isolatedProjectCommand('git', ['add', 'value.txt'], project, root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base value'], project, root);
    const base = isolatedProjectCommand('git', ['rev-parse', 'HEAD'], project, root).trim();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), task);
    writeFileSync(runRecordPath(created.runDirPath, 'validation_baseline.json'), JSON.stringify({ baseCommit: base }));
    const options = { stageId: 'work', role: { name: 'coder', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Current duties.' },
      dependsOn: [], promptTemplate: 'Inspect value.txt and preserve all duties.', timeout_ms: 20_000,
      projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0,
      outputSchema: HANDOFF_SCHEMA, artifactContract: fixtureArtifactContract('work') };
    await runStage({ async run() { return { output: delivered('EXACT_OWN_PREDECESSOR'), exitCode: 1, duration_ms: 1 }; } }, options);
    const predecessor = readEvidence(created.runDirPath).find(entry => entry.kind === 'attempt');
    writeFileSync(join(project, 'value.txt'), 'INITIAL_VALUE\n');
    let elapsed = 0;
    const epoch = Date.now();
    const timers = new Map<object, { at: number; fn: () => void }>();
    const clock = { monotonicNow: () => elapsed, wallNow: () => epoch + elapsed,
      setTimer(fn: () => void, delay: number) { const timer = {}; timers.set(timer, { at: elapsed + delay, fn }); return timer; },
      clearTimer(timer: object) { timers.delete(timer); } };
    const calls: Array<{ user: string; opts: RunOpts }> = [];
    const adapter: Adapter = { async run(user, _role, opts) {
      calls.push({ user, opts });
      if (calls.length === 1) {
        writeFileSync(join(project, 'value.txt'), 'CURRENT_VALUE\n');
        writeFileSync(join(project, 'new.txt'), 'CURRENT_UNTRACKED_VALUE\n');
        appendEvidence(created.runDirPath, { kind: 'decision', stageId: 'other_gate', attemptIndex: 1,
          owner: 'closed-schema-model', verdict: { pass: false, reason: 'CURRENT_STRUCTURED_FACT' } });
        if (mode === 'correction') return { output: '{}', exitCode: 0, duration_ms: 1, sessionId: uuid };
        opts.onCommandLifecycle?.({ phase: 'started', id: 'work', timestamp: new Date().toISOString() });
        if (mode === 'guidance') {
          appendGuidanceEnvelope({ runDir: created.runDirPath, target: 'work', source: 'operator', body: 'Inspect new bytes independently.', knownStageIds: ['work'] });
          opts.onCommandLifecycle?.({ phase: 'completed', id: 'work', timestamp: new Date().toISOString() });
        }
        return { output: '', exitCode: 137, duration_ms: 1, sessionId: uuid };
      }
      return { output: delivered('Completed current duties.'), exitCode: 0, duration_ms: 1, sessionId: uuid };
    } };
    const result = await runStage(adapter, { ...options, retries: 1, deadlineClock: clock });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    const patchPath = (user: string) => user.match(/explicitly marked\): (.*)\n/)![1];
    expect(calls[0].user).toContain('+INITIAL_VALUE');
    expect(calls[1].user).toContain('+CURRENT_VALUE');
    expect(calls[1].user).toContain('+CURRENT_UNTRACKED_VALUE');
    expect(calls[1].user).not.toContain('+INITIAL_VALUE');
    expect(calls[1].user).toContain('CURRENT_STRUCTURED_FACT');
    expect(patchPath(calls[1].user)).not.toBe(patchPath(calls[0].user));
    expect(readFileSync(patchPath(calls[0].user), 'utf8')).toContain('+INITIAL_VALUE');
    expect(readFileSync(patchPath(calls[1].user), 'utf8')).toContain('+CURRENT_VALUE');
    expect(readFileSync(patchPath(calls[1].user), 'utf8')).toContain('+CURRENT_UNTRACKED_VALUE');
    for (const call of calls) {
      expect(call.opts.resumeSessionId).toBeUndefined();
      expect(call.user).toContain('Inspect value.txt and preserve all duties.');
      const supplied = JSON.parse(call.user.split('# Own-stage continuation evidence\n')[1].split('\nDiff:\n')[0]);
      expect(supplied.attempt).toEqual(predecessor);
    }
    expect(calls[1].user).toContain('# Previous invocation record');
    if (mode === 'guidance') expect(calls[1].user).toContain('Inspect new bytes independently.');
    if (mode === 'wrapup') expect(calls[1].user).toContain('# Stage budget wrap-up');
    expect(timers.size).toBe(0);
  });

  it.each(['gate', 'repair'] as const)('keeps a root %s free of the campaign pivot narrative', async kind => {
    const created = createRun(project, 'fixture', 'name: fixture', ['gate', 'repair']);
    writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), task);
    const gate = StageConfigSchema.parse({ id: 'gate', role: 'qa', scope: [], is_gate: true,
      artifact_contract: fixtureArtifactContract('gate') });
    const repair = StageConfigSchema.parse({ id: 'repair', role: 'coder', scope: [], retry_to: ['gate'],
      artifact_contract: fixtureArtifactContract('repair') });
    const state = readRunState(project, created.runId);
    Object.assign(state, { researchInjection: { source: 'campaign_health', triggeredAt: new Date().toISOString(),
      iteration: 1, alertType: 'plateau', message: 'EARLIER_APPROACH_NARRATIVE_SENTINEL' } });
    const inputs: string[] = [];
    const adapter: Adapter = { async run(user) {
      inputs.push(user);
      return { output: delivered('Captured current duties.'), exitCode: 1, duration_ms: 1 };
    } };
    await executeOrdinaryStage(kind === 'gate' ? gate : repair, [gate, repair], state, project,
      created.runId, created.runDirPath, adapter, new Map(), join(engine, 'config/agents'), new Map(), new Map(), undefined, task);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toContain('EARLIER_APPROACH_NARRATIVE_SENTINEL');
    expect(inputs[0]).not.toContain('PIVOT REQUIRED');
    expect(inputs[0]).toContain('evidence-ledger.jsonl');
    expect(inputs[0]).toContain('change.diff');
  });

  it('gives first and later gates and repair one contract, structured facts, diff and readable paths', async () => {
    const { config, raw } = loadWorkflow(join(engine, 'config/workflows/entry.yaml'));
    for (const stage of (config.dispatch ?? []) as Array<{ id: string; prompt_template?: string }>) {
      if (stage.id === 'review' || stage.id === 'repair') stage.prompt_template = '{task_description}';
    }
    const calls: Array<{ id: string; system: string; user: string; opts: RunOpts }> = [];
    let reviews = 0;
    const adapter: Adapter = { async run(user, role, opts) {
      calls.push({ id: opts.stageId, system: role.prompt, user, opts });
      let output = delivered('AUTHOR_NARRATIVE_SENTINEL');
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'implement', reason: 'One change.', assumptions: [] });
      if (opts.stageId === 'implement') writeFileSync(join(project, 'greeting.txt'), 'wrong\n');
      if (opts.stageId === 'assess') output = JSON.stringify({ successor: 'review', reason: 'Inspect the greeting.', risk_areas: [{ file: 'greeting.txt', risk: 'Greeting correctness.', experiment: 'Read the greeting independently.' }] });
      if (opts.stageId === 'repair') { writeFileSync(join(project, 'greeting.txt'), 'required greeting\n'); output = JSON.stringify({ successor: 'assess', reason: 'REPAIR_NARRATIVE_SENTINEL' }); }
      if (opts.stageId === 'review') {
        const pass = ++reviews > 1;
        const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
        output = JSON.stringify({ pass, reason: pass ? 'Independently correct.' : 'Wrong greeting.',
          criteria: Object.fromEntries(criteria.map(c => [c.id, { status: pass ? 'pass' : 'fail', evidence: 'greeting.txt' }])),
          audit_findings: { version: 1, findings: pass ? [] : [{ id: 'greeting', paths: ['greeting.txt'], reason: 'Wrong greeting.', criterion_ids: criteria.map(c => c.id), invalidates_plan: false, repair_role: 'coder' }] },
          ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Replace the wrong greeting.' } } : {}), remaining_work: [],
        });
      }
      return { output, exitCode: 0, duration_ms: 1, sessionId: uuid };
    } };
    const final = await runWorkflow(config, raw, project, withConfirmedRejections(adapter), new Map(), undefined, join(engine, 'config/agents'), undefined, task, true);
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls.map(c => c.id)).toEqual(['choose', 'implement', 'assess', 'review', 'repair', 'assess', 'review']);
    const author = calls.find(c => c.id === 'implement')!.opts;
    const peerContext = evidenceContext(project, author.runDir);
    expect(peerContext).not.toContain('AUTHOR_NARRATIVE_SENTINEL');
    expect(peerContext).toContain('change.diff');
    for (const call of calls.filter(c => c.id === 'review' || c.id === 'repair')) {
      expect(call.system.split(task.trim())).toHaveLength(2);
      expect(call.user).not.toContain(task.trim());
      expect(call.user).not.toContain('UNIQUE_CRITERION_TEXT');
      expect(call.user).not.toContain('AUTHOR_NARRATIVE_SENTINEL');
      expect(call.user).not.toContain('REPAIR_NARRATIVE_SENTINEL');
      expect(call.user).not.toContain('output_attempt_');
      expect(call.user).not.toContain('input.md');
      expect(call.user).not.toContain('FIRST EVALUATION (round');
      expect(call.user).not.toContain('RE-EVALUATION (round');
      expect(call.user).not.toContain('Previous fix attempt did not resolve all issues');
      expect(call.user).toContain('evidence-ledger.jsonl');
      expect(call.user).toContain('change.diff');
      expect(call.opts.resumeSessionId).toBeUndefined();
      if (call.id === 'review') expect(call.user).toContain('brief_criteria.json');
      if (call.id === 'repair') expect(call.user).toContain('rejected_verdict_review.json');
    }
    const last = calls.at(-1)!;
    expect(last.user).toContain('Wrong greeting.');
    expect(last.user).toContain('required greeting');
    expect(captureProjectTree(project, task).hash).toBeTruthy();
  });

  it('keeps isolated decision retries cold while retaining their exact own final record', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['choose']);
    writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), task);
    const stage = StageConfigSchema.parse({ id: 'choose', role: 'planner', scope: [],
      decision: { kind: 'shape', successors: ['implement', 'plan'], default: 'plan' } });
    const answer = { successor: 'implement', reason: 'Own previous choice.', assumptions: [] };
    const inputs: Array<{ user: string; opts: RunOpts }> = [];
    const adapter: Adapter = { async run(user, _role, opts) {
      inputs.push({ user, opts });
      return { output: JSON.stringify(answer), exitCode: inputs.length === 1 ? 1 : 0, duration_ms: 1, sessionId: uuid };
    } };
    for (let retries = 0; retries < 2; retries++) {
      await runStage(adapter, { stageId: 'choose', role: { name: 'planner', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: '' },
        dependsOn: [], promptTemplate: '', timeout_ms: 60_000, projectDir: project, runId: created.runId, runDir: created.runDirPath, retries,
        artifactContract: fixtureArtifactContract('choose'), outputSchema: decisionSchema(stage), decisionResult: true,
        isolatedInput: decisionInput(stage, project, created.runDirPath, readRunState(project, created.runId)) });
    }
    expect(inputs.map(input => input.opts.resumeSessionId)).toEqual([undefined, undefined]);
    const supplied = JSON.parse(inputs[1].user.split('\n\n# Stage result')[0]);
    expect(supplied.predecessor.attempt.finalRecord).toEqual(answer);
    expect(supplied.predecessor.attempt.guidanceIds).toEqual([]);
    expect(supplied.predecessor).not.toHaveProperty('validation');
  });

  it.each(['continuation', 'retry'] as const)('cold-starts a %s from its own final record, validation identity and delivered guidance ids', async kind => {
    writeFileSync(join(project, 'Makefile'), 'build:\n\t@true\ntest:\n\t@true\nlint:\n\t@true\n');
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), task);
    const guidance = appendGuidanceEnvelope({ runDir: created.runDirPath, target: 'work', source: 'operator', body: 'Preserve the required greeting.', knownStageIds: ['work'] });
    const calls: Array<{ user: string; opts: RunOpts }> = [];
    let elapsedOffset = 0;
    const clock = { monotonicNow: () => Date.now() + elapsedOffset, wallNow: () => Date.now() + elapsedOffset,
      setTimer: (fn: () => void, delay: number) => setTimeout(fn, delay), clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) };
    const first = delivered('OWN_PREDECESSOR_RECORD', kind === 'continuation' ? ['Deliver the greeting.'] : []);
    const adapter: Adapter = { async run(user, _role, opts) {
      calls.push({ user, opts });
      if (kind === 'continuation' && opts.attemptIndex === 1) elapsedOffset = 70_000;
      return { output: opts.attemptIndex === 1 ? first : delivered('Complete.'), exitCode: kind === 'retry' && opts.attemptIndex === 1 ? 1 : 0, duration_ms: 1, sessionId: uuid };
    } };
    const opts = { stageId: 'work', role: { name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Unique role contract.' }, dependsOn: [], promptTemplate: 'Deliver the greeting.',
      timeout_ms: 60_000, deadlineClock: clock, projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0,
      artifactContract: fixtureArtifactContract('work'), outputSchema: HANDOFF_SCHEMA };
    const firstResult = await runStage(adapter, opts);
    if (kind === 'continuation') expect(firstResult.continuation?.reason).toBe('stage_budget');
    else expect(firstResult.exitCode).toBe(1);
    const predecessor = readEvidence(created.runDirPath).find(e => e.kind === 'attempt');
    expect(predecessor?.kind).toBe('attempt');
    if (predecessor?.kind !== 'attempt') throw new Error('missing predecessor');
    expect(predecessor.finalRecord?.summary).toBe('OWN_PREDECESSOR_RECORD');
    expect(predecessor.guidanceIds).toContain(guidance.id);
    const validation = readEvidence(created.runDirPath).find(entry => entry.kind === 'validation');
    // Neither a failed model attempt nor an unfinished budget slice is a
    // settled author tree for the gate; both retain unknown validation.
    expect(validation).toBeUndefined();
    expect(stagePredecessor(readEvidence(created.runDirPath), 'work', { index: predecessor.attemptIndex + 1, startedAt: predecessor.attemptStartedAt })).toBeUndefined();
    expect(stagePredecessor(readEvidence(created.runDirPath), 'work', { index: predecessor.attemptIndex, startedAt: 'unknown-start' })).toBeUndefined();
    await runStage(adapter, { ...opts, retries: 1, resumeSessionId: uuid, sessionOwnerStageId: 'work' });
    const continued = calls.filter(call => call.opts.attemptIndex === 2);
    expect(continued).toHaveLength(1);
    expect(continued[0].opts.resumeSessionId).toBeUndefined();
    expect(continued[0].user).toContain('# Own-stage continuation evidence');
    expect(continued[0].user).toContain(JSON.stringify(predecessor));
    const supplied = JSON.parse(continued[0].user.split('# Own-stage continuation evidence\n')[1].split('\nDiff:\n')[0]);
    expect(supplied.attempt).toEqual(predecessor);
    if (validation) expect(supplied.validation).toEqual(validation);
    else expect(supplied).not.toHaveProperty('validation');
    expect(continued[0].user).toContain(guidance.id);
    expect(continued[0].user).not.toContain('live_execution_');
  });
});
