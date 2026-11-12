import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { declareValidation } from './test-support/structured-validation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { runWorkflow, loadWorkflow } from '../src/scheduler.js';
import { runDir, writeStageStatus, readRunState, writeRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { confirmedRepairFindings } from '../src/scheduler/sched_settlement/gate-archives.js';
import { appendEvidence, captureProjectTree, readEvidence, type EvidenceEntry } from '../src/evidence-ledger.js';
import { assessFindings, type AuditFinding } from '../src/scoped-audit-repair.js';
import { runProjectCommand } from '../src/project-validation.js';
import * as validation from '../src/project-validation.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { normalizeNativeEvent } from '../src/adapters/native-events.js';
import { buildStagePrompt, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { renderRunSummary } from '../src/run-summary.js';
import { startCommandRecorder } from '../src/recorded-command.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const finding = (id: string, reproduction?: number | null): AuditFinding => ({ id, paths: ['docs/value.txt'],
  reason: 'Value must be repaired', criterion_ids: [], invalidates_plan: false, repair_role: 'coder',
  ...(reproduction === undefined ? {} : { reproduction }) });

async function workflow(mode: 'mixed' | 'unconfirmed' | 'observation', failedRepair = false, observeAfterRepair = false, needsValidationPreparation = false, variant?: 'long' | 'cwd' | 'bash' | 'unknown' | 'recorded', route?: [string, string, string?]) {
  const project = mkdtempSync(join(tmpdir(), 'confirmed-gate-')); roots.push(project);
  // Assessment routing requires a complete readable diff, including in the repair scenarios.
  isolatedProjectCommand('git', ['init', '-q'], project, project);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], project, project);
  const calls: Array<{ stage: string; prompt: string }> = [];
  let review = 0;
  let assessments = 0;
  const dependency = mkdtempSync(join(tmpdir(), 'closure-dependency-')); roots.push(dependency);
  const marker = join(dependency, 'ready');
  if (needsValidationPreparation) {
    declareValidation(project, { test: { command: 'npm', args: ['run', 'test'] } });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ packageManager: 'npm@10.9.7', scripts: { test: 'fixture-check' } }));
    vi.spyOn(validation, 'runValidationCommand').mockImplementation(request => {
      if (readFileSync(join(project, 'docs/value.txt'), 'utf8') === 'repaired') writeFileSync(marker, 'ready');
      return { exitCode: 0, stdout: 'Configured fixture passed' };
    });
  }
  const condition = `require('node:fs').readFileSync('${variant === 'cwd' ? 'value.txt' : 'docs/value.txt'}','utf8')==='repaired'`
    + (needsValidationPreparation ? ` && require('node:fs').existsSync(${JSON.stringify(marker)})` : '');
  const command = variant === 'recorded' ? '[[ "$(cat value.txt)" == repaired ]]' : variant === 'bash' ? '[[ "$(cat docs/value.txt)" == repaired ]]'
    : (variant === 'long' ? 'true' + ' '.repeat(510) + '; ' : '') + `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${condition}?0:1)`)}`;
  const context = { cwd: variant === 'cwd' || variant === 'recorded' ? join(project, 'docs') : project,
    shell: variant === 'bash' || variant === 'recorded' ? '/bin/bash' : '/bin/sh' };
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push({ stage: opts.stageId, prompt });
    const result = (value: unknown, writes: string[] = []) => ({ output: JSON.stringify(value), exitCode: 0, duration_ms: 1,
      writes, writeAttribution: 'structured' as const });
    if (opts.stageId === 'choose') return result({ successor: 'implement', reason: 'One output', assumptions: [] });
    if (opts.stageId === 'assess') return result({ successor: route![Math.min(++assessments - 1, route!.length - 1)], reason: 'Review current value', risk_areas: [] });
    if (opts.stageId === 'later_author') {
      writeFileSync(join(project, 'docs/other.txt'), 'Independent downstream output');
      return result({ successor: 'assess', reason: 'Review independent later output' }, ['docs/other.txt']);
    }
    if (['review', 'review_full'].includes(opts.stageId)) {
      const first = ++review === 1;
      let sequence: number | undefined;
      if ((first || route?.length === 3 && review === 3) && mode === 'mixed') {
        const tracker = new CommandActivityTracker({ runDir: opts.runDir, stageId: opts.stageId, attemptIndex: 1,
          attemptStartedAt: new Date().toISOString(), onLifecycle: opts.onCommandLifecycle });
        const client = variant !== 'unknown' ? prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0] : undefined;
        const transportedCommand = client ? `${client} '${JSON.stringify({ command, ...context }).replaceAll("'", "'\\''")}'` : command;
        tracker.feed(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'reviewer-probe', command: transportedCommand,
          ...(variant === 'unknown' || client ? {} : context) } }) + '\n');
        const response = await runProjectCommand({ command: context.shell, args: ['-c', transportedCommand], role: 'test', display: transportedCommand,
          cwd: context.cwd, runDir: opts.runDir, timeoutMs: 5000 });
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
      const observation = !first && observeAfterRepair;
      return result({ pass: !first && !observation, reason: first ? 'Review observations' : 'Independent recheck passed',
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: !first || mode === 'observation' ? 'pass' : 'fail', evidence: 'Read docs/value.txt' }])),
        audit_findings: { version: 1, findings: first ? [...(mode === 'mixed' ? [finding('confirmed', sequence)] : []), finding('unconfirmed')] : observation ? [finding('observation_after_repair')] : [] },
        ...(!first && !observation ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: 'reviewed value' } }) });
    }
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs/value.txt'), opts.stageId === 'repair' && !failedRepair ? 'repaired' : 'bad');
    if (route && opts.stageId === 'repair') return result({ successor: 'assess', reason: 'Reassess the repaired value' }, ['docs/value.txt']);
    return result({ status: 'delivered', summary: 'Value delivered', caveats: [], remaining_work: [] }, ['docs/value.txt']);
  } };
  const { config, raw } = loadWorkflow(resolve(`config/workflows/${route ? 'entry' : 'direct'}.yaml`));
  if (route?.length === 3) config.dispatch!.push({ id: 'later_author', role: 'coder', depends_on: [route[1]],
    scope: ['docs/other.txt'], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false,
    artifact_contract: { version: 1, produces: [], reads: [] },
    decision: { successors: ['assess'], default: 'assess', kind: 'successor' } });
  const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"The value is independently checked.\"}]\noutputs: [docs/value.txt]\n---\n# Deliver a value\n\n## Acceptance criteria\n1. The value is independently checked.\n";
  const final = await runWorkflow(config, route?.length === 3 ? JSON.stringify(config) : raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
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
    const call = (request: unknown) => runProjectCommand({ role: 'test', command: '/bin/sh',
      args: ['-c', `${recorder.command} '${JSON.stringify(request).replaceAll("'", "'\\''")}'`],
      display: 'recorder client', cwd: directory, timeoutMs: 5000 });
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
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
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
    expect(value.final.status).toBe(variant === 'bash' ? 'complete' : 'incomplete');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
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

  it('keeps a native command with unknown execution context unconfirmed without assuming the project root', async () => {
    const value = await workflow('mixed', false, false, false, 'unknown');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.gate?.findings?.confirmed).toEqual([]);
    expect(value.final.stages.review.gate?.findings?.unconfirmed.map(item => item.id)).toEqual(['confirmed', 'unconfirmed']);
  });

  it('records a reviewer-run command and repairs only the confirmed finding, closing its reproduction on the repaired tree', async () => {
    const value = await workflow('mixed');
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(value.final.status).toBe('complete');
    const reproduction = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === 'review')!;
    expect(reproduction).toMatchObject({ kind: 'command', owner: 'code', stageId: 'review', exitCode: 1,
      treeHash: expect.stringMatching(/^[a-f0-9]{64}$/), outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (reproduction.kind !== 'command') throw Error('missing reproduction');
    expect(reproduction.treeAfterHash).toBe(reproduction.treeHash);
    const repairFacts = JSON.parse(value.calls.find(call => call.stage === 'repair')!.prompt.split('# Gate repair facts\n')[1].split('\n')[0]);
    const repair = JSON.stringify(repairFacts.confirmedFindings);
    expect(repair).toContain('"id":"confirmed"'); expect(repair).not.toContain('"id":"unconfirmed"');
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === reproduction.sequence)!;
    expect(closure).toMatchObject({ kind: 'command', owner: 'code', stageId: 'repair', exitCode: 0,
      treeHash: expect.any(String), treeAfterHash: expect.any(String), outputDigest: expect.any(String) });
    if (closure.kind !== 'command') throw Error('missing closure');
    expect(closure.treeHash).toBe(closure.treeAfterHash); expect(closure.treeHash).not.toBe(reproduction.treeHash);
    const archived = readFileSync(runRecordPath(value.directory, 'gate_reevaluation/iteration_1/round_1/engine_verdict_review.json'), 'utf8');
    expect(archived).toContain('"unconfirmed"');
    expect(renderRunSummary(value.project, value.directory, value.final)).toContain('Unconfirmed observations: unconfirmed');
  });

  it('replays closure after the configured validation prepares current repair dependencies, without another suite', async () => {
    const value = await workflow('mixed', false, false, true);
    expect(value.final.status).toBe('complete');
    expect(validation.runValidationCommand).toHaveBeenCalledTimes(2);
    const configured = value.ledger.filter(entry => entry.kind === 'validation');
    expect(configured.map(entry => entry.stageId)).toEqual(['implement', 'repair']);
    const closure = value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)!;
    expect(closure).toMatchObject({ exitCode: 0 });
    expect(closure.sequence).toBeGreaterThan(configured[1].sequence);
  });

  it('does not close a finding when the repair reproduction still fails, even if the next model verdict passes', async () => {
    const value = await workflow('mixed', true);
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.gate).toMatchObject({ pass: false, refusal: { kind: 'audit_findings' } });
    expect(value.final.stages.review.gate?.reason).toContain('Repair reproduction remains open');
    expect(value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)).toMatchObject({ exitCode: 1 });
  });

  it('does not let observation-only acceptance bypass an open repair reproduction', async () => {
    const value = await workflow('mixed', true, true);
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.gate).toMatchObject({ pass: false, refusal: { kind: 'audit_findings' } });
    expect(value.final.stages.review.gate?.findings?.unconfirmed[0].id).toBe('observation_after_repair');
  });

  it.each([
    ['review', 'review_full'], ['review_full', 'review'],
    ['review', 'review'], ['review_full', 'review_full'],
  ])('retains reproduction closure across assessment choices (%s → %s)', { timeout: 60_000 }, async (first, second) => {
    for (const failedRepair of [true, false]) {
      const value = await workflow('mixed', failedRepair, false, false, 'recorded', [first, second]);
      expect(value.calls.map(call => call.stage)).toEqual(['choose', 'implement', 'assess', first, 'repair', 'assess', second]);
      expect(value.final.status).toBe(failedRepair ? 'incomplete' : 'complete');
      expect(value.final.stages[second].gate?.pass).toBe(!failedRepair);
      expect(value.final.decisionGraph?.records.filter(record => record.stageId === second).at(-1)?.gateAccepted).toBe(!failedRepair);
      if (failedRepair) expect(value.final.stages[second].gate?.reason).toContain('Repair reproduction remains open');
      const original = value.ledger.find(entry => entry.kind === 'command' && entry.owner === 'code' && entry.stageId === first)!;
      expect(original).toMatchObject({ exitCode: 1 });
      expect(value.ledger.find(entry => entry.kind === 'command' && entry.reproductionOf === original.sequence))
        .toMatchObject({ exitCode: failedRepair ? 1 : 0 });
    }
  });

  it.each(['review', 'review_full'])('keeps an accepted repair closed after independent downstream work and reassessment to %s', async last => {
    const value = await workflow('mixed', false, false, false, 'recorded', ['review', 'review', last]);
    expect(value.calls.map(call => call.stage)).toEqual(['choose', 'implement', 'assess', 'review', 'repair', 'assess',
      'review', 'later_author', 'assess', last]);
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

  it('checks numeric contracts before accepting unconfirmed observations with passing criteria', () => {
    const project = mkdtempSync(join(tmpdir(), 'observation-contract-')); roots.push(project);
    const run = createRun(project, 'observation-contract', 'name: observation-contract\nstages: []\n', ['review']);
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: false, reason: 'Unconfirmed observation',
      criteria: { C1: { status: 'pass', evidence: 'Criterion assessed' } }, audit_findings: { version: 1, findings: [finding('uncited')] } }));
    const verdict = readGateEvaluation(project, 'review', run.runId, { metric: 'quality', threshold: 1, higherIsBetter: true }, false);
    expect(verdict?.pass).toBe(false); expect(verdict?.refusal?.kind).toBe('numeric_evidence');
    expect(verdict?.findings?.unconfirmed[0].id).toBe('uncited');
    writeFileSync(runRecordPath(run.runDirPath, 'task_brief.md'), '---\noutputs: [docs/missing.md]\n---\n# Required product\n');
    const missing = readGateEvaluation(project, 'review', run.runId, undefined, false);
    expect(missing?.pass).toBe(false); expect(missing?.refusal?.kind).toBe('declared_output');
  });

  it.each(['unconfirmed', 'observation'] as const)('keeps %s observations durable without opening repair and respects criterion status', async mode => {
    const value = await workflow(mode);
    expect(value.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(value.final.status).toBe(mode === 'observation' ? 'complete' : 'incomplete');
    expect(value.final.stages.review.gate?.findings?.unconfirmed.map(item => item.id)).toEqual(['unconfirmed']);
    expect(value.ledger.some(entry => entry.kind === 'decision' && entry.verdict.pass === false)).toBe(true);
    const summary = renderRunSummary(value.project, value.directory, value.final);
    expect(summary).toContain('unconfirmed observation unconfirmed');
    expect(summary).toContain('no repair requested');
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
    for (const item of [finding('no'), finding('null', null), finding('missing', 999)]) expect(assessFindings([item], [command], gate).unconfirmed).toEqual([item]);
    for (const patch of [{ exitCode: 0 }, { exitCode: null }, { stageId: 'author' }, { attemptIndex: 2 },
      { owner: 'declaration' as const }, { reproductionOf: 8 }, { context: undefined }, { context: { cwd: 'relative', shell: '/bin/sh' } }, { outputDigest: undefined }, { treeHash: null }, { treeAfterHash: 'changed' }]) {
      expect(assessFindings([finding('no', 1)], [{ ...command, ...patch } as EvidenceEntry], gate).confirmed).toEqual([]);
    }
    expect(assessFindings([finding('no', 1)], [command], { ...gate, treeHash: 'new' }).confirmed).toEqual([]);
  });

  it('renders the reviewer reproduction contract and reads old closed-schema findings without a citation', async () => {
    const value = await workflow('unconfirmed');
    const prompt = buildStagePrompt({ projectDir: value.project, runDir: value.directory, runId: value.final.runId,
      dependsOn: [], promptTemplate: 'Independent reviewer', isGate: true, stageId: 'review' });
    for (const text of ['must cite its reproduction record', 'integer sequence in evidence-ledger.jsonl', 'native shell tool',
      'structured exit code, output digest and tree hash', 'explicit absolute cwd and shell', 'engine-recorded command endpoint', 'returns record.sequence',
      'independent read-only scope []', 'run your own experiments']) expect(prompt).toContain(text);
    const legacy = { pass: false, reason: 'legacy', criteria: {}, audit_findings: { version: 1, findings: [finding('legacy')] },
      repairability: { version: 1, disposition: 'repairable', evidence: 'legacy evidence' } };
    expect(parseStageRecord(JSON.stringify(legacy), stageRecordSchema({ isGate: true }))).toEqual(legacy);
  });

  it.each(['absent', 'partial', 'later', 'wrong-context', 'wrong-command', 'stale', 'complete'] as const)(
    'requires a current passing replay of every archived confirmed reproduction (%s)', async mode => {
      const project = mkdtempSync(join(tmpdir(), 'closure-set-')); roots.push(project);
      const run = createRun(project, 'closure', 'name: closure\nstages: []\n', ['repair', 'later', 'review']);
      const context = { cwd: project, shell: '/bin/sh' };
      for (const id of ['one', 'two']) writeFileSync(join(project, id), 'bad');
      const before = captureProjectTree(project).hash;
      const originals: EvidenceEntry[] = [];
      for (const id of ['one', 'two']) {
        const command = `test "$(cat ${id})" = good`;
        const response = await runProjectCommand({ role: 'test', command: context.shell, args: ['-c', command], display: command, cwd: project, timeoutMs: 5000 });
        expect(response.exitCode).toBe(1);
        originals.push(appendEvidence(run.runDirPath, { kind: 'command', owner: 'adapter-event', stageId: 'review', attemptIndex: 1,
          commandId: id, command, context, exitCode: response.exitCode, outputDigest: 'original', treeHash: before, treeAfterHash: before }));
      }
      const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1'); mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review', engine_effective_pass: false,
        findings: { confirmed: originals.map((record, index) => ({ ...finding(`defect_${index}`, record.sequence), record })), unconfirmed: [] } }));
      for (const id of ['one', 'two']) writeFileSync(join(project, id), mode === 'partial' && id === 'two' ? 'bad' : 'good');
      const after = captureProjectTree(project).hash;
      for (const [index, original] of originals.entries()) {
        if (mode === 'absent' || mode === 'partial' && index === 1 || original.kind !== 'command') continue;
        const response = await runProjectCommand({ role: 'test', command: context.shell, args: ['-c', original.command!], display: original.command!, cwd: project, timeoutMs: 5000 });
        expect(response.exitCode).toBe(0);
        appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'repair', attemptIndex: 1,
          commandId: `closure-${index}`, command: mode === 'wrong-command' ? 'true' : original.command,
          context: mode === 'wrong-context' ? { ...context, cwd: '/elsewhere' } : context, exitCode: mode === 'later' ? 1 : response.exitCode,
          outputDigest: 'closure', treeHash: mode === 'stale' ? before : after, treeAfterHash: after, reproductionOf: original.sequence });
      }
      if (mode === 'partial') {
        const response = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', 'test "$(cat two)" = good'], display: 'remaining defect', cwd: project, timeoutMs: 5000 });
        expect(response.exitCode).toBe(1);
      }
      for (const id of ['repair', ...(mode === 'later' ? ['later'] : []), 'review']) {
        writeStageStatus(project, run.runId, id, { status: 'complete', retries: 0, exitCode: 0,
          attempts: [{ index: 1, status: 'complete', startedAt: 'start', completedAt: 'end', exitCode: 0 }] });
        if (id !== 'review') appendEvidence(run.runDirPath, { kind: 'attempt', stageId: id, attemptIndex: 1,
          attemptStartedAt: 'start', exitCode: 0, status: 'complete', treeHash: after, files: [],
          measurements: { inputTokens: 0, outputTokens: 0, durationMs: 1, provenance: 'adapter-reported' } });
      }
      writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Model accepts', criteria: {}, audit_findings: { version: 1, findings: [] } }));
      expect(readGateEvaluation(project, 'review', run.runId, undefined, false)?.pass).toBe(mode === 'complete');
    });

  it.each([
    { gateAccepted: false, beforeReplay: false },
    { gateAccepted: true, beforeReplay: true },
  ])('refuses historical closure with gateAccepted=$gateAccepted and attempt before replay=$beforeReplay', async ({ gateAccepted, beforeReplay }) => {
    const project = mkdtempSync(join(tmpdir(), 'historical-closure-')); roots.push(project);
    const run = createRun(project, 'historical', 'name: historical\nstages: []\n', ['repair', 'review']);
    const context = { cwd: project, shell: '/bin/sh' }, command = 'test "$(cat value)" = good';
    const execute = () => runProjectCommand({ role: 'test', command: context.shell, args: ['-c', command], display: command, cwd: project, timeoutMs: 5000 });
    writeFileSync(join(project, 'value'), 'bad');
    const before = captureProjectTree(project).hash;
    const original = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'review', attemptIndex: 1,
      commandId: 'original', command, context, exitCode: (await execute()).exitCode, outputDigest: 'original', treeHash: before, treeAfterHash: before });
    expect(original).toMatchObject({ exitCode: 1 });
    const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1'); mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review', engine_effective_pass: false,
      findings: { confirmed: [{ ...finding('value', original.sequence), record: original }], unconfirmed: [] } }));
    writeFileSync(join(project, 'value'), 'good');
    const repaired = captureProjectTree(project).hash;
    const attempt = () => appendEvidence(run.runDirPath, { kind: 'attempt', stageId: 'review', attemptIndex: 2,
      attemptStartedAt: 'review-start', exitCode: 0, status: 'complete', treeHash: repaired, files: [],
      measurements: { inputTokens: 0, outputTokens: 0, durationMs: 1, provenance: 'adapter-reported' } });
    const earlierAttempt = beforeReplay ? attempt() : undefined;
    const closure = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'repair', attemptIndex: 1,
      commandId: 'closure', command, context, exitCode: (await execute()).exitCode, outputDigest: 'closure',
      treeHash: repaired, treeAfterHash: repaired, reproductionOf: original.sequence });
    expect(closure).toMatchObject({ exitCode: 0, treeHash: repaired, treeAfterHash: repaired });
    const reviewed = earlierAttempt ?? attempt();
    expect(reviewed.sequence < closure.sequence).toBe(beforeReplay);
    const state = readRunState(project, run.runId);
    state.decisionGraph = { records: [{ key: '1/review/2/review-start', stageId: 'review', iteration: 1,
      outcome: 'chosen', successor: 'later', reason: 'Authored pass and routing are insufficient', gateAccepted }],
      enabled: {}, visits: {}, declarations: [] };
    writeRunState(project, run.runId, state);
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0, exitCode: 0,
      attempts: [{ index: 2, status: 'complete', startedAt: 'review-start', completedAt: 'review-end', exitCode: 0 }] });
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Model accepts', criteria: {},
      audit_findings: { version: 1, findings: [] } }));
    // The valid replay closes on its current tree; only historical authority is missing.
    expect(readGateEvaluation(project, 'review', run.runId, undefined, false)?.pass).toBe(true);
    writeFileSync(join(project, 'other'), 'Independent later output');
    expect(captureProjectTree(project).hash).not.toBe(repaired);
    expect(confirmedRepairFindings(run.runDirPath, ['review'])).toHaveLength(1);
    expect(readGateEvaluation(project, 'review', run.runId, undefined, false)).toMatchObject({
      pass: false, refusal: { kind: 'audit_findings' } });
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

  it('does not reopen a completed repair at an unrelated later gate', async () => {
    const project = mkdtempSync(join(tmpdir(), 'unrelated-gate-')); roots.push(project);
    const run = createRun(project, 'unrelated', 'name: unrelated\nstages: []\n', ['repair', 'review', 'later_review']);
    const context = { cwd: project, shell: '/bin/sh' }, command = 'test "$(cat value)" = good';
    writeFileSync(join(project, 'value'), 'bad');
    const before = captureProjectTree(project).hash;
    const execute = () => runProjectCommand({ role: 'test', command: context.shell, args: ['-c', command], display: command, cwd: project, timeoutMs: 5000 });
    const original = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'review', attemptIndex: 1,
      commandId: 'original', command, context, exitCode: (await execute()).exitCode, outputDigest: 'original', treeHash: before, treeAfterHash: before });
    expect(original).toMatchObject({ exitCode: 1 });
    const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1'); mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ engine_effective_pass: false,
      findings: { confirmed: [{ ...finding('value', original.sequence), record: original }], unconfirmed: [] } }));
    writeFileSync(join(project, 'value'), 'good');
    const repaired = captureProjectTree(project).hash;
    appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'repair', attemptIndex: 1,
      commandId: 'closure', command, context, exitCode: (await execute()).exitCode, outputDigest: 'closure', treeHash: repaired, treeAfterHash: repaired, reproductionOf: original.sequence });
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, criteria: {} }));
    expect(readGateEvaluation(project, 'review', run.runId, undefined, false)?.pass).toBe(true);
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0,
      gate: { pass: true, validationRequired: false, kind: 'pass', verdictSha256: null } });
    // Independent downstream work changes the tree after that repair closed.
    writeFileSync(join(project, 'other'), 'later output');
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_later_review.json'), JSON.stringify({ pass: true, criteria: {} }));
    expect(readGateEvaluation(project, 'later_review', run.runId, undefined, false)?.pass).toBe(true);
  });

  it.each(['gate', 'acceptedFrom'] as const)('projects uncited settled legacy observations without rewriting historical verdicts (%s)', carrier => {
    const project = mkdtempSync(join(tmpdir(), 'settled-legacy-')); roots.push(project);
    const run = createRun(project, 'legacy', 'name: legacy\nstages: []\n', ['review']);
    const raw = { pass: false, reason: 'Legacy observation', criteria: { C1: { status: 'fail', evidence: 'Inspected legacy value' } },
      audit_findings: { version: 1, findings: [finding('legacy')] } };
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
