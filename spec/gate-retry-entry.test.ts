import { readStageInput } from '../src/store.js';
import { readInvocationInput } from '../src/run-state-view.js';
import { gateArchiveArtifactPath } from '../src/scheduler/sched_settlement/gate-archives.js';
import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { readRunEvents } from '../src/run-events.js';
import { foldItems } from '../src/inbox.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fcGlobalDir, runDir, RUN_STATUS, setFcGlobalDir } from '../src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, '..');
const GATE_ID = 'verify_e18';
const REPAIR_ID = 'fix_e18';
const UNRELATED_GATE_ID = 'verify_unrelated';

let root: string;
let projectDir: string;
let previousFcHome: string;

function scoredVerdict(pass: boolean, reason: string): Record<string, unknown> {
  return { pass, reason, metric: 'e18_quality', score: pass ? 0 : -1, threshold: 0 };
}

function metricArtifact(pass: boolean): Record<string, unknown> {
  return {
    hasMetric: true,
    metric: 'e18_quality',
    value: pass ? 0 : -1,
    higherIsBetter: true,
    threshold: 0,
    pass,
    source: { path: 'fixture', evidence: `e18_quality=${pass ? 0 : -1}` },
  };
}

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: E18 scheduler entry fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: E18 scheduler entry fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function workflow(): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: e18-gate-retry-entry',
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    scope: [src/scheduler.ts, spec/e18-gate-retry-entry.test.ts, docs/task_summary.md]',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {description: '', 
      name: 'e18-gate-retry-entry',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [], 
        id: 'plan', role: 'planner', depends_on: [],
        scope: ['src/scheduler.ts', 'spec/e18-gate-retry-entry.test.ts', 'docs/task_summary.md'],
        prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false,
      }],
    },
  };
}

function dispatchYaml(
  includeUnrelatedRejectedGate = false,
  includeTerminalOwner = false,
  includeEscalationOwner = false,
): string {
  return [
    'stages:',
    `  - id: ${GATE_ID}`,
    '    role: qa',
    '    scope: [src/scheduler.ts, spec/e18-gate-retry-entry.test.ts, checks/e18-gate-retry-entry.test.ts]',
    '    depends_on: [plan]',
    '    dependency_reasons: {plan: "audit the planned E18 change"}',
    '    is_gate: true',
    '    task: verify E18',
    ...(includeUnrelatedRejectedGate ? [
      `  - id: ${UNRELATED_GATE_ID}`,
      '    role: qa',
      '    scope: [spec/e18-gate-retry-entry.test.ts]',
      '    depends_on: [plan]',
      '    dependency_reasons: {plan: "audit an unrelated concern"}',
      '    is_gate: true',
      '    task: verify unrelated concern',
      '  - id: fix_unrelated',
      '    role: repair',
      '    scope: [spec/e18-gate-retry-entry.test.ts]',
      `    depends_on: [${UNRELATED_GATE_ID}]`,
      `    retry_to: [${UNRELATED_GATE_ID}]`,
      '    task: repair the unrelated rejected concern',
    ] : []),
    `  - id: ${REPAIR_ID}`,
    '    role: repair',
    '    scope: [src/scheduler.ts, spec/e18-gate-retry-entry.test.ts, docs/task_summary.md]',
    `    depends_on: [${GATE_ID}]`,
    `    dependency_reasons: {${GATE_ID}: "repair only an explicit E18 rejection"}`,
    `    retry_to: [${GATE_ID}]`,
    '    task: repair E18',
    ...(includeTerminalOwner ? [
      '  - id: terminal_finalize',
      '    role: repair',
      '    scope: [docs/final_verification.md]',
      `    depends_on: [${GATE_ID}]`,
      `    dependency_reasons: {${GATE_ID}: "write the terminal report only after the repaired gate passes"}`,
      '    task: write the selected terminal report',
    ] : []),
    ...(includeEscalationOwner ? [
      '  - id: escalation_finalize',
      '    role: repair',
      '    scope: [docs/research_escalation.md]',
      `    depends_on: [${GATE_ID}]`,
      `    dependency_reasons: {${GATE_ID}: "record the exhausted rejected gate"}`,
      '    condition: research.terminalStatus == "escalated"',
      '    task: write the escalation terminal report',
    ] : []),
  ].join('\n');
}

interface ScenarioOptions {
  gatePasses: boolean[];
  gateCriteria?: Record<string, { status: 'pass' | 'fail' | 'judgement'; evidence: string }>;
  legacyMetricPass?: boolean;
  includeUnrelatedRejectedGate?: boolean;
  terminalArtifactOnPass?: boolean;
  researchMode?: boolean;
  escalationTerminal?: boolean;
  unauthorizedEscalationWrite?: boolean;
}

async function runScenario(options: ScenarioOptions): Promise<{
  final: Awaited<ReturnType<typeof runWorkflow>>;
  runDirPath: string;
  gateCalls: number;
  repairCalls: number;
  escalationCalls: number;
  repairSawArchivedNegative: boolean;
  gateInputs: string[];
}> {
  const { config, yaml } = workflow();
  let gateCalls = 0;
  let repairCalls = 0;
  let escalationCalls = 0;
  let repairSawArchivedNegative = false;
  const gateInputs: string[] = [];
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') {
        return fixtureResult({ output: '## E18 fixture summary', exitCode: 0, duration_ms: 1 }, opts);
      }
      if (opts.stageId === 'plan') {
        writeFileSync(
          join(opts.runDir, 'fixture_dispatch.yaml'),
          declaredDispatch(dispatchYaml(
            options.includeUnrelatedRejectedGate,
            options.terminalArtifactOnPass,
            options.escalationTerminal,
          )),
        );
        return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === GATE_ID) {
        gateInputs.push(readStageInput(projectDir, opts.runDir.split('/').at(-1)!, GATE_ID));
        const pass = options.gatePasses[Math.min(gateCalls, options.gatePasses.length - 1)];
        gateCalls++;
        const verdict = scoredVerdict(pass, pass ? 'accepted' : 'explicit rejection');
        if (options.gateCriteria) verdict.criteria = options.gateCriteria;
        writeFileSync(
          join(opts.runDir, `fixture_verdict_${GATE_ID}.json`),
          JSON.stringify(verdict, null, 2) + '\n',
        );
        const metricPath = join(opts.runDir, 'stages', GATE_ID, 'metric.json');
        writeFileSync(metricPath, JSON.stringify(metricArtifact(options.legacyMetricPass ?? pass), null, 2) + '\n');
        return fixtureResult({ output: `gate ${gateCalls}: ${pass}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === 'terminal_finalize') {
        mkdirSync(join(projectDir, 'docs'), { recursive: true });
        writeFileSync(
          join(projectDir, 'docs', 'final_verification.md'),
          '# Synthetic final verification\n\nThe declared outcome is complete.\n',
        );
        return fixtureResult({
          output: 'terminal report written by its admitted owner',
          exitCode: 0,
          duration_ms: 1,
          writes: ['docs/final_verification.md'],
          writeAttribution: 'structured',
        }, opts);
      }
      if (opts.stageId === 'escalation_finalize') {
        escalationCalls++;
        mkdirSync(join(projectDir, 'docs'), { recursive: true });
        writeFileSync(
          join(projectDir, 'docs', 'research_escalation.md'),
          '# Research gate escalation\n\nThe rejected criteria remain unsatisfied.\n',
        );
        if (options.unauthorizedEscalationWrite) writeFileSync(join(projectDir, 'outside.txt'), 'unauthorized finalizer work');
        return fixtureResult({
          output: 'escalation terminal written by its admitted owner',
          exitCode: 0,
          duration_ms: 1,
          writes: ['docs/research_escalation.md', ...(options.unauthorizedEscalationWrite ? ['outside.txt'] : [])],
          writeAttribution: 'structured',
        }, opts);
      }
      if (opts.stageId === UNRELATED_GATE_ID) {
        writeFileSync(
          join(opts.runDir, `fixture_verdict_${UNRELATED_GATE_ID}.json`),
          JSON.stringify(scoredVerdict(false, 'unrelated rejection'), null, 2) + '\n',
        );
        return fixtureResult({ output: 'unrelated gate: false', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === REPAIR_ID) {
        repairCalls++;
        const archived = join(
          opts.runDir,
          'gate_reevaluation',
          'iteration_1',
          `round_${repairCalls}`,
          `rejected_verdict_${GATE_ID}.json`,
        );
        if (existsSync(archived)) {
          repairSawArchivedNegative ||= JSON.parse(readFileSync(archived, 'utf-8')).pass === false;
        }
        return fixtureResult({ output: 'repair executed', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === 'fix_unrelated') {
        return fixtureResult({ output: 'unrelated repair executed', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      return fixtureResult({ output: `unexpected stage ${opts.stageId}`, exitCode: 1, duration_ms: 1 }, opts);
    },
  };

  const final = await runWorkflow(
    config,
    yaml,
    projectDir,
    adapter,
    new Map(),
    undefined,
    writeRoles(),
    undefined,
    options.terminalArtifactOnPass
      ? `---\nterminal_states:\n  complete:\n    paths: [docs/final_verification.md]\n---\n# E18 scheduler-level terminal fixture\n`
      : options.escalationTerminal
        ? `---\nterminal_states:\n  escalated:\n    paths: [docs/research_escalation.md]\nresearch:\n  baseline: 0\n  policy: greedy_stack\n  result_file: research/round_result.json\n---\n# Exhausted research gate fixture\n`
        : options.researchMode
          ? `---\nresearch:\n  baseline: 0\n  policy: greedy_stack\n  result_file: research/round_result.json\n---\n# Exhausted research gate fixture\n`
          : 'E18 scheduler-level integration fixture',
    true,
  );
  return {
    final,
    runDirPath: runDir(projectDir, final.runId),
    gateCalls,
    repairCalls,
    escalationCalls,
    repairSawArchivedNegative,
    gateInputs,
  };
}

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  root = mkdtempSync(join(tmpdir(), `flowcrew-e18-${randomBytes(4).toString('hex')}-`));
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  setFcGlobalDir(join(root, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcHome);
  rmSync(root, { recursive: true, force: true });
});

describe('gate retry loop entry', () => {
  it('H7 completes an exhausted rejected research round as incomplete without advancing or requesting approval', async () => {
    const result = await runScenario({
      gatePasses: [false],
      researchMode: true,
      gateCriteria: {
        criterion_pass: { status: 'pass', evidence: 'accepted evidence' },
        criterion_fail: { status: 'fail', evidence: 'still unsatisfied' },
      },
    });
    const events = readRunEvents(projectDir, result.final.runId);
    const exhausted = JSON.parse(readFileSync(
      join(result.runDirPath, 'research_gate_exhausted.json'),
      'utf-8',
    )) as { criteria: string[] };

    expect(result.final.status).toBe(RUN_STATUS.INCOMPLETE);
    expect(result.final.completedAt).toEqual(expect.any(String));
    expect(result.final.parked).toBeUndefined();
    expect(foldItems(result.final.runId).size).toBe(0);
    expect(events.some((event) => event.type === 'approval_parked')).toBe(false);
    expect(events.some((event) => event.type === 'iteration_completed')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'research_gate_exhausted',
      round: 1,
      criteria: ['criterion_fail'],
    }));
    expect(exhausted.criteria).toEqual(['criterion_fail']);
    expect(result.final.failureReason).toContain('round 1');
    expect(result.final.failureReason).toContain('criterion_fail');
    expect(result.final.failureReason).toContain('no admitted escalation terminal owner');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_completed',
      timestamp: result.final.completedAt,
      detail: result.final.failureReason,
    }));
  });

  it('H7 runs an admitted escalation terminal owner after research gate exhaustion', async () => {
    const result = await runScenario({
      gatePasses: [false],
      escalationTerminal: true,
      gateCriteria: {
        criterion_pass: { status: 'pass', evidence: 'accepted evidence' },
        criterion_fail: { status: 'fail', evidence: 'still unsatisfied' },
      },
    });
    const events = readRunEvents(projectDir, result.final.runId);
    const decision = JSON.parse(readFileSync(
      join(result.runDirPath, 'research_decision.json'),
      'utf-8',
    )) as { failingCriteria: string[] };
    const ready = JSON.parse(readFileSync(
      join(result.runDirPath, 'signals', 'research_terminal_ready.json'),
      'utf-8',
    )) as { failingCriteria: string[] };

    expect(result.final.status).toBe(RUN_STATUS.ESCALATED);
    expect(result.escalationCalls).toBe(1);
    expect(readFileSync(join(projectDir, 'docs', 'research_escalation.md'), 'utf-8'))
      .toContain('rejected criteria remain unsatisfied');
    expect(events.some((event) => event.type === 'iteration_completed')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'research_gate_exhausted',
      criteria: ['criterion_fail'],
    }));
    expect(decision.failingCriteria).toEqual(['criterion_fail']);
    expect(ready.failingCriteria).toEqual(['criterion_fail']);
  });

  it('audits legitimate escalation-finalizer work outside its path estimate after gate exhaustion', async () => {
    const result = await runScenario({ gatePasses: [false], escalationTerminal: true, unauthorizedEscalationWrite: true,
      gateCriteria: { criterion_fail: { status: 'fail', evidence: 'still unsatisfied' } } });
    const finalizer = result.final.stages.escalation_finalize;
    expect(result.final.status, JSON.stringify({ status: finalizer.status, constraintAudit: finalizer.constraintAudit })).not.toBe(RUN_STATUS.ESCALATED);
    expect(result.escalationCalls).toBeGreaterThan(0);
    expect(existsSync(join(projectDir, 'outside.txt'))).toBe(true);
    const attempt = finalizer.attempts?.at(-1);
    expect(attempt?.status).toBe('complete');
    expect(attempt?.constraintAudit).toBeDefined();
    expect(readFileSync(join(result.runDirPath, attempt!.constraintAudit!.path), 'utf8')).toContain('outside.txt');
  });

  it('treats pass=true at score=0/threshold=0 as accepted and never dispatches repair', async () => {
    const result = await runScenario({ gatePasses: [true] });

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(1);
    expect(result.repairCalls).toBe(0);
    expect(result.final.stages[REPAIR_ID]?.status).toBe('skipped');
    expect(JSON.parse(readFileSync(join(result.runDirPath, `verdict_${GATE_ID}.json`), 'utf-8'))).toMatchObject({
      pass: true, metric: 'e18_quality', score: 0, threshold: 0,
    });
    expect(JSON.parse(readFileSync(join(result.runDirPath, 'stages', GATE_ID, 'metric.json'), 'utf-8'))).toMatchObject({
      pass: true, metric: 'e18_quality', value: 0, threshold: 0,
    });
    expect(existsSync(join(result.runDirPath, 'gate_reevaluation'))).toBe(false);
  });

  it('dispatches repair for an explicit negative verdict, then stops after the re-evaluation passes', async () => {
    const result = await runScenario({ gatePasses: [false, true] });

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(2);
    expect(result.repairCalls).toBe(1);
    expect(result.repairSawArchivedNegative).toBe(true);
    expect(result.final.stages[REPAIR_ID]?.status).toBe('complete');
    expect(JSON.parse(readFileSync(join(result.runDirPath, `verdict_${GATE_ID}.json`), 'utf-8'))).toMatchObject({
      pass: true, score: 0, threshold: 0,
    });
    expect(JSON.parse(readFileSync(join(
      result.runDirPath,
      'gate_reevaluation',
      'iteration_1',
      'round_1',
      `rejected_verdict_${GATE_ID}.json`,
    ), 'utf-8'))).toMatchObject({ pass: false, score: -1, threshold: 0 });
    const inputPath = gateArchiveArtifactPath(result.runDirPath, { iteration: 1, round: 1 }, GATE_ID, 'input');
    expect(existsSync(inputPath)).toBe(true);
    const archivedInput = readInvocationInput(inputPath).userPrompt;
    expect(result.gateInputs).toHaveLength(2);
    expect(archivedInput).toBe(result.gateInputs[0]);
    expect(archivedInput).not.toBe(result.gateInputs[1]);
    expect(readStageInput(projectDir, result.final.runId, GATE_ID)).toBe(result.gateInputs[1]);
    expect(existsSync(join(
      result.runDirPath,
      'gate_reevaluation',
      'iteration_1',
      'round_2',
    ))).toBe(false);
  });

  it('re-evaluates a declared terminal artifact written by the downstream terminal owner', async () => {
    const result = await runScenario({
      gatePasses: [false, true],
      terminalArtifactOnPass: true,
    });
    const events = readRunEvents(projectDir, result.final.runId);

    expect(result.gateCalls).toBe(2);
    expect(result.repairCalls).toBe(1);
    expect(result.final.status).toBe(RUN_STATUS.COMPLETE);
    expect(result.final.terminalArtifact).toBe('docs/final_verification.md');
    expect(Object.values(result.final.stages).map((stage) => stage.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_completed',
      detail: expect.stringContaining(`Terminal state '${RUN_STATUS.COMPLETE}' reached via docs/final_verification.md`),
    }));
  });

  it('ignores persistent retired metric evidence without re-running a passing review', async () => {
    const result = await runScenario({ gatePasses: [true], legacyMetricPass: false });
    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(1);
    expect(result.repairCalls).toBe(0);
    expect(existsSync(join(result.runDirPath, 'gate_reevaluation'))).toBe(false);
  });

  it('guards a related pass even while an unrelated gate remains rejected', async () => {
    const result = await runScenario({
      gatePasses: [true],
      legacyMetricPass: false,
      includeUnrelatedRejectedGate: true,
    });

    expect(result.repairCalls).toBe(0);
    expect(result.gateCalls).toBe(1);
    expect(JSON.parse(readFileSync(join(result.runDirPath, `verdict_${GATE_ID}.json`), 'utf-8'))).toMatchObject({ pass: true });
    const archiveDir = join(result.runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
    expect(JSON.parse(readFileSync(
      join(archiveDir, `rejected_verdict_${UNRELATED_GATE_ID}.json`),
      'utf-8',
    ))).toMatchObject({ pass: false, reason: 'unrelated rejection' });
  });
});
