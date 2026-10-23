import { atomicWrite } from '../src/engine-fs.js';
import { providerFailureFromDiagnostic } from '../src/provider-result.js';
import { readStageLiveLogPath, stageLiveLogPath } from '../src/stage-live-log.js';
import { appendEngineFile } from '../src/engine-integrity.js';
import { fixtureResult, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { runStage } from '../src/worker.js';
import { createScopeSafeStageRunner } from '../src/scheduler/sched_scope/stage-group.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { createRun } from './test-support/create-run.js';
import { setFcGlobalDir, fcGlobalDir, readStageStatus, readRunState, writeRunState } from '../src/store.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { appendGuidanceEnvelope, parseGuidanceLedger } from '../src/guidance.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
// Exercise every same-attempt backoff slot without spending wall time on production delays.
vi.mock('../src/worker.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../src/worker.js')>();
    return { ...actual, runStage: (adapter: Adapter, opts: Parameters<typeof actual.runStage>[1]) =>
        actual.runStage(adapter, { ...opts, technicalRetry: { delaysMs: [0, 0, 0] } }) };
});
let root: string, project: string, prior: string;
const uuid = '11111111-1111-4111-8111-111111111111';
const role: AgentConfig = { name: 'coder', description: 'deterministic', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'current duties' };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fc-settlement-')); project = join(root, 'project'); mkdirSync(join(project, 'config', 'agents'), { recursive: true }); writeFileSync(join(project, 'config', 'agents', 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: test\nreasoning_effort: low\ntools: []\nprompt: fixture\n'); prior = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });
function ownSession(run: string, stage: string) { const home = join(run, 'stages', stage, 'codex_home'); mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'progress'), 'verified progress'); atomicWrite(join(run, 'stages', stage, 'session.json'), JSON.stringify({ version: 1, adapter: 'codex', sessionId: uuid, ownerStageId: stage, updatedAt: new Date().toISOString() })); return home; }
function workflow(): WorkflowConfig { return { name: 'settlement', description: '', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{ id: 'work', role: 'coder', depends_on: [], scope: [], skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [], prompt_template: 'write the declared product after scope admission', artifact_contract: fixtureArtifactContract('work') }] }; }
describe('scheduler attempt closure and own-stage retry progress', () => {
    it('recomputes own-stage continuation after a refused technical attempt in the grouped executor', async () => {
        const config = workflow(), created = createRun(project, config.name, 'name: settlement', ['work']);
        const state = readRunState(project, created.runId);
        state.status = 'running';
        writeRunState(project, created.runId, state);
        let calls = 0;
        let resume: string | undefined;
        let prompt = '';
        // Exhaust same-attempt transport retries immediately, then exercise scheduler retry lookup.
        const transport = { run: async (p: string, a: AgentConfig, o: import('../src/adapters/base.js').RunOpts) => { if ((o.attemptIndex ?? 1) === 1) {
                if (calls++ === 0) {
                    ownSession(o.runDir, 'work');
                    appendEngineFile(stageLiveLogPath(o.runDir, o.stageId, o.attemptIndex, o.attemptStartedAt), 'author finished verification; delivery remains\n');
                }
                return fixtureResult({ output: 'refused after progress', sessionId: uuid, exitCode: 1, duration_ms: 1, providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', code: 503, message: 'delivery interrupted' }) }, o);
            } resume = o.resumeSessionId; prompt = p; return fixtureResult({ output: 'continued', sessionId: uuid, exitCode: 0, duration_ms: 1 }, o); } } as Adapter;
        await executeSingleStage(config.stages[0], project, created.runId, created.runDirPath, config, transport, new Map([['coder', role]]), join(project, 'config', 'agents'), state, config.stages);
        const priorLog = readStageLiveLogPath(created.runDirPath, 'work', 1);
        console.log('RUNTIME_RETRY ' + JSON.stringify({ resume, promptHasProgress: prompt.includes(priorLog), attempts: readStageStatus(project, created.runId, 'work').attempts?.map(x => x.status) }));
        expect(calls).toBe(4);
        expect(resume).toBe(uuid);
        expect(prompt).toContain(priorLog);
        expect(prompt).not.toContain('timed out');
    });
    it.each([true, false])('retains own progress after provider refusal with session available=%s', async (hasSession) => {
        const config = workflow();
        config.defaults.max_retries = 1;
        const created = prepareFixtureRun(project, config, 'name: refusal\nstages: []\n');
        let calls = 0;
        let resume: string | undefined;
        let prompt = '';
        const failure = { kind: 'refusal', provider: 'codex', source: 'native_stdout', eventType: 'turn.failed', reason: 'fixture refusal after work' } as const;
        const adapter: Adapter = { async run(p, _agent, opts) {
                if (opts.stageId === '_summary')
                    return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
                if (++calls === 1) {
                    if (hasSession)
                        ownSession(opts.runDir, 'work');
                    appendEngineFile(stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt), 'verification completed; deliver the result\n');
                    return fixtureResult({ output: 'partial verified work; delivery interrupted', exitCode: 1, processExitCode: 1, duration_ms: 1, providerFailure: failure, ...(hasSession ? { sessionId: uuid } : {}) }, opts);
                }
                resume = opts.resumeSessionId;
                prompt = p;
                return fixtureResult({ output: 'delivered verified result', exitCode: 0, duration_ms: 1 }, opts);
            } };
        const final = await runWorkflow(config, 'name: refusal', project, adapter, new Map(), undefined, join(project, 'config', 'agents'), created.runId, 'current full task duties', true);
        const priorLog = readStageLiveLogPath(created.runDirPath, 'work', 1);
        console.log('RUNTIME_REFUSAL ' + JSON.stringify({ hasSession, status: final.status, resume, promptHasProgress: prompt.includes(priorLog), attempts: readStageStatus(project, created.runId, 'work').attempts?.map(x => x.status) }));
        expect(final.status).toBe('complete');
        expect(calls).toBe(2);
        expect(resume).toBe(hasSession ? uuid : undefined);
        expect(prompt).toContain(priorLog);
        expect(prompt).not.toContain('timed out');
        expect(prompt).toContain('write the declared product after scope admission');
        expect(readStageStatus(project, created.runId, 'work').attempts?.[0].providerFailure).toEqual(failure);
    });
    it('records a reconciliation exception against the single closed child', async () => {
        const config = workflow(), created = createRun(project, config.name, 'name: settlement', ['work']);
        let calls = 0;
        const adapter: Adapter = { async run(_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts) { calls++; return fixtureResult({ output: 'closed child output', exitCode: 0, duration_ms: 1 }, recordOpts); } };
        const runner = createScopeSafeStageRunner({ monitorApprovalRequests: async () => null, reconcileCompletedStageAttempts: () => {
            const closed = readStageStatus(project, created.runId, 'work');
            expect(closed.status).toBe('running');
            expect(closed.attempts?.at(-1)?.status).toBe('closed');
            throw Error('fixture reconciliation failure');
        } });
        await expect(runner.runScopeSafeStageGroup(config.stages, project, created.runId, 1, async (stage, settlementBoundary) => runStage(adapter, { stageId: stage.id, role, dependsOn: [], promptTemplate: 'current duties', artifactContract: stage.artifact_contract, projectDir: project, runId: created.runId, runDir: created.runDirPath, timeout_ms: 60000, retries: 0, settlementBoundary }))).rejects.toThrow('fixture reconciliation failure');
        const status = readStageStatus(project, created.runId, 'work'), events = readRunEvents(project, created.runId).filter(e => e.stageId === 'work');
        console.log('RUNTIME_EXCEPTION ' + JSON.stringify({ calls, attempts: status.attempts?.map(a => a.status), events: events.map(e => ({ type: e.type, status: e.status, attemptIndex: e.attemptIndex })) }));
        expect(calls).toBe(1);
        expect(status.attempts?.map(a => a.status)).toEqual(['failed']);
        expect(events.some(e => e.status === 'complete')).toBe(false);
        expect(events.filter(e => e.type === 'attempt_failed')).toHaveLength(1);
    });
});
import { readdirSync as requireNames } from 'node:fs';

describe('ordinary failure in the gate loop', () => {
    it.each([1, 0])('reruns a failed single stage in place up to max_retries=%s instead of ending the iteration', async (limit) => {
        const config = workflow();
        config.defaults.max_retries = limit;
        const created = createRun(project, config.name, 'name: settlement', ['work']);
        const state = readRunState(project, created.runId);
        state.status = 'running';
        writeRunState(project, created.runId, state);
        let calls = 0;
        let prompt = '';
        const transport = { run: async (p: string, _a: AgentConfig, o: import('../src/adapters/base.js').RunOpts) => {
                if (++calls === 1)
                    return fixtureResult({ output: 'configured checks failed', exitCode: 1, duration_ms: 1 }, o);
                prompt = p;
                return fixtureResult({ output: 'fixed', exitCode: 0, duration_ms: 1 }, o);
            } } as Adapter;
        await executeSingleStage(config.stages[0], project, created.runId, created.runDirPath, config, transport, new Map([['coder', role]]), join(project, 'config', 'agents'), state, config.stages);
        expect(calls).toBe(limit + 1);
        expect(readStageStatus(project, created.runId, 'work').status).toBe(limit ? 'complete' : 'failed');
        if (limit) {
            expect(prompt).toContain('Previous execution failed');
            expect(prompt).not.toContain('timed out');
        }
    });
});
