import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import type { Adapter } from '../src/adapters/base.js';
import { validateFindingVerdict } from '../src/scoped-audit-repair.js';
import { parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { loadWorkflow } from '../src/scheduler.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { stageFixtureCommand } from './test-support/stage-command.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { runRecordPath } from '../src/run-layout.js';
import { appendEvidence, captureProjectTree, readEvidence } from '../src/evidence-ledger.js';
import { renderRunSummary } from '../src/run-summary.js';
import { runDir, readRunState, readStageStatus, writeStageStatus } from '../src/store.js';

import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { settleGateEvaluation, readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { buildGateFixCorrectionContract } from '../src/scheduler/sched_settlement/gate-archives.js';

let project: string, fixtureRoot: string;
beforeEach(() => { fixtureRoot = mkdtempSync(join(tmpdir(), 'review-boundary-')); project = join(fixtureRoot, 'project'); mkdirSync(project); });
afterEach(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

const finding = (kind: 'criterion_unmet' | 'regression' | 'advisory') => ({
  id: kind, class: kind, paths: ['value.txt'], reason: kind === 'advisory' ? 'Optional metadata hardening.' : 'The value must remain good.',
  criterion_ids: kind === 'criterion_unmet' ? ['value'] : [], invalidates_plan: false, repair_role: 'coder',
});
const verdict = (pass: boolean, findings: unknown[]) => ({ outcome: pass ? 'accepted' : 'rejected_repairable', reason: 'Independent review completed.',
  criteria: { value: { status: 'pass', evidence: 'Inspected value.txt.' } }, audit_findings: { version: 1, findings },
});
const schema = () => stageRecordSchema({ isGate: true, criterionRefs: ['value'] });
describe('finding classes bound independent review', () => {
  it.each(['fail', 'not_assessed'] as const)('refuses pass=true with assigned criterion %s at correction and settlement', status => {
    const run = createRun(project, 'criterion-acceptance', 'name: criterion-acceptance\nstages: []\n', ['review'],
      '---\ncriteria: [{id: value, text: Deliver the good value.}]\n---\n');
    const record = { ...verdict(true, []), criteria: { value: { status, evidence: 'Required value is unavailable.',
      ...(status === 'not_assessed' ? { reason: 'evidence_unavailable' } : {}) } } };
    expect(validateFindingVerdict(record, ['value'])).toContain('CRITERION_NOT_ACCEPTED');
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify(record));
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0 });
    settleGateEvaluation(project, run.runId, 'review');
    expect(readGateEvaluation(project, 'review', run.runId)).toMatchObject({ pass: false,
      refusal: { kind: 'audit_findings' }, reason: expect.stringContaining('CRITERION_NOT_ACCEPTED') });
  });

  it('keeps criterion rejection even on a legacy verdict without finding metadata', () => {
    const run = createRun(project, 'legacy-criterion', 'name: legacy-criterion\nstages: []\n', ['review'],
      '---\ncriteria: [{id: value, text: Deliver the good value.}]\n---\n');
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true,
      criteria: { value: { status: 'fail', evidence: 'Required value is absent.' } } }));
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0 });
    settleGateEvaluation(project, run.runId, 'review');
    expect(readGateEvaluation(project, 'review', run.runId)).toMatchObject({ pass: false,
      refusal: { kind: 'audit_findings' }, reason: expect.stringContaining('CRITERION_NOT_ACCEPTED') });
  });

  it('accepts advisory findings on a passing verdict', () => {
    const record = verdict(true, [finding('advisory')]);
    expect(parseStageRecord(JSON.stringify(record), schema())).toEqual(record);
    expect(validateFindingVerdict(record, ['value'])).toBeUndefined();
  });

  it.each([
    ['pass with criterion rejection', () => verdict(true, [finding('criterion_unmet')])],
    ['pass with regression rejection', () => verdict(true, [finding('regression')])],
    ['reject with only advisory', () => verdict(false, [finding('advisory')])],
    ['reject with no finding', () => verdict(false, [])],
    ['unknown class', () => verdict(false, [{ ...finding('regression'), class: 'hardening' }])],
    ['missing class', () => { const { class: _class, ...old } = finding('regression'); return verdict(false, [old]); }],
    ['unknown criterion ID', () => verdict(false, [{ ...finding('criterion_unmet'), criterion_ids: ['invented'] }])],
    ['criterion rejection without criterion ID', () => verdict(false, [{ ...finding('criterion_unmet'), criterion_ids: [] }])],
    ['unknown ID on regression', () => verdict(false, [{ ...finding('regression'), criterion_ids: ['invented'] }])],
    ['unknown ID on advisory', () => verdict(true, [{ ...finding('advisory'), criterion_ids: ['invented'] }])],
  ] as const)('refuses %s as an invalid live verdict', (name, record) => {
    const run = createRun(project, 'invalid', 'name: invalid\nstages: []\n', ['review'],
      '---\ncriteria: [{id: value, text: Deliver the good value.}]\n---\n');
    const invalid = record();
    delete (invalid as Record<string, unknown>).repairability;
    writeFileSync(runRecordPath(run.runDirPath, 'verdict_review.json'), JSON.stringify(invalid));
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0 });
    settleGateEvaluation(project, run.runId, 'review');
    expect(readRunState(project, run.runId).stages.review.gate).toMatchObject({ pass: false,
      refusal: { kind: 'audit_findings' }, reason: expect.stringContaining(`AUDIT_FINDINGS_INVALID: ${name.startsWith('pass with') || name.startsWith('reject with') ? 'PASS_CLASS_MISMATCH' : 'FINDING_SHAPE_INVALID'}`) });
  });

  it.each(['advisory', 'criterion_unmet', 'regression'] as const)('settles %s findings without changing their repair authority', async kind => {
    for (const args of [['init', '-q', '--separate-git-dir', join(fixtureRoot, 'git')], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base']]) {
      isolatedProjectCommand('git', args, project, project);
    }
    writeFileSync(join(project, 'value.txt'), 'good\n');
    isolatedProjectCommand('git', ['add', 'value.txt'], project, project);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base value'], project, project);
    const calls: Array<{ stage: string; prompt: string }> = [];
    let reviews = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push({ stage: opts.stageId, prompt });
      if (opts.stageId !== 'review') {
        writeFileSync(join(project, 'value.txt'), opts.stageId === 'repair_review' || kind === 'advisory' ? 'good\n' : 'bad\n');
        return { output: JSON.stringify({ status: 'delivered', summary: 'Value delivered.', caveats: [], remaining_work: [] }),
          exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
      }
      const first = ++reviews === 1;
      const pass = kind === 'advisory' || !first;
      const findings = first ? [{ ...finding(kind) }, ...(kind === 'advisory' ? [] : [{ ...finding('advisory') }])] : [];
      const record = verdict(pass, findings);
      record.criteria.value.status = kind === 'criterion_unmet' && first ? 'fail' : 'pass';
      return { output: JSON.stringify(record), exitCode: 0, duration_ms: 1 };
    } };
    const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
    const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined,
      '---\ncriteria: [{id: value, text: Deliver the good value.}]\noutputs: [value.txt]\n---\nDeliver the good value.', true);
    expect(final.status, final.failureReason).toBe('complete');
    const directory = runDir(project, final.runId);
    const summary = renderRunSummary(project, directory, final);
    if (kind === 'advisory') {
      expect(calls.map(call => call.stage)).toEqual(['implement', 'review']);
      expect(final.stages.review.gate).toMatchObject({ outcome: 'accepted', pass: true });
      expect(readFileSync(runRecordPath(directory, 'verdict_review.json'), 'utf8')).toContain('Optional metadata hardening.');
      expect(summary.toLowerCase()).toContain('advisory');
      expect(summary).toContain('Optional metadata hardening.');
    } else {
      expect(calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair_review', 'review']);
      const repair = calls.find(call => call.stage === 'repair_review')!.prompt;
      const facts = JSON.parse(repair.split('# Gate repair facts\n')[1].split('\n')[0]);
      expect(facts.rejections.flatMap((rejection: { audit_findings: { findings: Array<{ class: string }> } }) => rejection.audit_findings.findings.map(item => item.class))).toEqual([kind]);
      expect(readEvidence(directory).filter(entry => entry.kind === 'command')).toEqual([]);
      expect(readFileSync(runRecordPath(directory, 'gate_reevaluation/iteration_1/round_1/rejected_verdict_review.json'), 'utf8')).toContain('Optional metadata hardening.');
      expect(summary).toContain('Optional metadata hardening.');
    }
  });

  it.each(['pass', 'carried', 'not_assessed', undefined])('requires criterion status fail, not %s', status => {
    const record = verdict(false, [finding('criterion_unmet')]);
    Object.assign(record.criteria, { value: status ? { status, evidence: 'Observed.' } : undefined });
    expect(validateFindingVerdict(record, ['value'])).toContain('AUDIT_FINDINGS_INVALID: CRITERION_NOT_FAILED');
  });

  it('keeps regression and advisory usable with no criteria; unmet outcomes need a brief criterion', () => {
    const empty = stageRecordSchema({ isGate: true, criterionRefs: [] });
    const advisory = { ...verdict(true, [finding('advisory')]), criteria: {} };
    expect(parseStageRecord(JSON.stringify(advisory), empty)).toEqual(advisory);
    expect(validateFindingVerdict(advisory, [])).toBeUndefined();
    const regression = { ...verdict(false, [finding('regression')]), criteria: {} };
    expect(parseStageRecord(JSON.stringify(regression), empty)).toEqual(regression);
    expect(validateFindingVerdict(regression, [])).toBeUndefined();
    const criterion = { ...verdict(false, [finding('criterion_unmet')]), criteria: {} };
    expect(validateFindingVerdict(criterion, [])).toMatch(/^AUDIT_FINDINGS_INVALID: FINDING_SHAPE_INVALID:/);
    expect(() => parseStageRecord(JSON.stringify(criterion), empty)).toThrow('STAGE_RECORD_INVALID:');
  });

  it('uses all canonical brief criteria even with no assigned criterion IDs', () => {
    const run = createRun(project, 'unassigned', 'name: unassigned\nstages: []\n', ['review'],
      '---\ncriteria: [{id: value, text: Deliver the good value.}]\n---\n');
    const record = verdict(false, [finding('criterion_unmet')]);
    record.criteria.value.status = 'fail';
    expect(parseStageRecord(JSON.stringify(record), stageRecordSchema({ isGate: true, criterionRefs: [], runDir: run.runDirPath }))).toEqual(record);
  });

  it.each(['qa', 'doc_reviewer', 'paper_reviewer', 'ai_detector'])('gives %s one injected policy and the shared typed gate contract', async name => {
    const role = parseAgent(parseYaml(readFileSync(resolve('config/agents', `${name}.yaml`), 'utf8')));
    const run = createRun(project, 'role', 'name: role\nstages: []\n', ['review']);
    const record = { ...verdict(true, [finding('advisory')]), criteria: {} };
    const outputSchema = stageRecordSchema({ isGate: true, criterionRefs: [] });
    const result = await runStage({ async run(prompt, deliveredRole, opts) {
      const input = deliveredRole.prompt + prompt;
      expect(input.split('Choose each finding class:')).toHaveLength(2);
      expect(input).not.toContain('src/scoped-audit-repair.ts');
      expect(role.prompt).not.toMatch(/criterion_unmet|class:.*regression/);
      expect(opts.outputSchema).toEqual(outputSchema);
      return { output: JSON.stringify(record), exitCode: 0, duration_ms: 1 };
    } }, { stageId: 'review', role, dependsOn: [], promptTemplate: 'Review.', projectDir: project,
      runId: run.runId, runDir: run.runDirPath, retries: 0, isGate: true, outputSchema,
      artifactContract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'work/verdict_review.json' }], reads: [], groups: [] } });
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(readGateEvaluation(project, 'review', run.runId)?.pass).toBe(true);
  });

  it('shows archived advisories even when the stage output is unavailable', () => {
    const run = createRun(project, 'archived', 'name: archived\nstages: []\n', ['review']);
    const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'rejected_verdict_review.json'), JSON.stringify(verdict(false, [finding('regression'), finding('advisory')])));
    writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review',
      written_verdict_pass: false, engine_effective_pass: false, engine_rejection_reason: 'Historical rejection.' }));
    const summary = renderRunSummary(project, run.runDirPath, readRunState(project, run.runId));
    expect(summary).toContain('Advisory advisory: Optional metadata hardening.; no repair requested.');
  });

  it('loads classless historical rejections without inventing a new class or rewriting their bytes', () => {
    const run = createRun(project, 'legacy', 'name: legacy\nstages: []\n', ['review']);
    const { class: _class, ...oldFinding } = finding('regression');
    const { outcome: _outcome, ...answer } = verdict(false, [oldFinding]);
    const old = { ...answer, pass: false, criteria: {} };
    const path = runRecordPath(run.runDirPath, 'verdict_review.json');
    const bytes = JSON.stringify(old); writeFileSync(path, bytes);
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0,
      gate: { pass: false, reason: old.reason, kind: 'repairable', verdictSha256: null } });
    const read = readGateEvaluation(project, 'review', run.runId);
    expect(read?.pass).toBe(false);
    expect(read?.findings?.unconfirmed).toEqual([oldFinding]);
    expect(read?.findings?.unconfirmed[0]).not.toHaveProperty('class');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    const archive = runRecordPath(run.runDirPath, 'gate_reevaluation/iteration_1/round_1');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'rejected_verdict_review.json'), bytes);
    const historical = { ...oldFinding, record: { kind: 'command', sequence: 1, stageId: 'review',
      command: 'test legacy predicate', exitCode: 1 } };
    writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ engine_effective_pass: false,
      findings: { confirmed: [historical], unconfirmed: [] } }));
    expect(buildGateFixCorrectionContract(run.runDirPath, ['review'], { iteration: 1, round: 1 })).toContain(oldFinding.reason);
  });

  it('reads a classless completed verdict without a stored gate and grants no fresh confirmation', () => {
    const run = createRun(project, 'legacy', 'name: legacy\nstages: []\n', ['review']);
    const { class: _class, ...oldFinding } = finding('regression');
    const treeHash = captureProjectTree(project, '', run.runDirPath).hash;
    const record = appendEvidence(run.runDirPath, { kind: 'command', owner: 'code', stageId: 'review', attemptIndex: 1,
      commandId: 'old-probe', command: 'test legacy predicate', exitCode: 1, outputDigest: 'historical-output',
      context: { cwd: project, shell: '/bin/sh' }, treeHash, treeAfterHash: treeHash });
    const { outcome: _outcome, ...current } = verdict(false, [{ ...oldFinding, reproduction: record.sequence }]);
    const old = { ...current, pass: false };
    const bytes = JSON.stringify({ ...old, criteria: {} });
    const path = runRecordPath(run.runDirPath, 'verdict_review.json'); writeFileSync(path, bytes);
    writeStageStatus(project, run.runId, 'review', { status: 'complete', retries: 0, exitCode: 0,
      attempts: [{ index: 1, startedAt: 'start', completedAt: 'end', status: 'complete', exitCode: 0 }] });
    const read = readGateEvaluation(project, 'review', run.runId);
    expect(read?.pass).toBe(false);
    expect(read?.refusal).toBeUndefined();
    expect(read?.findings?.confirmed).toEqual([]);
    expect(read?.findings?.unconfirmed).toEqual([{ ...oldFinding, reproduction: record.sequence }]);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
});
