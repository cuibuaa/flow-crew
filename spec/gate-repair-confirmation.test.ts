import { parseDispatchedStageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { settleDecisions } from '../src/scheduler/sched_loop/decisions.js';
import { concludeWorkflowIteration } from '../src/scheduler/sched_loop/iteration-outcome.js';
import './test-support/policy-runtime.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { parseBriefDeclarations } from '../src/brief-declarations.js';
import { tryTerminateOnTerminalState } from '../src/scheduler.js';
import { loadWorkflow } from '../src/scheduler.js';
import { stageFixtureCommand } from './test-support/stage-command.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { runDir, writeStageStatus, readRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { appendEvidence, captureProjectTree, readEvidence } from '../src/evidence-ledger.js';
import { FINDING_POLICY_TEXT, type AuditFinding } from '../src/scoped-audit-repair.js';
import { normalizeNativeEvent } from '../src/adapters/native-events.js';
import { buildStagePrompt } from '../src/handoff.js';
import { renderRunSummary } from '../src/run-summary.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const finding = (id: string, reproduction?: number | null): AuditFinding => ({ id, class: 'regression', paths: ['docs/value.txt'],
  reason: 'The document contradicts the declared source.', criterion_ids: [], invalidates_plan: false, repair_role: 'coder',
  ...(reproduction === undefined ? {} : { reproduction }) });
type Options = { role?: string; gap?: boolean; blocked?: boolean; allowed?: boolean; terminal?: boolean; irreparable?: boolean;
  invalid?: 'empty' | 'criterion' | 'unknown'; loop?: boolean; probe?: 'bounded-chunks' | 'stateful-probe'; validation?: boolean; rejections?: number; advisoryOnly?: boolean; advisoryAfterRepair?: boolean; downstream?: boolean };
async function workflow(options: Options = {}) {
  const project = mkdtempSync(join(tmpdir(), 'gate-outcome-')); roots.push(project);
  const calls: string[] = [], prompts: string[] = [];
  let reviews = 0, probes = 0;
  const task = `---\n${stringify({ criteria: [{ id: 'value', text: 'Deliver the correct documented value.' }], outputs: ['docs/value.txt'],
    ...(options.allowed === undefined ? {} : { allow_blocked_acceptance: options.allowed }),
    ...(options.terminal ? { terminal_states: { complete: 'docs/value.txt' } } : {}),
    ...(options.validation ? { validation: { commands: { test: { command: process.execPath, args: ['check.cjs'] } } } } : {}) })}---\nReview the evidence and report remaining limits.\n`;
  if (options.validation) writeFileSync(join(project, 'check.cjs'), 'process.exit(7);');
  const configPath = join(project, 'workflow.yaml');
  const stages = [
    { id: 'author', role: 'coder', scope: ['docs/'], criterion_refs: ['value'] },
    { id: 'review', role: options.role ?? 'qa', is_gate: true, prompt_template: 'Review independently. Phase metadata: {phase_metadata_fields}.', depends_on: ['author'], scope: [], criterion_refs: ['value'] },
    { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['docs/'], criterion_refs: ['value'] },
    ...(options.downstream ? [{ id: 'downstream', role: 'coder', depends_on: ['review'], scope: ['docs/'], criterion_refs: ['value'] },
      { id: 'final_review', role: 'qa', depends_on: ['downstream'], is_gate: true, scope: [], criterion_refs: ['value'] }] : []),
  ];
  writeFileSync(configPath, stringify({ name: 'gate-outcome', defaults: { max_iterations: 1, max_retries: 0 }, stages }));
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId); prompts.push(prompt);
    if (opts.stageId === 'review' || opts.stageId === 'final_review') {
      const reject = opts.stageId === 'review' && !options.blocked && !options.advisoryOnly && (++reviews <= (options.rejections ?? 1) || options.loop);
      let reproduction: number | undefined;
      if (reject && options.probe) {
        const count = stageWorkPath(opts.runDir, 'stages/review/probe-count.txt');
        const program = `const fs=require('node:fs');const count=${JSON.stringify(count)};const n=fs.existsSync(count)?Number(fs.readFileSync(count,'utf8')):0;fs.writeFileSync(count,String(n+1));`
          + (options.probe === 'bounded-chunks'
            ? `if(fs.readFileSync('docs/value.txt','utf8')!=='wrong value')throw Error('Probe pins the old source image');`
            : `if(n!==0)throw Error('Probe needs fresh mutable state');`)
          + `process.exit(1);`;
        const response = await stageFixtureCommand({ role: 'test', command: process.execPath, args: ['-e', program],
          cwd: project, runDir: opts.runDir });
        expect(response.exitCode).toBe(1); probes++;
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const tree = captureProjectTree(project).hash;
        reproduction = appendEvidence(opts.runDir, { kind: 'command', owner: 'adapter-event', stageId: 'review', attemptIndex: reviews,
          commandId: options.probe, command: `${quote(process.execPath)} -e ${quote(program)}`, context: { cwd: project, shell: '/bin/sh' }, exitCode: 1,
          outputDigest: options.probe, treeHash: tree, treeAfterHash: tree }).sequence;
      }
      const outcome = options.blocked ? 'accepted_blocked' : reject ? options.irreparable ? 'rejected_irreparable' : 'rejected_repairable' : 'accepted';
      const status = options.blocked ? 'not_assessed' : reject ? 'fail' : 'pass';
      const defect = { ...finding('document_defect', reproduction), class: 'criterion_unmet', criterion_ids: ['value'], ...(options.invalid === 'criterion' ? { class: 'criterion_unmet', criterion_ids: ['value'] }
        : options.invalid === 'unknown' ? { class: 'criterion_unmet', criterion_ids: ['invented'] } : {}) };
      return { output: JSON.stringify({ outcome, reason: reject ? 'Independent inspection establishes the defect.' : 'Independent review accepts the report.',
        criteria: { value: { status: options.invalid === 'criterion' ? 'pass' : status, evidence: 'Read the source and document.',
          ...(status === 'not_assessed' ? { reason: 'capability_unavailable' } : {}) } },
        audit_findings: { version: 1, findings: reject && options.invalid !== 'empty' ? [defect] : options.advisoryOnly || options.advisoryAfterRepair ? [{ ...finding('unconfirmed'), class: 'advisory' }] : [] } }), exitCode: 0, duration_ms: 1 };
    }
    mkdirSync(join(project, 'docs'), { recursive: true });
    if (opts.stageId === 'downstream') writeFileSync(join(project, 'docs/other.txt'), 'Independent downstream output');
    else writeFileSync(join(project, 'docs/value.txt'), opts.stageId === 'repair' ? 'correct value' : 'wrong value');
    return { output: JSON.stringify({ status: options.gap ? 'environment_gap' : 'delivered', summary: options.gap ? 'Resource unavailable.' : 'Updated document.',
      blocks: options.gap ? { criterion_ids: ['value'], paths: ['docs/'] } : null, caveats: [], remaining_work: [] }),
      exitCode: 0, duration_ms: 1, writes: [opts.stageId === 'downstream' ? 'docs/other.txt' : 'docs/value.txt'], writeAttribution: 'structured' };
  } };
  const { config, raw } = loadWorkflow(configPath);
  const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, join(import.meta.dirname, '../config/agents'), undefined, task, true);
  return { project, final, calls, prompts, probes, directory: runDir(project, final.runId) };
}

describe('gate outcome is the single repair and acceptance owner', () => {
  it.each(['qa', 'doc_reviewer'])('repairs a non-executable defect without any command (%s)', async role => {
    const result = await workflow({ role });
    expect(result.final.status, result.final.failureReason).toBe('complete');
    expect(result.calls).toEqual(['author', 'review', 'repair', 'review']);
    expect(readEvidence(result.directory).filter(entry => entry.kind === 'command')).toEqual([]);
    expect(readFileSync(join(result.project, 'docs/value.txt'), 'utf8')).toBe('correct value');
    expect(result.final.stages.review.gate).toMatchObject({ outcome: 'accepted', pass: true });
  });
  it.each(['bounded-chunks', 'stateful-probe'] as const)('completes the %s shape without re-executing reviewer evidence', async probe => {
    const result = await workflow({ probe });
    expect(result.final.status, result.final.failureReason).toBe('complete');
    expect(result.probes).toBe(1);
    expect(readFileSync(stageWorkPath(result.directory, 'stages/review/probe-count.txt'), 'utf8')).toBe('1');
    expect(readEvidence(result.directory).filter(entry => entry.kind === 'command')).toHaveLength(1);
    expect(result.calls).toEqual(['author', 'review', 'repair', 'review']);
  });
  it('dispatches another repair when the second review rejects with a grounded finding', async () => {
    const value = await workflow({ rejections: 2 });
    expect(value.calls).toEqual(['author', 'review', 'repair', 'review', 'repair', 'review']);
    expect(value.final.status).toBe('complete');
    expect(value.final.decisionGraph?.records.filter(record => record.stageId === 'review').map(record => record.gateAccepted)).toEqual([false, false, true]);
    expect(readFileSync(join(value.project, 'docs/value.txt'), 'utf8')).toBe('correct value');
  });
  it('rejects declared validation failure on the repaired tree even when re-review passes', async () => {
    const value = await workflow({ validation: true });
    expect(value.final.status).toBe('incomplete');
    expect(value.final.stages.review.gate).toMatchObject({ pass: false, refusal: { kind: 'validation_regression' } });
    expect(value.final.stages.review.gate?.validation?.map(command => command.exitCode)).toEqual([7]);
    expect(value.final.stages.review.gate?.reason).toContain('Engine validation rejected');
    expect(JSON.parse(readFileSync(runRecordPath(value.directory, 'verdict_review.json'), 'utf8')).outcome).toBe('accepted');
  });
  it('keeps an accepted repair closed after independent downstream work and another review', async () => {
    const value = await workflow({ downstream: true, probe: 'stateful-probe' });
    expect(value.calls).toEqual(['author', 'review', 'repair', 'review', 'downstream', 'final_review']);
    expect(readFileSync(join(value.project, 'docs/value.txt'), 'utf8')).toBe('correct value');
    expect(readFileSync(join(value.project, 'docs/other.txt'), 'utf8')).toBe('Independent downstream output');
    expect(value.final.stages.final_review.gate?.pass).toBe(true); expect(value.final.status).toBe('complete');
    expect(readEvidence(value.directory).filter(entry => entry.kind === 'command')).toHaveLength(1);
  });
  it('keeps advisory observations durable without opening repair', async () => {
    const value = await workflow({ advisoryOnly: true });
    expect(value.calls).toEqual(['author', 'review']); expect(value.final.status).toBe('complete');
    const raw = JSON.parse(readFileSync(runRecordPath(value.directory, 'verdict_review.json'), 'utf8'));
    expect(raw.audit_findings.findings.map((item: AuditFinding) => item.id)).toEqual(['unconfirmed']);
    expect(renderRunSummary(value.project, value.directory, value.final).toLowerCase()).toContain('advisory');
    expect(renderRunSummary(value.project, value.directory, value.final)).toContain('unconfirmed');
  });
  it('accepts advisory findings after repair even when the original experiment is non-replayable', async () => {
    const value = await workflow({ advisoryAfterRepair: true, probe: 'bounded-chunks' });
    expect(value.final.status).toBe('complete'); expect(value.final.stages.review.gate).toMatchObject({ pass: true });
    const raw = JSON.parse(readFileSync(runRecordPath(value.directory, 'verdict_review.json'), 'utf8'));
    expect(raw.audit_findings.findings).toMatchObject([{ id: 'unconfirmed', class: 'advisory' }]);
  });
  it('dispatches repair when the author gap covers every rejected criterion and path', async () => {
    const result = await workflow({ gap: true });
    expect(result.calls).toEqual(['author', 'review', 'repair', 'review']);
    expect(result.final.status, result.final.failureReason).toBe('complete');
  });
  it('accepts declared blocked outcome with honest not_assessed criteria and a distinct terminal status', async () => {
    const result = await workflow({ blocked: true, allowed: true });
    expect(result.final.status, result.final.failureReason).toBe('accepted_blocked');
    expect(result.final.reasonCode).toBe('accepted_blocked');
    const raw = JSON.parse(readFileSync(runRecordPath(result.directory, 'verdict_review.json'), 'utf8'));
    expect(raw).toMatchObject({ outcome: 'accepted_blocked', criteria: { value: { status: 'not_assessed' } } });
    expect(raw).not.toHaveProperty('pass'); expect(raw).not.toHaveProperty('repairability');
    expect(result.calls).toEqual(['author', 'review']);
  });
  it.each([undefined, false])('refuses blocked acceptance without boolean permission (%s), naming allow_blocked_acceptance', async allowed => {
    const result = await workflow({ blocked: true, allowed });
    expect(['complete', 'accepted_blocked']).not.toContain(result.final.status);
    expect(result.final.stages.review.error).toContain('allow_blocked_acceptance');
    expect(result.calls[0]).toBe('author');
    expect(result.calls.slice(1).every(stage => stage === 'review')).toBe(true);
    expect(result.final.resourcePolicy?.resultCorrections).toBe(1);
  });
  it('completes ordinarily with permission, a plain accepted gate and a declared report file present', async () => {
    const result = await workflow({ allowed: true, advisoryOnly: true, terminal: true });
    expect(result.calls).toEqual(['author', 'review']);
    expect(existsSync(join(result.project, 'docs/value.txt'))).toBe(true);
    expect(result.final.stages.review.gate?.outcome).toBe('accepted');
    expect(result.final.status, result.final.failureReason).toBe('complete');
    expect(result.final.reasonCode).toBe('terminal_artifact');
  });
  it('refuses accepted_blocked as a terminal-file declaration and rejects nonboolean permission', () => {
    expect(() => parseBriefDeclarations('---\nterminal_states: {accepted_blocked: reports/limited.md}\n---\nResult.'))
      .toThrow('terminal_states.accepted_blocked');
    expect(() => parseBriefDeclarations('---\nallow_blocked_acceptance: "true"\n---\nResult.'))
      .toThrow('allow_blocked_acceptance');
  });
  it('cannot publish accepted_blocked from a historical terminal-file entry after plain acceptance', async () => {
    const result = await workflow({ allowed: true, advisoryOnly: true, terminal: true });
    const state = result.final;
    state.status = 'running';
    state.terminalStates = { accepted_blocked: { paths: ['docs/value.txt'] } };
    const evaluated = await tryTerminateOnTerminalState(state, { projectDir: result.project, runId: state.runId,
      runDirPath: result.directory, iteration: 1, stages: [] });
    expect(evaluated.decision).toBe('not_matched');
    expect(state.status).toBe('running');
    expect(readRunState(result.project, state.runId).status).toBe('complete');
  });
  it('advertises phase metadata without a second free-form outcome in the gate prompt', async () => {
    const result = await workflow({ advisoryOnly: true });
    const prompt = result.prompts[1];
    const fields = /Phase metadata: ([^.]+)\./.exec(prompt)?.[1];
    expect(fields).toBeDefined();
    expect(fields?.split(', ')).not.toContain('outcome');
    expect(prompt).toContain('Own one outcome: accepted, accepted_blocked, rejected_repairable, or rejected_irreparable.');
  });
  it.each([false, true])('keeps final declared nonzero validation from success (blocked=%s)', async blocked => {
    const result = await workflow({ validation: true, blocked, allowed: blocked });
    expect(['complete', 'accepted_blocked']).not.toContain(result.final.status);
    expect(result.final.validation?.map(command => command.exitCode)).toEqual([7]);
  });
  it('ends an irreparable rejection before repair', async () => {
    const result = await workflow({ irreparable: true });
    expect(result.final.status).toBe('escalated'); expect(result.final.reasonCode).toBe('irreparable_gate_rejection');
    expect(result.calls).toEqual(['author', 'review']);
  });
  it.each(['empty', 'criterion', 'unknown'] as const)('refuses inconsistent rejecting findings (%s)', async invalid => {
    const result = await workflow({ invalid, loop: true });
    expect(['complete', 'accepted_blocked']).not.toContain(result.final.status);
    expect(result.calls[0]).toBe('author');
    expect(result.calls.slice(1).every(stage => stage === 'review')).toBe(true);
    expect(result.final.stages.review.error).toMatch(invalid === 'empty' ? /PASS_CLASS_MISMATCH/ : invalid === 'criterion' ? /CRITERION_NOT_FAILED/ : /criterion_ids.*not in enum/);
  });
  it('names no successor when a repairable gate has no admitted repair, without claiming exhaustion', async () => {
    const project = mkdtempSync(join(tmpdir(), 'no-successor-')); roots.push(project);
    const run = createRun(project, 'no-successor', 'name: no-successor\nstages: []\n', ['review']);
    const stage = parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true });
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0,
      gate: { outcome: 'rejected_repairable', pass: false, reason: 'Independent defect.', kind: 'repairable', verdictSha256: null } });
    const state = readRunState(project, run.runId); state.maxIterations = 1; state.currentIteration = 1; state.status = 'running';
    const settled = settleDecisions([stage], state, project, run.runId, run.runDirPath);
    const result = await concludeWorkflowIteration(settled, [stage], 1, [], 0, 3, 1, project, run.runId, run.runDirPath,
      { async run() { throw Error('No successor may execute.'); } }, new Set());
    expect(result.state.status).toBe('incomplete'); expect(result.state.reasonCode).toBe('no_successor');
    expect(result.state.failureReason).toContain('No successor: no admitted repair for review');
    expect(result.state.failureReason).not.toContain('exhaust');
    expect(result.state.decisionGraph?.records.at(-1)?.bound).toBeUndefined();
  });
  it('stops a rejecting loop at its visible named visit bound', async () => {
    const result = await workflow({ loop: true });
    const refused = result.final.decisionGraph?.records.at(-1);
    expect(refused).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Bound resourcePolicy.visits reached') });
    expect(result.final.resourcePolicy?.visits).toBe(result.final.decisionGraph?.maxVisits);
    expect(result.final.reasonCode).toBe('bounded_attempts');
  });
  it('injects the verdict policy once without an invocation command endpoint', async () => {
    const result = await workflow();
    const prompt = buildStagePrompt({ projectDir: result.project, runDir: result.directory, runId: result.final.runId,
      dependsOn: [], promptTemplate: 'Independent reviewer', isGate: true, stageId: 'review' });
    expect(prompt.split(FINDING_POLICY_TEXT)).toHaveLength(2);
    for (const invocation of result.prompts) expect(invocation).not.toContain('## Engine-recorded command');
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
