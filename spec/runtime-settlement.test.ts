import { runStage } from '../src/worker.js';
import { createScopeSafeStageRunner } from '../src/scheduler/sched_scope/stage-group.js';
import { createSchedulerLiveConstraintGuardFactory } from '../src/scheduler/sched_loop/services.js';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { createRun, setFcGlobalDir, fcGlobalDir, readStageStatus, readRunState, writeRunState } from '../src/store.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { publishConstraintDecision, scopePathDigest } from '../src/runtime-negotiation.js';
import { decideScopeRevision } from '../src/scheduler/sched_scope/scope-revisions.js';
import { appendGuidanceEnvelope, parseGuidanceLedger } from '../src/guidance.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
let root: string, project: string, prior: string;
const uuid = '11111111-1111-4111-8111-111111111111';
const role: AgentConfig = { name: 'coder', description: 'deterministic', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'current duties' };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fc-settlement-')); project = join(root, 'project'); mkdirSync(join(project, 'config', 'agents'), { recursive: true }); writeFileSync(join(project, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_retries: 1\n'); writeFileSync(join(project, 'config', 'agents', 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: test\nreasoning_effort: low\ntools: []\nprompt: fixture\n'); prior = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });
function ownSession(run: string, stage: string) { const home = join(run, 'stages', stage, 'codex_home'); mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'progress'), 'verified progress'); writeFileSync(join(run, 'stages', stage, 'session.json'), JSON.stringify({ version: 1, adapter: 'codex', sessionId: uuid, ownerStageId: stage, updatedAt: new Date().toISOString() })); return home; }
function workflow(): WorkflowConfig { return { name: 'settlement', description: '', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{ id: 'work', role: 'coder', depends_on: [], scope: [], skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [], prompt_template: 'write the declared product after scope admission', artifact_contract: fixtureArtifactContract('work') }] }; }
describe('scheduler attempt closure and own-stage retry progress', () => {
    it.each(['synchronous', 'command-boundary', 'operator-before-command'] as const)('settles a %s scope handoff without completion and resumes the retained home', async (shape) => {
        const config = workflow(), yaml = 'name: settlement\nstages: []\n', created = prepareFixtureRun(project, config, yaml);
        let calls = 0;
        let retained = false;
        let resume: string | undefined;
        const adapter: Adapter = { async run(prompt, _agent, opts) { if (opts.stageId === '_summary')
                return { output: 'summary', exitCode: 0, duration_ms: 1 }; calls++; if (calls === 1) {
                ownSession(opts.runDir, opts.stageId);
                if (shape === 'operator-before-command') appendGuidanceEnvelope({ runDir: opts.runDir, target: 'work', source: 'operator', attemptIndex: 1, body: 'Retain the operator requirement.' });
                if (shape !== 'synchronous')
                    opts.onCommandLifecycle?.({ phase: 'started', id: 'request', command: 'declare write scope', timestamp: new Date().toISOString() });
                const dir = join(opts.runDir, 'stages', opts.stageId);
                writeFileSync(join(dir, 'scope_revision_request.json'), JSON.stringify({ version: 1, kind: 'scope_revision', requestId: 'write-product', runId: created.runId, stageId: opts.stageId, attemptIndex: opts.attemptIndex, requestedPaths: ['product.txt'], pathDigest: scopePathDigest(['product.txt']), reason: 'produce product' }));
                if (shape !== 'synchronous') {
                    await waitForPathEvent(dir, () => { const names = requireNames(dir); return names.some(x => x.startsWith('scope_revision_decision_')) || undefined; });
                    opts.onCommandLifecycle?.({ phase: 'completed', id: 'request', timestamp: new Date().toISOString() });
                }
                return { output: 'verified progress ready for continuation', sessionId: uuid, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
            } expect(opts.attemptIndex).toBe(2); expect(prompt).not.toContain('This attempt stops at the control boundary'); if (shape === 'operator-before-command') expect(prompt).toContain('Retain the operator requirement.'); retained = existsSync(join(opts.runDir, 'stages', 'work', 'codex_home', 'progress')); resume = opts.resumeSessionId; writeFileSync(join(project, 'product.txt'), 'current product'); return { output: 'product delivered', sessionId: uuid, exitCode: 0, duration_ms: 1, writes: ['product.txt'], writeAttribution: 'structured' }; } };
        const final = await runWorkflow(config, yaml, project, adapter, new Map(), undefined, join(project, 'config', 'agents'), created.runId, 'settle product', true);
        const status = readStageStatus(project, created.runId, 'work'), events = readRunEvents(project, created.runId);
        console.log('RUNTIME_PAIR ' + JSON.stringify({ shape, status: final.status, attempts: status.attempts?.map(x => x.status), retained, resume, firstEvents: events.filter(x => x.stageId === 'work' && x.attemptIndex === 1).map(x => ({ type: x.type, status: x.status, detail: x.detail })) }));
        expect(calls).toBe(2);
        const notices = parseGuidanceLedger(readFileSync(join(created.runDirPath, 'supervisor_guidance.md'), 'utf8')).filter(x => x.source === 'scheduler');
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ attemptIndex: 2 });
        expect(notices[0].body).toContain('Newly admitted paths:');
        expect(notices[0].body).not.toContain('effective scope');
        expect(final.status).toBe('complete');
        expect(status.attempts?.map(x => x.status)).toEqual(['suspended', 'complete']);
        expect(retained).toBe(true);
        expect(resume).toBe(uuid);
        expect(events.filter(x => x.stageId === 'work' && x.attemptIndex === 1 && x.status === 'complete')).toEqual([]);
    });
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
                    writeFileSync(join(o.runDir, 'stages', 'work', 'live.log'), 'author finished verification; delivery remains\n');
                }
                return { output: 'refused after progress', sessionId: uuid, exitCode: 1, duration_ms: 1, adapterFailureKind: 'provider_internal_error' };
            } resume = o.resumeSessionId; prompt = p; return { output: 'continued', sessionId: uuid, exitCode: 0, duration_ms: 1 }; } } as Adapter;
        await executeSingleStage(config.stages[0], project, created.runId, created.runDirPath, config, transport, new Map([['coder', role]]), join(project, 'config', 'agents'), state, config.stages);
        console.log('RUNTIME_RETRY ' + JSON.stringify({ resume, promptHasProgress: prompt.includes('live.log'), attempts: readStageStatus(project, created.runId, 'work').attempts?.map(x => x.status) }));
        expect(resume).toBe(uuid);
        expect(prompt).toContain('live.log');
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
                    return { output: 'summary', exitCode: 0, duration_ms: 1 };
                if (++calls === 1) {
                    if (hasSession)
                        ownSession(opts.runDir, 'work');
                    writeFileSync(join(opts.runDir, 'stages', 'work', 'live.log'), 'verification completed; deliver the result\n');
                    return { output: 'partial verified work; delivery interrupted', exitCode: 1, processExitCode: 1, duration_ms: 1, providerFailure: failure, ...(hasSession ? { sessionId: uuid } : {}) };
                }
                resume = opts.resumeSessionId;
                prompt = p;
                return { output: 'delivered verified result', exitCode: 0, duration_ms: 1 };
            } };
        const final = await runWorkflow(config, 'name: refusal', project, adapter, new Map(), undefined, join(project, 'config', 'agents'), created.runId, 'current full task duties', true);
        console.log('RUNTIME_REFUSAL ' + JSON.stringify({ hasSession, status: final.status, resume, promptHasProgress: prompt.includes('live.log'), attempts: readStageStatus(project, created.runId, 'work').attempts?.map(x => x.status) }));
        expect(final.status).toBe('complete');
        expect(calls).toBe(2);
        expect(resume).toBe(hasSession ? uuid : undefined);
        expect(prompt).toContain('live.log');
        expect(prompt).not.toContain('timed out');
        expect(prompt).toContain('write the declared product after scope admission');
        expect(readStageStatus(project, created.runId, 'work').attempts?.[0].providerFailure).toEqual(failure);
    });
    it.each(['unobserved-child-close', 'refused-boundary', 'missing-boundary-receipt'] as const)('refuses clean scope suspension after %s', async (shape) => {
        const config = workflow(), created = prepareFixtureRun(project, config, 'name: unknown-close');
        let calls = 0;
        const result = await runStage({ async run(_prompt, _role, opts) {
            calls++;
            opts.onCommandLifecycle?.({ phase: 'started', id: 'request', timestamp: new Date().toISOString() });
            const paths = ['product.txt'];
            const request = { version: 1 as const, kind: 'scope_revision' as const, requestId: 'closed-grant',
                runId: created.runId, stageId: 'work', attemptIndex: 1, requestedBy: 'stage' as const,
                requestedPaths: paths, pathDigest: scopePathDigest(paths), reason: 'produce product' };
            const decision = decideScopeRevision({ request, stage: config.stages[0], priorScope: [], activePeers: [],
                projectDir: project, runId: created.runId, attemptIndex: 1 });
            publishConstraintDecision({ stagePath: join(created.runDirPath, 'stages/work'), request,
                decidedBy: 'scheduler-policy', decision: decision as Parameters<typeof publishConstraintDecision>[0]['decision'] });
            opts.onCommandLifecycle?.({ phase: 'completed', id: 'request', timestamp: new Date().toISOString() });
            if (shape === 'unobserved-child-close') return new Promise<import('../src/adapters/base.js').RunResult>(() => {});
            if (shape === 'missing-boundary-receipt') return { output: 'launcher closed without receipt', exitCode: 125, duration_ms: 1 };
            return { output: 'boundary refused', exitCode: 125, duration_ms: 1,
                writeBoundary: { kind: 'refused' as const, message: 'fixture boundary refuses launch' } };
        } }, { stageId: 'work', role, dependsOn: [], promptTemplate: 'current duties',
            artifactContract: config.stages[0].artifact_contract, projectDir: project, runId: created.runId,
            runDir: created.runDirPath, timeout_ms: 60000, retries: 0 });
        expect(calls).toBe(1);
        expect(result.exitCode).not.toBe(0);
        expect(result.suspended).not.toBe(true);
        const attempt = readStageStatus(project, created.runId, 'work').attempts?.[0];
        expect(attempt?.status).toBe('failed');
        if (shape === 'unobserved-child-close') expect(attempt?.timeout?.childClosedAt).toBeUndefined();
    }, 15000);
    it('honours current-execution ABORT immediately before scope settlement', async () => {
        const config = workflow(), created = prepareFixtureRun(project, config, 'name: abort');
        const paths = ['product.txt'];
        const request = { version: 1 as const, kind: 'scope_revision' as const, requestId: 'abort-grant',
            runId: created.runId, stageId: 'work', attemptIndex: 1, requestedBy: 'stage' as const,
            requestedPaths: paths, pathDigest: scopePathDigest(paths), reason: 'produce product' };
        const decision = decideScopeRevision({ request, stage: config.stages[0], priorScope: [], activePeers: [],
            projectDir: project, runId: created.runId, attemptIndex: 1 });
        publishConstraintDecision({ stagePath: join(created.runDirPath, 'stages/work'), request,
            decidedBy: 'scheduler-policy', decision: decision as Parameters<typeof publishConstraintDecision>[0]['decision'] });
        let calls = 0;
        const result = await runStage({ async run() { calls++; return { output: 'closed child', exitCode: 0, duration_ms: 1 }; } }, {
            stageId: 'work', role, dependsOn: [], promptTemplate: 'current duties', artifactContract: config.stages[0].artifact_contract,
            projectDir: project, runId: created.runId, runDir: created.runDirPath, timeout_ms: 60000, retries: 0,
            beforeSettlement: async () => {
                writeFileSync(join(created.runDirPath, 'signals/abort_work.json'), JSON.stringify({ version: 1,
                    stageId: 'work', attemptIndex: 1, source: 'supervisor', reason: 'ABORT before settlement', timestamp: new Date().toISOString() }));
                return true;
            },
        });
        expect(calls).toBe(1);
        expect(result.exitCode).toBe(137);
        expect(result.suspended).not.toBe(true);
        expect(readStageStatus(project, created.runId, 'work').attempts?.[0].timeout?.terminationCause).toBe('supervisor_abort');
    });
    it('records a reconciliation exception against the single closed child', async () => {
        const config = workflow(), created = createRun(project, config.name, 'name: settlement', ['work']);
        let calls = 0;
        const adapter: Adapter = { async run() { calls++; return { output: 'closed child output', exitCode: 0, duration_ms: 1 }; } };
        const runner = createScopeSafeStageRunner({ monitorApprovalRequests: async () => null, monitorScopeRevisionRequests: async () => { }, createSchedulerLiveConstraintGuardFactory, reconcileCompletedStageAttempts: () => { throw Error('fixture reconciliation failure'); } });
        await expect(runner.runScopeSafeStageGroup(config.stages, project, created.runId, 1, async (stage, _guard, beforeSettlement) => runStage(adapter, { stageId: stage.id, role, dependsOn: [], promptTemplate: 'current duties', artifactContract: stage.artifact_contract, projectDir: project, runId: created.runId, runDir: created.runDirPath, timeout_ms: 60000, retries: 0, beforeSettlement, deferSettlement: true }))).rejects.toThrow('fixture reconciliation failure');
        const status = readStageStatus(project, created.runId, 'work'), events = readRunEvents(project, created.runId).filter(e => e.stageId === 'work');
        console.log('RUNTIME_EXCEPTION ' + JSON.stringify({ calls, attempts: status.attempts?.map(a => a.status), events: events.map(e => ({ type: e.type, status: e.status, attemptIndex: e.attemptIndex })) }));
        expect(calls).toBe(1);
        expect(status.attempts?.map(a => a.status)).toEqual(['failed']);
        expect(events.some(e => e.status === 'complete')).toBe(false);
        expect(events.filter(e => e.type === 'attempt_failed')).toHaveLength(1);
    });
});
import { readdirSync as requireNames } from 'node:fs';
