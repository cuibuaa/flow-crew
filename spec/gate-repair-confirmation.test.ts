import { entryPlan, plannerReply } from './test-support/planner-entry.js';
import './test-support/policy-runtime.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { runRecordPath } from '../src/run-layout.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { declareValidation } from './test-support/structured-validation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { loadWorkflow } from '../src/scheduler.js';
import { runDir, writeStageStatus, readRunState, writeRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { validateSettledTree } from '../src/scheduler/sched_settlement/gate-validation.js';
import { confirmedRepairFindings } from '../src/scheduler/sched_settlement/gate-archives.js';
import { appendEvidence, captureProjectTree, readEvidence, type EvidenceEntry } from '../src/evidence-ledger.js';
import { FINDING_POLICY_TEXT, assessFindings, type AuditFinding } from '../src/scoped-audit-repair.js';
import { stageFixtureCommand } from './test-support/stage-command.js';
import * as validation from '../src/project-validation.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { normalizeNativeEvent } from '../src/adapters/native-events.js';
import { buildStagePrompt, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { renderRunSummary } from '../src/run-summary.js';
import { startCommandRecorder } from '../src/recorded-command.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const finding = (id: string, reproduction?: number | null): AuditFinding => ({ id, paths: ['docs/value.txt'],
  reason: 'Value must be repaired', class: 'regression' as const, criterion_ids: [], invalidates_plan: false, repair_role: 'coder',
  ...(reproduction === undefined ? {} : { reproduction }) });

async function workflow(mode: 'mixed' | 'unconfirmed' | 'observation', failedRepair = false, observeAfterRepair = false, needsValidationPreparation: boolean | 'failure' = false, variant?: 'long' | 'cwd' | 'bash' | 'unknown' | 'recorded' | 'stale' | 'reject-again', route?: [string, string, string?]) {
  const root = mkdtempSync(join(tmpdir(), 'confirmed-gate-')); roots.push(root);
  const project = join(root, 'project'); mkdirSync(project);
  // The reviewer receives a complete readable patch.
  isolatedProjectCommand('git', ['init', '-q', '--separate-git-dir', join(root, 'git')], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], project, project);
  const calls: Array<{ stage: string; prompt: string }> = [];
  let review = 0, repairs = 0;
  const dependency = mkdtempSync(join(tmpdir(), 'closure-dependency-')); roots.push(dependency);
  const marker = join(dependency, 'ready');
  if (needsValidationPreparation) {
    declareValidation(project, { test: { command: 'npm', args: ['run', 'test'] } });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.7', scripts: { test: needsValidationPreparation === 'failure' ? 'fixture-check-failure' : 'fixture-check' } }));
    vi.spyOn(validation, 'runValidationCommand').mockImplementation(request => {
      if (readFileSync(join(project, 'docs/value.txt'), 'utf8') === 'repaired') writeFileSync(marker, 'ready');
      return { exitCode: needsValidationPreparation === 'failure' && readFileSync(join(project, 'docs/value.txt'), 'utf8') === 'repaired' ? 7 : 0, stdout: 'Configured fixture result' };
    });
  }
  const condition = `require('node:fs').readFileSync('${variant === 'cwd' ? 'value.txt' : 'docs/value.txt'}','utf8')==='repaired'`
    + (needsValidationPreparation ? ` && require('node:fs').existsSync(${JSON.stringify(marker)})` : '');
  const command = variant === 'stale' ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const source=require('node:fs').readFileSync('docs/value.txt','utf8');if(source!=='bad')throw Error('Probe expects original source identity');process.exit(${condition}?0:1)`)}` : variant === 'recorded' ? '[[ "$(cat value.txt)" == repaired ]]' : variant === 'bash' ? '[[ "$(cat docs/value.txt)" == repaired ]]'
    : (variant === 'long' ? 'true' + ' '.repeat(510) + '; ' : '') + `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${condition}?0:1)`)}`;
  const context = { cwd: variant === 'cwd' || variant === 'recorded' ? join(project, 'docs') : project,
    shell: variant === 'bash' || variant === 'recorded' ? '/bin/bash' : '/bin/sh' };
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push({ stage: opts.stageId, prompt });
    const result = (value: unknown, writes: string[] = []) => ({ output: JSON.stringify(value), exitCode: 0, duration_ms: 1,
      writes, writeAttribution: 'structured' as const });
    if (opts.stageId === 'plan') return plannerReply(opts, proposal);
    if (opts.stageId === 'later_author') {
      writeFileSync(join(project, 'docs/other.txt'), 'Independent downstream output');
      return result({ successor: 'review', reason: 'Review independent later output' }, ['docs/other.txt']);
    }
    if (opts.stageId === 'review') {
      const first = ++review === 1 || variant === 'reject-again' && review === 2 || mode === 'unconfirmed' || variant === 'unknown';
      let sequence: number | undefined;
      if ((first || route?.length === 3 && review === 3) && mode === 'mixed') {
        const tracker = new CommandActivityTracker({ runDir: opts.runDir, stageId: opts.stageId, attemptIndex: 1,
          attemptStartedAt: new Date().toISOString(), onLifecycle: opts.onCommandLifecycle });
        const client = variant !== 'unknown' ? prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0] : undefined;
        const transportedCommand = client ? `${client} '${JSON.stringify({ command, ...context }).replaceAll("'", "'\\''")}'` : command;
        tracker.feed(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'reviewer-probe', command: transportedCommand,
          ...(variant === 'unknown' || client ? {} : context) } }) + '\n');
        const response = await stageFixtureCommand({ command: context.shell, args: ['-c', transportedCommand], role: 'test', display: transportedCommand,
          cwd: context.cwd, runDir: opts.runDir });
        expect(response.exitCode).toBe(client || !first ? 0 : 1);
        if (client) {
          const record = JSON.parse(response.stdout!).record;
          expect(record.exitCode).toBe(first ? 1 : 0);
          sequence = record.sequence;
        }
        tracker.feed(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'reviewer-probe', command,
          exit_code: response.exitCode, aggregated_output: JSON.stringify([response.stdout ?? '', response.stderr ?? '']) } }) + '\n');
        tracker.close();
        sequence ??= readEvidence(opts.runDir).at(-1)!.sequence;
      }
      const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
      const corrected = mode === 'unconfirmed' && prompt.includes('# Stage result correction');
      const observation = !first && observeAfterRepair;
      return result({ pass: mode === 'observation' || corrected || !first, reason: first ? 'Review observations' : 'Independent recheck passed',
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: !first || mode === 'observation' || corrected ? 'pass' : 'fail', evidence: 'Read docs/value.txt' }])),
        audit_findings: { version: 1, findings: first ? [...(mode === 'mixed' ? [finding('confirmed', sequence)] : []), { ...finding('unconfirmed'), ...(mode !== 'unconfirmed' || corrected ? { class: 'advisory' as const } : {}) }] : observation ? [{ ...finding('observation_after_repair'), class: 'advisory' as const }] : [] },
        ...(mode === 'observation' || corrected || !first ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: 'reviewed value' } }) });
    }
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs/value.txt'), opts.stageId === (route ? 'repair' : 'repair_review') && !failedRepair && (variant !== 'reject-again' || ++repairs > 1) ? 'repaired' : 'bad');
    if (route && opts.stageId === 'repair') return result({ successor: 'review', reason: 'Reassess the repaired value' }, ['docs/value.txt']);
    return result({ status: 'delivered', summary: 'Value delivered', caveats: [], remaining_work: [] }, ['docs/value.txt']);
  } };
  const { config, raw } = loadWorkflow(resolve(`config/workflows/${route ? 'entry' : 'direct'}.yaml`));
  if (variant === 'unknown') config.defaults.max_retries = 0;
  const proposal: unknown[] = structuredClone(entryPlan);
  if (route?.length === 3) proposal.push({ id: 'later_author', role: 'coder', depends_on: [route[1]],
    scope: ['docs/other.txt'], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false,
    artifact_contract: { version: 1, produces: [], reads: [] },
    decision: { successors: ['review'], default: 'review', kind: 'successor' } });
  const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"The value is independently checked.\"}]\noutputs: [docs/value.txt]\n---\n# Deliver a value\n\n## Acceptance criteria\n1. The value is independently checked.\n";
  const final = await runWorkflow(config, route?.length === 3 || variant === 'unknown' ? JSON.stringify(config) : raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
  const directory = runDir(project, final.runId), ledger = readEvidence(directory);
  return { final, directory, ledger, calls, project };
}

describe('repair requires a reviewer reproduction', () => {
  it('rejects malformed recorder requests and retires an active command and endpoint with its invocation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recorder-lifetime-')); roots.push(directory);
    let executions = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const recorder = await startCommandRecorder(directory, async (_request, signal) => {
      executions++; entered();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: null };
    });
    const call = (request: unknown) => stageFixtureCommand({ role: 'test', command: '/bin/sh',
      args: ['-c', `${recorder.command} '${JSON.stringify(request).replaceAll("'", "'\\''")}'`],
      display: 'recorder client', cwd: directory });
    try {
      const malformed = await call({ command: 'false', cwd: 'relative', shell: '/bin/sh' });
      expect(JSON.parse(malformed.stdout!)).toHaveProperty('error');
      expect(executions).toBe(0);
      const active = call({ command: 'false', cwd: directory, shell: '/bin/sh' });
      await started;
      await recorder.close();
      await active;
      expect(executions).toBe(1);
      expect((await call({ command: 'false', cwd: directory, shell: '/bin/sh' })).exitCode).toBe(1);
    } finally {
      // close is owned once, including assertion-failure cleanup.
      await recorder.close().catch(() => {});
    }
  });

  it('records and closes an engine-run reproduction when native events omit execution context', async () => {
    const value = await workflow('mixed', false, false, false, 'recorded');
    expect(value.final.status).toBe('complete');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review']);
    const original = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === 'review')!;
    expect(original).toMatchObject({ exitCode: 1, command: '[[ "$(cat value.txt)" == repaired ]]',
      context: { cwd: join(value.project, 'docs'), shell: '/bin/bash' }, outputDigest: expect.any(String),
      treeHash: expect.any(String), treeAfterHash: expect.any(String) });
    expect(value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence)).toMatchObject({
      exitCode: 0, command: (original as { command: string }).command, context: (original as { context: unknown }).context });
    const native = value.ledger.find(entry => entry.kind === 'command' && entry.commandId === 'reviewer-probe')!;
    expect(native).not.toHaveProperty('context');
    expect(native).not.toHaveProperty('treeHash');
    expect(native).not.toHaveProperty('treeAfterHash');
    expect(native).toMatchObject({ exitCode: 0 });
    expect(value.final.stages.review.gate?.findings?.confirmed).toEqual([]);
  });
  it.each(['long', 'cwd', 'bash'] as const)('replays the complete engine-recorded command in its context (%s)', async variant => {
    const value = await workflow('mixed', variant !== 'bash', false, false, variant);
    expect(value.final.status).toBe('complete');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review']);
    const original = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === 'review')!;
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence)!;
    expect(original).toMatchObject({ exitCode: 1, context: {
      cwd: variant === 'cwd' ? join(value.project, 'docs') : value.project,
      shell: variant === 'bash' ? '/bin/bash' : '/bin/sh',
    } });
    expect(closure).toMatchObject({ command: (original as { command: string }).command,
      context: (original as { context: unknown }).context, exitCode: variant === 'bash' ? 0 : 1 });
    if (variant === 'long') expect((original as { command: string }).command.length).toBeGreaterThan(500);
  });

  it('refuses a native command with unknown execution context through bounded correction', async () => {
    const value = await workflow('mixed', false, false, false, 'unknown');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review', 'review', 'review']);
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.attempts).toHaveLength(2);
    for (const attempt of value.final.stages.review.attempts!) expect(attempt.error).toContain('FINDING_REPRODUCTION_REQUIRED');
    expect(existsSync(runRecordPath(value.directory, 'verdict_review.json'))).toBe(false);
  });

  it('records a reviewer-run command and repairs only the confirmed finding, closing its reproduction on the repaired tree', async () => {
    const value = await workflow('mixed');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review']);
    expect(value.final.status).toBe('complete');
    const reproduction = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === 'review')!;
    expect(reproduction).toMatchObject({ kind: 'command', owner: 'code', stageId: 'review', exitCode: 1,
      treeHash: expect.stringMatching(/^[a-f0-9]{64}$/), outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (reproduction.kind !== 'command') throw Error('missing reproduction');
    expect(reproduction.treeAfterHash).toBe(reproduction.treeHash);
    const repairFacts = JSON.parse(value.calls.find(call => call.stage === 'repair_review')!.prompt.split('# Gate repair facts\n')[1].split('\n')[0]);
    const repair = JSON.stringify(repairFacts.confirmedFindings);
    expect(repair).toContain('"id":"confirmed"'); expect(repair).not.toContain('"id":"unconfirmed"');
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === reproduction.sequence)!;
    expect(closure).toMatchObject({ kind: 'command', owner: 'code', stageId: 'repair_review', exitCode: 0,
      treeHash: expect.any(String), treeAfterHash: expect.any(String), outputDigest: expect.any(String) });
    if (closure.kind !== 'command') throw Error('missing closure');
    expect(closure.treeHash).toBe(closure.treeAfterHash); expect(closure.treeHash).not.toBe(reproduction.treeHash);
    const archived = readFileSync(runRecordPath(value.directory, 'gate_reevaluation/iteration_1/round_1/engine_verdict_review.json'), 'utf8');
    expect(archived).toContain('"unconfirmed"');
    expect(renderRunSummary(value.project, value.directory, value.final).toLowerCase()).toContain('advisory unconfirmed');
  });

  it('replays closure after the configured validation prepares current repair dependencies, without another suite', async () => {
    const value = await workflow('mixed', false, false, true);
    expect(value.final.status).toBe('complete');
    expect(validation.runValidationCommand).toHaveBeenCalledTimes(2);
    const configured = value.ledger.filter(entry => entry.kind === 'validation');
    expect(configured.map(entry => entry.stageId)).toEqual(['implement', 'repair_review']);
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)!;
    expect(closure).toMatchObject({ exitCode: 0 });
    expect(closure.sequence).toBeGreaterThan(configured[1].sequence);
  });

  it('completes after a stale reviewer probe fails replay but re-review and declared validation pass', async () => {
    const value = await workflow('mixed', false, false, true, 'stale');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review']);
    const validations = value.ledger.filter(entry => entry.kind === 'validation');
    expect(validations).toHaveLength(2);
    expect(validations.every(entry => entry.pass && entry.executions.at(-1)?.commands.every(command => command.exitCode === 0))).toBe(true);
    const replay = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)!;
    expect(replay).toMatchObject({ exitCode: 1, commandId: 'closure-confirmed' });
    expect(readFileSync(join(value.project, 'docs/value.txt'), 'utf8')).toBe('repaired');
    expect(value.final.status).toBe('complete');
    expect(value.final.stages.review.gate?.pass).toBe(true);
    const facts = JSON.parse(value.calls.filter(call => call.stage === 'review')[1].prompt.split('Ledger facts:\n')[1].split('\n')[0]).facts;
    expect(facts.find((fact: { sequence: number }) => fact.sequence === replay.sequence)).toMatchObject({
      kind: 'command', commandId: 'closure-confirmed', reproductionOf: expect.any(Number), exitCode: 1,
      treeHash: expect.any(String), treeAfterHash: expect.any(String) });
  });

  it('accepts advisory findings after repair even when the replay fails', async () => {
    const value = await workflow('mixed', true, true);
    expect(value.final.status).toBe('complete');
    expect(value.final.stages.review.gate).toMatchObject({ pass: true });
    expect(value.final.stages.review.gate?.findings?.advisory?.[0].id).toBe('observation_after_repair');
  });

  it('dispatches another repair when the second review rejects with a grounded finding', async () => {
    const value = await workflow('mixed', false, false, false, 'reject-again');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review', 'repair_review', 'review']);
    expect(value.final.status).toBe('complete');
    expect(value.final.decisionGraph?.records.filter(record => record.stageId === 'review').map(record => record.gateAccepted)).toEqual([false, false, true]);
    expect(readFileSync(join(value.project, 'docs/value.txt'), 'utf8')).toBe('repaired');
  });

  it('rejects declared validation failure on the repaired tree even when re-review passes', async () => {
    const value = await workflow('mixed', false, false, 'failure');
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.gate).toMatchObject({ pass: false,
      findings: { confirmed: [expect.objectContaining({ record: expect.objectContaining({ validationRecord: expect.any(Number), exitCode: 7 }) })] } });
    expect(value.final.stages.review.gate?.reason).toContain('Engine validation rejected');
    expect(JSON.parse(readFileSync(runRecordPath(value.directory, 'verdict_review.json'), 'utf8')).pass).toBe(true);
  });

  it('keeps an accepted repair closed after independent downstream work and another review', async () => {
    const last = 'review';
    const value = await workflow('mixed', false, false, false, 'recorded', ['review', 'review', last]);
    expect(value.calls.map(call => call.stage)).toEqual(['plan', 'implement', 'review', 'repair', 'review', 'later_author', last]);
    const original = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.exitCode === 1)!;
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence)!;
    const finalProbe = value.ledger.filter(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === last).at(-1)!;
    expect(closure).toMatchObject({ exitCode: 0 });
    expect(finalProbe).toMatchObject({ exitCode: 0, treeHash: captureProjectTree(value.project, readFileSync(runRecordPath(value.directory, 'task_brief.md'), 'utf8')).hash });
    expect(finalProbe).not.toHaveProperty('reproductionOf');
    expect(finalProbe).not.toMatchObject({ treeHash: (closure as { treeHash: string }).treeHash });
    expect(readFileSync(join(value.project, 'docs/value.txt'), 'utf8')).toBe('repaired');
    expect(readFileSync(join(value.project, 'docs/other.txt'), 'utf8')).toBe('Independent downstream output');
    expect(value.final.stages[last].gate?.pass).toBe(true);
    expect(value.final.status).toBe('complete');
  });

  it.each(['stable-output', 'two-obligations', 'changing-output', 'nonzero', 'unfinished'] as const)(
    'replays each finding once per repair attempt and leaves the verdict to review (%s)', async mode => {
      const project = mkdtempSync(join(tmpdir(), 'closure-replay-')); roots.push(project);
      const brief = '---\ncriteria: [{id: C1, text: Value is repaired}]\n---\nRepair value';
      const run = createRun(project, 'closure', 'name: closure\nstages: []\n', ['repair', 'review'], brief);
      writeFileSync(join(project, 'value.txt'), 'repaired');
      const context = { cwd: project, shell: '/bin/sh' };
      const original = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'review', attemptIndex: 1,
        commandId: 'probe', command: 'fixture reproduction', context, exitCode: 1,
        outputDigest: 'original', treeHash: 'old-tree', treeAfterHash: 'old-tree' });
      const originals = [original];
      if (mode === 'two-obligations') originals.push(appendEvidence(run.runDirPath, { kind: 'command', owner: 'code',
        stageId: 'review', attemptIndex: 1, commandId: 'other', command: 'fixture other reproduction', context,
        exitCode: 1, outputDigest: 'original', treeHash: 'old-tree', treeAfterHash: 'old-tree' }));
      const state = readRunState(project, run.runId); state.status = 'running';
      state.gateRetryRound = { iteration: 1, round: 1 };
      state.planControl = { version: 1, stages: [
        { id: 'repair', role: 'coder', is_gate: false, dynamic_dispatch: false, retry_to: ['review'], artifact_contract: { version: 1, produces: [], reads: [] } },
        { id: 'review', role: 'qa', is_gate: true, dynamic_dispatch: false, artifact_contract: { version: 1, produces: [], reads: [] } },
      ] }; writeRunState(project, run.runId, state);
      for (const id of ['repair', 'review']) writeStageStatus(project, run.runId, id, { status: 'complete', retries: 0,
        attempts: [{ index: 1, status: 'complete', startedAt: 'start', completedAt: 'end', exitCode: 0 }] });
      appendEvidence(run.runDirPath, { kind: 'attempt', stageId: 'repair', attemptIndex: 1, attemptStartedAt: 'start',
        exitCode: 0, status: 'complete', treeHash: captureProjectTree(project).hash, files: [],
        measurements: { inputTokens: 0, outputTokens: 0, durationMs: 0, provenance: 'adapter-reported' } });
      const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1'); mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ engine_effective_pass: false,
        findings: { confirmed: originals.map(record => ({ ...finding(`value_${record.sequence}`, record.sequence), record })), unconfirmed: [] } }));
      writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Repaired',
        criteria: { C1: { status: 'pass', evidence: 'value.txt' } } }));
      let calls = 0;
      vi.spyOn(validation, 'runProjectCommand').mockImplementation(async request => {
        calls++;
        writeFileSync(join(project, request.args[1] === 'fixture other reproduction' ? 'other-receipt.txt' : 'receipt.txt'), mode === 'changing-output' ? String(calls) : 'evidence');
        return { exitCode: mode === 'nonzero' ? 1 : 0, ...(mode === 'unfinished' ? { unfinished: true } : {}), stdout: 'fixture' };
      });
      await validateSettledTree(project, run.runId);
      await validateSettledTree(project, run.runId);
      expect(calls).toBe(originals.length);
      expect(readGateEvaluation(project, 'review', run.runId)?.pass).toBe(true);
      writeFileSync(join(project, 'value.txt'), 'later change');
      await validateSettledTree(project, run.runId);
      expect(calls).toBe(originals.length);
      expect(readGateEvaluation(project, 'review', run.runId)?.pass).toBe(true);
    });

  it('checks numeric contracts before accepting unconfirmed observations with passing criteria', () => {
    const project = mkdtempSync(join(tmpdir(), 'observation-contract-')); roots.push(project);
    const run = createRun(project, 'observation-contract', 'name: observation-contract\nstages: []\n', ['review']);
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Advisory observation',
      criteria: { C1: { status: 'pass', evidence: 'Criterion assessed' } }, audit_findings: { version: 1, findings: [{ ...finding('uncited'), class: 'advisory' }] } }));
    const verdict = readGateEvaluation(project, 'review', run.runId, { metric: 'quality', threshold: 1, higherIsBetter: true }, false);
    expect(verdict?.pass).toBe(false); expect(verdict?.refusal?.kind).toBe('numeric_evidence');
    expect(verdict?.findings?.advisory?.[0].id).toBe('uncited');
    const productRun = createRun(project, 'observation-contract', 'name: observation-contract\nstages: []\n', ['review'],
      '---\noutputs: [docs/missing.md]\n---\n# Required product\n');
    writeFileSync(runRecordPath(productRun.runDirPath, 'verdict_review.json'), readFileSync(runRecordPath(run.runDirPath, 'verdict_review.json')));
    const missing = readGateEvaluation(project, 'review', productRun.runId, undefined, false);
    expect(missing?.pass).toBe(false); expect(missing?.refusal?.kind).toBe('declared_output');
  });

  it('keeps advisory observations durable without opening repair', async () => {
    const value = await workflow('observation');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(value.final.status).toBe('complete');
    expect(value.final.stages.review.gate?.findings?.advisory?.map(item => item.id)).toEqual(['unconfirmed']);
    expect(renderRunSummary(value.project, value.directory, value.final).toLowerCase()).toContain('advisory unconfirmed');
  });

  it('continues the run after reclassifying an ungrounded rejection in result correction', async () => {
    const value = await workflow('unconfirmed');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review']);
    expect(value.final.status, value.final.failureReason).toBe('complete');
    expect(value.final.stages.review.attempts).toHaveLength(1);
    expect(value.final.stages.review.gate).toMatchObject({ pass: true, findings: { confirmed: [], unconfirmed: [],
      advisory: [expect.objectContaining({ id: 'unconfirmed' })] } });
  });

  it('records native structured output and exits without inferring exits from command text', () => {
    const codex = normalizeNativeEvent({ type: 'item.completed', item: { type: 'command_execution', id: 'probe',
      command: 'node probe.mjs', exit_code: 1, aggregated_output: 'defect reproduced' } });
    expect(codex.commands[0]).toMatchObject({ exitCode: 1, output: 'defect reproduced' });
    const claude = normalizeNativeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'probe',
      content: 'Exited with code 1', is_error: true }] } });
    expect(claude.commands[0].exitCode).toBeUndefined();
    const structured = normalizeNativeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'probe' }] },
      tool_use_result: { exitCode: 1, stdout: 'defect reproduced', stderr: '' } });
    expect(structured.commands[0]).toMatchObject({ exitCode: 1, output: JSON.stringify(['defect reproduced', '']) });
  });

  it('does not confirm absent, missing, passing, foreign, stale, incomplete or declared citations', () => {
    const command: EvidenceEntry = { version: 1, at: 'now', sequence: 1, kind: 'command', owner: 'adapter-event',
      stageId: 'review', attemptIndex: 1, commandId: 'probe', command: 'node probe.mjs', exitCode: 1,
      context: { cwd: '/project', shell: '/bin/sh' }, outputDigest: 'digest', treeHash: 'tree', treeAfterHash: 'tree' };
    const gate = { stageId: 'review', attemptIndex: 1, treeHash: 'tree' };
    expect(assessFindings([finding('yes', 1)], [command], gate).confirmed).toHaveLength(1);
    for (const item of [finding('no'), finding('null', null), finding('missing', 999)]) expect(assessFindings([item], [command], gate).confirmed).toEqual([]);
    for (const patch of [{ exitCode: 0 }, { exitCode: null }, { stageId: 'author' }, { attemptIndex: 2 },
      { owner: 'declaration' as const }, { reproductionOf: 8 }, { context: undefined }, { context: { cwd: 'relative', shell: '/bin/sh' } }, { outputDigest: undefined }, { treeHash: null }, { treeAfterHash: 'changed' }]) {
      expect(assessFindings([finding('no', 1)], [{ ...command, ...patch } as EvidenceEntry], gate).confirmed).toEqual([]);
    }
    expect(assessFindings([finding('no', 1)], [command], { ...gate, treeHash: 'new' }).confirmed).toEqual([]);
  });

  it('renders one finding policy and the invocation endpoint; grounding is checked after schema parsing', async () => {
    const value = await workflow('unconfirmed');
    const prompt = buildStagePrompt({ projectDir: value.project, runDir: value.directory, runId: value.final.runId,
      dependsOn: [], promptTemplate: 'Independent reviewer', isGate: true, stageId: 'review' });
    expect(prompt.split(FINDING_POLICY_TEXT), 'P02 single finding-policy owner').toHaveLength(2);
    expect(prompt, 'P02 removed duplicate procedure').not.toContain('## Reproduced findings and validation');
    const invocation = value.calls.find(call => call.stage === 'review')!.prompt;
    for (const text of ['## Engine-recorded command', 'native shell tool', 'record.sequence',
      '"cwd":', '"shell":', 'engine-recorded reproduction']) {
      expect(invocation, 'invocation endpoint retains reproducible command context').toContain(text);
    }
    const legacy = { pass: false, reason: 'legacy', criteria: {}, audit_findings: { version: 1, findings: [finding('legacy')] },
      repairability: { version: 1, disposition: 'repairable', evidence: 'legacy evidence' } };
    expect(parseStageRecord(JSON.stringify(legacy), stageRecordSchema({ isGate: true }))).toEqual(legacy);
  });

  it.each(['absent', 'nonzero', 'unfinished', 'other-tree'] as const)(
    'does not override passing re-review for a replay that is %s', mode => {
      const project = mkdtempSync(join(tmpdir(), 'replay-fact-')); roots.push(project);
      const run = createRun(project, 'replay', 'name: replay\nstages: []\n', ['repair', 'review']);
      writeFileSync(join(project, 'value'), 'repaired');
      const tree = captureProjectTree(project).hash;
      const original = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'review', attemptIndex: 1,
        commandId: 'probe', command: 'false', context: { cwd: project, shell: '/bin/sh' }, exitCode: 1,
        outputDigest: 'original', treeHash: 'old-tree', treeAfterHash: 'old-tree' });
      const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1'); mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review', engine_effective_pass: false,
        findings: { confirmed: [{ ...finding('value', original.sequence), record: original }], unconfirmed: [] } }));
      if (mode !== 'absent') appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'repair', attemptIndex: 1,
        commandId: 'closure-value', command: 'false', context: { cwd: project, shell: '/bin/sh' },
        exitCode: mode === 'nonzero' ? 1 : 0, unfinished: mode === 'unfinished', outputDigest: 'replay',
        treeHash: mode === 'other-tree' ? 'other-tree' : tree, treeAfterHash: mode === 'other-tree' ? 'other-tree' : tree,
        reproductionOf: original.sequence });
      writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, criteria: {}, audit_findings: { version: 1, findings: [] } }));
      expect(readGateEvaluation(project, 'review', run.runId)?.pass).toBe(true);
    });

  it('carries earlier confirmed reproductions into later repair rounds instead of replaying only the latest set', () => {
    const project = mkdtempSync(join(tmpdir(), 'closure-rounds-')); roots.push(project);
    const run = createRun(project, 'rounds', 'name: rounds\nstages: []\n', ['review']);
    const records = ['one', 'two'].map(id => appendEvidence(run.runDirPath, { kind: 'command', owner: 'adapter-event',
      stageId: 'review', attemptIndex: 1, commandId: id, command: 'false', context: { cwd: project, shell: '/bin/sh' },
      exitCode: 1, outputDigest: id, treeHash: 'tree', treeAfterHash: 'tree' }));
    for (const [index, record] of records.entries()) {
      const archive = runRecordPath(run.runDirPath, `gate_reevaluation/iteration_1/round_${index + 1}`); mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review', engine_effective_pass: false,
        findings: { confirmed: [{ ...finding(`defect_${index}`, record.sequence), record }], unconfirmed: [] } }));
    }
    expect(confirmedRepairFindings(run.runDirPath, ['review'], { iteration: 1, round: 1 }).map(item => item.record.sequence)).toEqual([records[0].sequence]);
    expect(confirmedRepairFindings(run.runDirPath, ['review'], { iteration: 1, round: 2 }).map(item => item.record.sequence)).toEqual(records.map(item => item.sequence));
  });

  it.each(['gate', 'acceptedFrom'] as const)('projects uncited settled legacy observations without rewriting historical verdicts (%s)', carrier => {
    const project = mkdtempSync(join(tmpdir(), 'settled-legacy-')); roots.push(project);
    const run = createRun(project, 'legacy', 'name: legacy\nstages: []\n', ['review']);
    const raw = { pass: false, reason: 'Legacy observation', criteria: { C1: { status: 'fail', evidence: 'Inspected legacy value' } },
      audit_findings: { version: 1, findings: [(() => { const { class: _class, ...old } = finding('legacy'); return old; })()] } };
    const status = { status: 'complete' as const, retries: 0, exitCode: 0,
      attempts: [{ index: 1, status: 'complete' as const, startedAt: 'start', completedAt: 'end', exitCode: 0 }] };
    const verdict = { pass: false, reason: raw.reason };
    writeStageStatus(project, run.runId, 'review', { ...status, ...(carrier === 'gate'
      ? { gate: { ...verdict, validationRequired: false, kind: 'repairable' as const, verdictSha256: null } }
      : { acceptedFrom: { runId: 'previous', verdict } }) });
    mkdirSync(runRecordPath(run.runDirPath, 'stages/review'), { recursive: true });
    writeFileSync(runRecordPath(run.runDirPath, 'stages/review/output.md'), JSON.stringify(raw));
    const path = runRecordPath(run.runDirPath, 'verdict_review.json'); writeFileSync(path, JSON.stringify(raw));
    const before = readFileSync(path, 'utf8');
    expect(readGateEvaluation(project, 'review', run.runId, undefined, false)?.findings?.unconfirmed.map(item => item.id)).toEqual(['legacy']);
    expect(renderRunSummary(project, run.runDirPath, readRunState(project, run.runId))).toContain('unconfirmed observation legacy');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
