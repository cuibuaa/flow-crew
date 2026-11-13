import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { createRun } from './test-support/create-run.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, listRuns, readRunState, readStageStatus, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';
import { stateToRunDetail } from '../src/dashboard.js';
import { readRunStateView } from '../src/run-state-view.js';
import { pendingScopePlanningInputs } from '../src/scheduler/sched_scope/scope-planning.js';
import { runRecordPath } from '../src/run-layout.js';

let root: string, project: string, previous: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'legacy-write-records-')); project = join(root, 'project'); mkdirSync(project); previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
it('reads historical scope/rollback/conflict evidence through status, listing, UI and resume without granting from it', async () => {
  const workflow = WorkflowConfigSchema.parse({ name: 'legacy-evidence', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{ id: 'author', role: 'coder', scope: ['src/'], artifact_contract: { version: 1, produces: [], reads: [] } }] });
  const created = createRun(project, workflow.name, stringify(workflow), ['author']);
  const auditPath = 'stages/author/constraint_audit_attempt_1.json';
  const audit = { version: 1, declaredScope: ['src/'], effectiveScope: [], appliedWrites: [], rolledBackWrites: ['docs/report.md'], rollbackFailures: [],
    retainedReplacements: { 'docs/report.md': 'historical-retained' }, declaredScopeMatch: false, violations: [] };
  const auditFile = runRecordPath(created.runDirPath, auditPath);
  writeFileSync(auditFile, JSON.stringify(audit));
  writeStageStatus(project, created.runId, 'author', { status: 'pending', retries: 0, attempts: [{ index: 1, status: 'failed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', exitCode: 1,
    writes: ['docs/report.md'], writeAttribution: 'snapshot', constraintAudit: { path: auditPath, declaredScope: ['src/'], effectiveScope: [], violationCount: 0, unverifiedCount: 0 } }] });
  const input = { version: 1, kind: 'scope_negotiation_planning_input', digest: 'historical', runId: created.runId, sourceIteration: 1, stageId: 'author', stageKind: 'ordinary', requestedPaths: ['docs/'], pathDigest: 'old', rejectionReason: 'Archived refusal', auditPath };
  writeFileSync(runRecordPath(created.runDirPath, 'scope_negotiation_input_historical.json'), JSON.stringify(input));
  writeFileSync(runRecordPath(created.runDirPath, 'scope_revision_request_historical.json'), JSON.stringify({ requestId: 'historical', paths: ['docs/'] }));
  writeFileSync(runRecordPath(created.runDirPath, 'scope_revision_decision_historical.json'), JSON.stringify({ accepted: false, leftScope: 'src/', rightScope: 'docs/' }));
  expect(listRuns(project)).toContain(created.runId);
  expect(readRunStateView(project, created.runId).stages.author.attempts?.[0].constraintAudit?.declaredScope).toEqual(['src/']);
  const detail = stateToRunDetail(readRunState(project, created.runId), project);
  expect(detail.stages.find(stage => stage.id === 'author')?.attempts[0].constraintAudit?.effectiveScope).toEqual([]);
  expect(detail.operational.pendingScope).toEqual([]);
  expect(pendingScopePlanningInputs(created.runDirPath)).toEqual([input]);
  const status = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(import.meta.dirname, '../src/cli.ts'), 'status', '--project', project], {
    cwd: project, encoding: 'utf8', env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'private.sock') },
  });
  expect(status).toContain(`Run: ${created.runId}`);
  expect(status).not.toContain('Pending scope:');
  const roles = join(root, 'agents'); mkdirSync(roles);
  const role = { name: 'coder', description: 'Compatibility fixture', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'Complete the work.' };
  writeFileSync(join(roles, 'coder.yaml'), stringify(role));
  updateRunState(project, created.runId, state => { state.status = 'failed'; state.currentIteration = 1; state.maxIterations = 2; state.failureReason = 'Historical controller finished.'; state.completedAt = new Date().toISOString(); });
  const state = await runWorkflow(workflow, stringify(workflow), project, { async run(_prompt, _role, opts) {
    mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'current author output');
    return fixtureResult({ output: 'Delivered.', exitCode: 0, duration_ms: 1 }, opts);
  } }, new Map([['coder', role]]), undefined, roles, created.runId);
  expect(state.status, state.failureReason).toBe('complete');
  expect(readStageStatus(project, created.runId, 'author').attempts?.[0].constraintAudit?.declaredScope).toEqual(['src/']);
  expect(readFileSync(auditFile, 'utf8')).toBe(JSON.stringify(audit));
  const current = readStageStatus(project, created.runId, 'author').attempts!.at(-1)!;
  expect(current.constraintAudit).not.toHaveProperty('declaredScope');
  expect(readFileSync(join(project, 'docs/report.md'), 'utf8')).toBe('current author output');
});
