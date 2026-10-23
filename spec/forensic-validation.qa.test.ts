import { classifyAdapterFailure } from '../src/adapters/failure.js';
import { decideStageRetry } from '../src/scheduler/sched_settlement/stage-execution.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { parseCodexJsonl } from '../src/adapters/codex.js';
import { createTechnicalRetryBudgetState, transitionTechnicalRetryBudget } from '../src/attempt-deadline.js';
import { Orchestrator, type GitAdapter } from '../src/orchestrator.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import {
  appendResearchPathContract,
  inspectRealityCheckReachability,
  recordSchedulerTechnicalAttemptResult,
} from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { RUN_STATUS, fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import type { SupervisorBackend, UnitStatus } from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';
import { runStage } from '../src/worker.js';

const temporaryRoots: string[] = [];
const role: AgentConfig = {
  name: 'forensic-fixture',
  description: 'fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
  adapter: 'test',
};

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scheduler admission and evidence contracts', () => {

  it('preserves a structured launch refusal without spending a retry', async () => {
    const root = temporaryRoot('launch-refusal');
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const refusal = 'Launch refused: research.stop.max_rounds (8) exceeds the engine iteration limit (5); units: rounds versus iterations. Adjust the named authored budget or its named engine binding.';
    const refusedTask = registry.create({ brief_text: 'fixture', projectDir: root, status: TASK_STATUS.RUNNING, max_retries: 2 });
    const ordinaryTask = registry.create({ brief_text: 'control', projectDir: root, status: TASK_STATUS.RUNNING, max_retries: 2 });
    const units: SupervisorBackend = {
      async isActive(unit): Promise<UnitStatus> {
        return unit === refusedTask.systemd_unit
          ? { kind: 'terminal', exitCode: 2, launchRefusal: { version: 1, kind: 'launch_refused', message: refusal, refusedAt: '2026-09-22T19:19:17.000Z' } }
          : { kind: 'terminal', exitCode: 2 };
      },
      async runUnit(): Promise<void> {}, async stopUnit(): Promise<void> {}, async journalTail(): Promise<string> { return ''; },
    };
    const git: GitAdapter = {
      async findCommitByPrefix() { return undefined; },
      async hasUncommittedChanges() { return false; },
      async findCommitSince() { return undefined; },
    };
    const orchestrator = new Orchestrator({ registry, systemd: units, git, isProjectBusy: () => null });
    await orchestrator.tickOnce();

    expect(registry.get(refusedTask.id)).toMatchObject({ status: TASK_STATUS.FAILED, attempt: 1, notes: refusal });
    expect(registry.get(ordinaryTask.id)).toMatchObject({ status: TASK_STATUS.DEFERRED, attempt: 1 });
  });

  it('records capacity failures and preserves semantic failures on separate retry paths', async () => {
    const projectDir = temporaryRoot('capacity-project');
    const stateDir = temporaryRoot('capacity-state');
    const previousStateDir = fcGlobalDir();
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    setFcGlobalDir(stateDir);
    try {
      const created = createRun(projectDir, 'capacity-fixture', 'name: capacity-fixture', ['work']);
      const parsed = parseCodexJsonl([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'mid-work' } }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity.' } }),
      ].join('\n'));
      const adapter: Adapter = { async run() { return {
        output: parsed.output, exitCode: 1, duration_ms: 1,
        providerFailure: parsed.providerFailure,
      }; } };
      const result = await runStage(adapter, {
      artifactContract: fixtureArtifactContract('work'),
        stageId: 'work', role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 1_000,
        technicalRetry: { delaysMs: [] }, projectDir, runId: created.runId, runDir: created.runDirPath, retries: 0,
      });
      const events = readFileSync(join(created.runDirPath, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(result).toMatchObject({ exitCode: 1, providerFailure: { kind: 'transient' } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'attempt_failed', providerFailure: expect.objectContaining({ kind: 'transient' }) }));
      const quoted = parseCodexJsonl([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'assertion quoted Selected model is at capacity.' } }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'Stage assertion failed' } }),
      ].join('\n'));
      expect(quoted.providerFailure).toBeUndefined();
      expect(classifyAdapterFailure('assertion mismatch in stage output')).toBeUndefined();
      const semanticRun = createRun(projectDir, 'quoted-control', 'name: quoted-control', ['work']);
      const semanticAdapter: Adapter = { async run() { return {
        output: quoted.output, exitCode: 1, duration_ms: 1,
      }; } };
      const semantic = await runStage(semanticAdapter, {
      artifactContract: fixtureArtifactContract('work'),
        stageId: 'work', role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 1_000,
        technicalRetry: { delaysMs: [] }, projectDir, runId: semanticRun.runId, runDir: semanticRun.runDirPath, retries: 0,
      });
      const semanticEvents = readFileSync(join(semanticRun.runDirPath, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(semantic.providerFailure).toBeUndefined();
      const semanticFailure = semanticEvents.find(event => event.type === 'attempt_failed');
      expect(semanticFailure).toBeDefined();
      expect(semanticFailure?.providerFailure).toBeUndefined();
      const technicalRetry = createTechnicalRetryBudgetState({ initialBudgetMs: 1_000 });
      const first = transitionTechnicalRetryBudget(technicalRetry, { type: 'prepare_attempt' });
      expect(first).toMatchObject({ type: 'attempt_prepared', budgetMs: 1_000 });
      recordSchedulerTechnicalAttemptResult(technicalRetry, result, 1_000);
      expect(decideStageRetry(result, 0, 1, 1)).toBe('retry');
      expect(decideStageRetry(semantic, 0, 1, 1)).toBe('retry');
      const second = transitionTechnicalRetryBudget(technicalRetry, { type: 'prepare_attempt' });
      expect(second).toMatchObject({ type: 'attempt_prepared', budgetMs: 1_000 });
    } finally { setFcGlobalDir(previousStateDir); }
  });

  it('refuses a current-round gate dependency on the later manifest', () => {
    const projectDir = temporaryRoot('research-order');
    const research = { baseline: 0, policy: 'greedy_stack' as const, resultFile: 'docs/round_result.json', reportDir: 'docs', stop: { maxRounds: 2 } };
    const check = (path: string, source: { kind: 'input' } | { kind: 'stage'; stage: string; artifact: string } = { kind: 'input' }) => [
      '## Reality checks', '```yaml', 'checks:', '  - name: temporal_check', '    type: file-exists-nonempty',
      `    reads: [{id: subject, root: project, path: ${path}, source: ${JSON.stringify(source)}}]`,
      '    params:', `      paths: [${path}]`, '```',
    ].join('\n');
    const refused = inspectRealityCheckReachability({ markdown: check('docs/run_manifest.json'), projectDir, stages: [], research });
    const ordinary = inspectRealityCheckReachability({
      markdown: check('docs/report.json', { kind: 'stage', stage: 'writer', artifact: 'report' }), projectDir, research,
      stages: [{ artifact_contract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.json' }], reads: [] }), id: 'writer', role: 'researcher', depends_on: [], prompt_template: '', skills: [], criterion_refs: [], scope: ['docs/report.json'], is_gate: false }],
    });
    const prompt = appendResearchPathContract('confirm the round', research, undefined);
    expect(refused.join('\n')).toContain('writes it only after the current round');
    expect(prompt).toContain('framework round manifest (written before confirmation): docs/run_manifest.json');
    expect(prompt).toContain("Its evidence locator records accepted observations");
    expect(ordinary).toEqual([]);
  });

  it('preserves terminal authority while cancelling unknown nonterminal execution', async () => {
    const root = temporaryRoot('terminal-observation');
    const projectDir = join(root, 'project');
    const runsDir = join(root, 'runs');
    mkdirSync(projectDir, { recursive: true });
    const writeRun = (runId: string, status: string) => {
      mkdirSync(join(runsDir, runId), { recursive: true });
      writeFileSync(join(runsDir, runId, 'run.json'), JSON.stringify({ runId, projectDir, workflowName: 'fixture', status, stages: {}, startedAt: '2026-09-22T00:00:00.000Z' }));
    };
    writeRun('terminal-run', RUN_STATUS.COMPLETE);
    writeRun('running-run', RUN_STATUS.RUNNING);
    const terminalPath = join(runsDir, 'terminal-run', 'run.json');
    const terminalBytes = readFileSync(terminalPath, 'utf8');
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    // The registry can lag the authoritative run record during the exact shim
    // exit race: durable terminal run truth must already answer cancellation.
    const terminal = registry.create({ brief_text: 'terminal', projectDir, run_id: 'terminal-run', status: TASK_STATUS.RUNNING });
    const running = registry.create({ brief_text: 'running', projectDir, run_id: 'running-run', status: TASK_STATUS.RUNNING });
    const units: SupervisorBackend = {
      async isActive(): Promise<UnitStatus> { return { kind: 'terminal-unknown', reason: 'shim-died-without-status' }; },
      async runUnit(): Promise<void> {}, async stopUnit(): Promise<void> {}, async journalTail(): Promise<string> { return ''; },
    };
    const coordinator = new RunCancellationCoordinator({ registry, units, runsDir, timeoutMs: 0 });
    const terminalResult = await coordinator.cancelTask(terminal.id);
    const control = await coordinator.cancelTask(running.id);
    expect(terminalResult).toMatchObject({ ok: true, status: 'cancelled', preservedRunStatus: RUN_STATUS.COMPLETE });
    expect(registry.get(terminal.id)?.status).toBe(TASK_STATUS.CANCELLED);
    expect(readFileSync(terminalPath, 'utf8')).toBe(terminalBytes);
    expect(control).toMatchObject({ ok: true, status: 'cancelled' });
  });
});
