import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlanRevision, planDigest, recordAdmittedPlan, type PlanRevisionRequest } from '../src/plan-revisions.js';
import { parseDispatchedStageConfig, StageConfigSchema } from '../src/scheduler.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';

let root: string, previousStore: string, project: string, runId: string, directory: string, request: PlanRevisionRequest;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-revision-durability-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  const stage = (id: string) => StageConfigSchema.parse({ id, role: 'coder', scope: ['docs/**'], depends_on: [], dependency_reasons: {}, prompt_template: 'Execute declared work.', artifact_contract: { version: 1, produces: [], reads: [] , replays: [] } });
  const stages = [stage('writer')];
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['writer']).runId;
  directory = runDir(project, runId);
  const startedAt = new Date().toISOString();
  const status = { status: 'complete' as const, retries: 0, attempts: [{ index: 1, startedAt, completedAt: startedAt, status: 'complete' as const, exitCode: 0 }] };
  writeStageStatus(project, runId, 'writer', status);
  updateRunState(project, runId, (state) => { state.stages.writer = status; recordAdmittedPlan(state, stages, directory, 'Admitted fixture', true); });
  request = { version: 1, requestId: 'recover_projection', runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, baseRevision: 0, baseDigest: planDigest(stages), reason: 'Settled result requires more work.', stages: [...stages, stage('extra')] };
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true });
});

function revise(value: PlanRevisionRequest = request) {
  return applyPlanRevision({ projectDir: project, runId, request: value, parseStage: parseDispatchedStageConfig, admit: () => ({ pass: true, errors: [] }), scopeContained: (scope, capabilities) => capabilities.includes(scope) });
}
function decisionPath() { return join(directory, 'stages/writer/plan_revision_decision_recover_projection.json'); }

describe('revision decisions survive interruption and concurrent publication', () => {
  it('reconstructs an accepted decision lost after the plan commit without admitting twice', () => {
    const first = revise(); expect(first.decision.accepted).toBe(true);
    const committed = readRunState(project, runId);
    rmSync(decisionPath());
    const recovered = revise();
    expect(recovered.decision).toEqual(first.decision);
    expect(recovered.state.queryState?.planHistory).toEqual(committed.queryState?.planHistory);
    expect(recovered.state.planControl).toEqual(committed.planControl);
    expect(JSON.parse(readFileSync(decisionPath(), 'utf8'))).toEqual(first.decision);
    expect(readdirSync(join(directory, 'plan_history')).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('waits for an idle boundary without journaling a permanent refusal', () => {
    updateRunState(project, runId, (state) => { state.stages.writer.status = 'running'; });
    const first = revise(); expect(first.decision).toMatchObject({ accepted: false, pending: true });
    expect(first.decision.errors.join(';')).toContain('PLAN_REVISION_NOT_AT_BOUNDARY');
    expect(existsSync(decisionPath())).toBe(false);
    expect(readRunState(project, runId).planRevisionDecisions).toBeUndefined();
    updateRunState(project, runId, (state) => { state.stages.writer.status = 'complete'; });
    expect(revise().decision.accepted).toBe(true);
    expect(readRunState(project, runId).queryState?.planHistory).toHaveLength(2);
  });

  it('keeps a final binding refusal durable after settlement changes', () => {
    const invalid = { ...request, attemptIndex: 2 };
    const first = revise(invalid); expect(first.decision.accepted).toBe(false);
    expect(first.decision.pending).toBeUndefined();
    rmSync(decisionPath());
    expect(revise(invalid).decision).toEqual(first.decision);
    expect(readRunState(project, runId).queryState?.planHistory).toHaveLength(1);
  });

  it('binds a retained failed execution through a later technical retry', () => {
    const failed = { index: 1, startedAt: request.attemptStartedAt, completedAt: new Date().toISOString(), status: 'failed' as const, exitCode: 1 };
    const running = { index: 2, startedAt: new Date().toISOString(), status: 'running' as const };
    writeStageStatus(project, runId, 'writer', { status: 'running', retries: 1, attempts: [failed, running] });
    expect(revise().decision.pending).toBe(true);
    expect(existsSync(decisionPath())).toBe(false);
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 1, attempts: [failed, { ...running, status: 'complete', completedAt: new Date().toISOString(), exitCode: 0 }] });
    expect(revise().decision.accepted).toBe(true);
    expect(readRunState(project, runId).stages.writer.attempts).toHaveLength(2);
  });

  it('refuses conflicting bytes and a corrupt decision projection rather than changing the journal', () => {
    const first = revise(); rmSync(decisionPath());
    expect(() => revise({ ...request, reason: 'Different request under the same ID' })).toThrow('PLAN_REVISION_REQUEST_CONFLICT');
    expect(readRunState(project, runId).planRevisionDecisions?.['writer:recover_projection']).toEqual(first.decision);
    writeFileSync(decisionPath(), '{"accepted":false}');
    expect(() => revise()).toThrow('PLAN_HISTORY_CONFLICT');
    expect(readRunState(project, runId).queryState?.planHistory).toHaveLength(2);
  });

  it('refuses an accepted projection without journal authority even when it names an existing history digest', () => {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])) : value;
    mkdirSync(join(directory,'stages/writer'),{recursive:true});
    writeFileSync(decisionPath(),JSON.stringify({version:1,requestId:request.requestId,accepted:true,at:new Date().toISOString(),baseRevision:0,
      requestDigest:createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex'),errors:[],revision:0,digest:request.baseDigest}));
    let called=false;
    expect(()=>applyPlanRevision({projectDir:project,runId,request,parseStage:parseDispatchedStageConfig,admit:()=>{called=true;return {pass:false,errors:['Must refuse']}},scopeContained:()=>false})).toThrow('PLAN_REVISION_DECISION_UNJOURNALED');
    expect(called).toBe(false);expect(readRunState(project,runId).queryState?.planHistory).toHaveLength(1);
    expect(readRunState(project,runId).planRevisionDecisions).toBeUndefined();
  });

  it('serializes two engine processes replaying the same missing decision projection', async () => {
    const first = revise(); rmSync(decisionPath());
    const file = join(root, 'request.json'); writeFileSync(file, JSON.stringify(request));
    const source = `
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const [dist, project, storeRoot, file] = process.argv.slice(1);
      const store = await import(pathToFileURL(dist + '/store.js'));
      const revisions = await import(pathToFileURL(dist + '/plan-revisions.js'));
      const scheduler = await import(pathToFileURL(dist + '/scheduler.js'));
      store.setFcGlobalDir(storeRoot);
      const request = JSON.parse(readFileSync(file, 'utf8'));
      const result = revisions.applyPlanRevision({projectDir:project,runId:request.runId,request,parseStage:scheduler.parseDispatchedStageConfig,admit:()=>({pass:true,errors:[]}),scopeContained:(scope,capabilities)=>capabilities.includes(scope)});
      process.stdout.write(JSON.stringify(result.decision));
    `;
    const call = () => new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, resolve('dist'), project, fcGlobalDir(), file], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') }, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); let output = '', errors = '';
      child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
      child.on('error', fail); child.on('close', (code) => { if (code === 0) done(output); else fail(new Error(`Private revision child exit ${code}: ${errors}`)); });
    });
    const results = await Promise.all([call(), call()]);
    expect(results.map((value) => JSON.parse(value))).toEqual([first.decision, first.decision]);
    expect(JSON.parse(readFileSync(decisionPath(), 'utf8'))).toEqual(first.decision);
    expect(readRunState(project, runId).queryState?.planHistory).toHaveLength(2);
  });
});
