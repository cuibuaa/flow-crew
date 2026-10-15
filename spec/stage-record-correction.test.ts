import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { ArtifactPathSchema, resolveArtifactLocation } from '../src/artifact-location.js';
import { HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { AuditFindingsSchema } from '../src/scoped-audit-repair.js';
import { clearAttemptSummaryRefreshDebounce, readRunEvents } from '../src/run-events.js';
import { createRun, fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { readGateVerdict } from '../src/scheduler/sched_settlement/gate-verdict.js';

let root: string, projectDir: string, runDir: string, runId: string, previousStore: string;
const role = { name: 'reviewer', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Review independently.' };
const sessionId = '11111111-1111-4111-8111-111111111111';
const finding = () => ({ id: 'report', paths: ['docs/report.md'], reason: 'The report needs repair.', criterion_ids: ['criterion'], invalidates_plan: false, repair_role: 'coder' });
const rejected = () => ({ pass: false, reason: 'Reproduced a report defect.', criteria: { criterion: { status: 'fail', evidence: 'Inspected docs/report.md.' } }, audit_findings: { version: 1, findings: [finding()] }, repairability: { version: 1, disposition: 'repairable', evidence: 'Correct the report.' } });
const passed = () => ({ pass: true, reason: 'The report meets the brief.', criteria: { criterion: { status: 'pass', evidence: 'Inspected docs/report.md.' } }, audit_findings: { version: 1, findings: [] } });
const schema = () => stageRecordSchema({ isGate: true, criterionRefs: ['criterion'] });
const options = () => ({ stageId: 'review', role, dependsOn: [], promptTemplate: 'Review the report.', projectDir, runId, runDir,
  retries: 0, timeout_ms: 10000, projectWriteScope: [], isGate: true, criterionRefs: ['criterion'], outputSchema: schema(),
  artifactContract: { version: 1 as const, produces: [{ id: 'verdict', root: 'run' as const, path: 'verdict_review.json', kind: 'file' as const }], reads: [], groups: [], replays: [] } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-record-spec-'));
  projectDir = join(root, 'project'); mkdirSync(projectDir);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  ({ runId, runDirPath: runDir } = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['review']));
  writeFileSync(join(runDir, 'dispatch_admission.json'), JSON.stringify({ criterionGateRefs: { review: ['criterion'] } }));
});
afterEach(() => { clearAttemptSummaryRefreshDebounce(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

describe('stage record constraints before settlement', () => {
  it.each(['/outside', ['..', 'outside'].join('/'), 'docs/../outside', 'docs//report.md', './report.md', 'docs/', 'docs\\report.md', 'docs/\0report.md', ''])('rejects the unsafe artifact path %j at declaration and use', path => {
    expect(ArtifactPathSchema.safeParse(path).success).toBe(false);
    expect(() => resolveArtifactLocation({ root: 'project', path }, projectDir, runDir)).toThrow();
  });

  it.each(['docs/report.md', '.config/report.json', 'docs/..report', 'docs/report name.md'])('accepts the confined literal path %j', path => {
    const record = rejected(); record.audit_findings.findings[0].paths = [path];
    expect(() => parseStageRecord(JSON.stringify(record), schema())).not.toThrow();
    expect(ArtifactPathSchema.safeParse(path).success).toBe(true);
  });

  it('keeps physical confinement when an exact path is used', () => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(projectDir, 'linked'));
    expect(() => resolveArtifactLocation({ root: 'project', path: 'linked/report.md' }, projectDir, runDir)).toThrow('ARTIFACT_PATH_ESCAPE');
  });

  it('refuses empty finding paths in the supplied schema and at consumption', () => {
    const record = rejected(); record.audit_findings.findings[0].paths = [];
    expect(() => parseStageRecord(JSON.stringify(record), schema())).toThrow();
    expect(AuditFindingsSchema.safeParse(record.audit_findings).success).toBe(false);
  });

  it('expresses passing criteria and no open findings in the supplied schema', () => {
    const failedCriterion = passed(); failedCriterion.criteria.criterion.status = 'fail';
    expect(() => parseStageRecord(JSON.stringify(failedCriterion), schema())).toThrow();
    const openFinding = { ...passed(), audit_findings: { version: 1, findings: [finding()] } };
    expect(() => parseStageRecord(JSON.stringify(openFinding), schema())).toThrow();
  });

  it('retains the nonblank path rule and reports the rejected field through gate variants', () => {
    const record = rejected(); record.audit_findings.findings[0].paths = ['   '];
    expect(() => parseStageRecord(JSON.stringify(record), schema())).toThrow('$.audit_findings.findings[0].paths[0]');
  });
});

describe('informational citations preserve independent refusals', () => {
  it.each(['validation receipt', 'external determinism evidence', 'external performance evidence'])('accepts a negative review citing %s without a second invocation', async evidence => {
    // Scrubbed audit incidents: a run receipt, admitted external smoke results,
    // and external benchmark results showing 0.923x against a required 4x.
    const path = evidence === 'validation receipt' ? join(runDir, 'validation_delta_review.json')
      : join(root, 'external-evidence', evidence === 'external determinism evidence' ? 'smoke_determinism.json' : 'hybrid_stats.json');
    const record = rejected();
    record.reason = evidence === 'external performance evidence' ? 'Measured speed ratio is 0.923x; the brief requires 4x.'
      : 'Required GPU and same-device parity evidence are missing.';
    record.audit_findings.findings[0].paths = [path];
    record.audit_findings.findings[0].reason = record.reason;
    let calls = 0;
    const adapter: Adapter = { async run() {
      calls++;
      return { output: JSON.stringify(record), exitCode: 0, duration_ms: 1 };
    } };
    const result = await runStage(adapter, options());
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(calls).toBe(1);
    expect(AuditFindingsSchema.parse(record.audit_findings)).toEqual(record.audit_findings);
    expect(JSON.parse(readFileSync(join(runDir, 'verdict_review.json'), 'utf8'))).toEqual(record);
    // Accepting the citation must preserve the real unmet-outcome rejection.
    expect(readGateVerdict(projectDir, 'review', runId)).toMatchObject({ pass: false, reason: record.reason });
    expect(readRunEvents(projectDir, runId).filter(event => event.type === 'attempt_failed')).toHaveLength(0);
    // The same string remains unusable as a writable artifact capability.
    expect(ArtifactPathSchema.safeParse(path).success).toBe(false);
    expect(() => resolveArtifactLocation({ root: 'run', path }, projectDir, runDir)).toThrow();
  });
});

describe('record correction uses the existing attempt', () => {
  const malformed: Array<[string, () => string]> = [
    ['blank citation', () => { const record = rejected(); record.audit_findings.findings[0].paths.push('   '); return JSON.stringify(record); }],
    ['empty paths', () => { const record = rejected(); record.audit_findings.findings[0].paths = []; return JSON.stringify(record); }],
    ['blank evidence', () => { const record = rejected(); record.criteria.criterion.evidence = '   '; return JSON.stringify(record); }],
    ['missing criterion', () => JSON.stringify({ ...rejected(), criteria: {} })],
    ['invalid repairability', () => JSON.stringify({ ...rejected(), repairability: { version: 2 } })],
    ['passing failed criterion', () => JSON.stringify({ ...passed(), criteria: rejected().criteria })],
    ['passing open findings', () => JSON.stringify({ ...passed(), audit_findings: rejected().audit_findings })],
    ['unknown field', () => JSON.stringify({ ...rejected(), unexpected: true })],
    ['malformed JSON', () => '{"pass":'],
  ];

  it.each(malformed)('corrects %s without rerunning or losing the review', async (_name, output) => {
    const original = output(), invocations: RunOpts[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      invocations.push(opts);
      expect(existsSync(join(runDir, 'verdict_review.json'))).toBe(false);
      if (invocations.length === 2) {
        expect(prompt).toContain('Stage result correction');
        expect(prompt).toContain(original);
        expect(prompt).toContain('Do not repeat the completed work');
        expect(opts.resumeSessionId).toBe(sessionId);
      }
      return { output: invocations.length === 1 ? original : JSON.stringify(rejected()), exitCode: 0, duration_ms: 1, sessionId, tokens_in: 10, tokens_out: 20, writes: ['docs/report.md'], writeAttribution: 'structured' };
    } };
    const result = await runStage(adapter, options());
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(invocations).toHaveLength(2);
    expect(result).toMatchObject({ tokens_in: 20, tokens_out: 40, writes: ['docs/report.md'] });
    expect(JSON.parse(readFileSync(join(runDir, 'verdict_review.json'), 'utf8'))).toEqual(rejected());
    const status = readStageStatus(projectDir, runId, 'review');
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts?.[0]).toMatchObject({ exitCode: 0, disposition: 'repaired' });
    expect(readRunEvents(projectDir, runId).filter(event => event.type === 'attempt_failed')).toHaveLength(0);
  });

  it.each([false, true])('corrects author and planner reports through the same boundary (planner=%s)', async dynamicDispatch => {
    let calls = 0;
    const record = { status: 'delivered', summary: 'Delivered.', files_modified: [], checks: [], caveats: [] };
    const dispatch = JSON.stringify({ stages: [{ id: 'work', role: 'coder' }] });
    const adapter: Adapter = { async run() {
      if (dynamicDispatch && calls === 0) writeFileSync(join(runDir, 'dispatch.yaml'), dispatch);
      return { output: JSON.stringify(++calls === 1 ? {} : record), exitCode: 0, duration_ms: 1 };
    } };
    const result = await runStage(adapter, { ...options(), isGate: false, dynamicDispatch, outputSchema: HANDOFF_SCHEMA,
      artifactContract: { version: 1, produces: dynamicDispatch ? [{ id: 'dispatch', root: 'run', path: 'dispatch.yaml', kind: 'file', nonempty: true }] : [], reads: [], groups: [], replays: [] } });
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(calls).toBe(2);
    if (dynamicDispatch) expect(readFileSync(join(runDir, 'dispatch.yaml'), 'utf8')).toBe(dispatch);
  });

  it('bounds correction and never publishes a persistently invalid answer', async () => {
    let calls = 0;
    const adapter: Adapter = { async run() { calls++; return { output: malformed[0][1](), exitCode: 0, duration_ms: 1 }; } };
    const result = await runStage(adapter, options());
    expect(result.exitCode).toBe(1); expect(calls).toBe(2);
    expect(result.friendlyError).toContain('Stage record refused');
    expect(existsSync(join(runDir, 'verdict_review.json'))).toBe(false);
    expect(readStageStatus(projectDir, runId, 'review').attempts).toHaveLength(1);
  });

  it('does not correct a business blocker or a failed invocation', async () => {
    for (const exitCode of [0, 1]) {
      let calls = 0;
      const adapter: Adapter = { async run() { calls++; return { output: JSON.stringify({ status: 'blocked', summary: 'Required input absent.', files_modified: [], checks: [], caveats: [] }), exitCode, duration_ms: 1 }; } };
      const result = await runStage(adapter, { ...options(), isGate: false, outputSchema: HANDOFF_SCHEMA,
        artifactContract: { version: 1, produces: [], reads: [], groups: [], replays: [] } });
      expect(result.exitCode).toBe(1); expect(calls).toBe(1);
    }
  });

  it.each([1, 2])('honors the original deadline when invocation %i exhausts it', async expirationInvocation => {
    let elapsed = 0, calls = 0;
    const started = Date.now(), invocations: RunOpts[] = [];
    const clock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
      setTimer: (callback: () => void, delay: number) => setTimeout(callback, delay), clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) };
    const adapter: Adapter = { async run(prompt, _role, opts) {
      invocations.push(opts); calls++;
      if (calls === 2) {
        expect(opts.attemptIndex).toBe(invocations[0]?.attemptIndex);
        expect(opts.attemptStartedAt).toBe(invocations[0]?.attemptStartedAt);
        expect(prompt).toContain('remaining 9000 ms');
      }
      elapsed = calls === expirationInvocation ? 10001 : 1000;
      return { output: calls === 1 ? malformed[0][1]() : JSON.stringify(rejected()), exitCode: 0, duration_ms: 1 };
    } };
    const result = await runStage(adapter, { ...options(), deadlineClock: clock });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true }); expect(calls).toBe(expirationInvocation);
    expect(existsSync(join(runDir, 'verdict_review.json'))).toBe(false);
    expect(readStageStatus(projectDir, runId, 'review').attempts).toHaveLength(1);
  });
});
