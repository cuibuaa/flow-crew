import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { readGateVerdict, runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, '..');
const GATE_ID = 'contract_gate';
const REPAIR_ID = 'repair_contract';

let root: string;
let projectDir: string;
let previousFcHome: string;

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: gate attempt contract fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: gate attempt contract fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function workflow(maxIterations: number): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: gate-attempt-contract',
    'defaults:',
    `  max_iterations: ${maxIterations}`,
    '  max_retries: 0',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    scope: []',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {
      name: 'gate-attempt-contract',
      defaults: { max_iterations: maxIterations, max_retries: 0 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], scope: [], prompt_template: '',
        dynamic_dispatch: true, is_gate: false, skills: [],
      }],
    },
  };
}

function dispatchYaml(includeRepair: boolean): string {
  return [
    'stages:',
    `  - id: ${GATE_ID}`,
    '    role: qa',
    '    scope: []',
    '    depends_on: [plan]',
    '    dependency_reasons: {plan: "audit the current planned attempt"}',
    '    is_gate: true',
    '    prompt_template: Audit the current attempt and write its verdict.',
    ...(includeRepair ? [
      `  - id: ${REPAIR_ID}`,
      '    role: repair',
      '    scope: []',
      `    depends_on: [${GATE_ID}]`,
      `    dependency_reasons: {${GATE_ID}: "repair only a product defect found by the gate"}`,
      `    retry_to: [${GATE_ID}]`,
      '    prompt_template: Repair the product defect named by the gate.',
    ] : []),
  ].join('\n');
}

interface ScenarioOptions {
  maxIterations?: number;
  includeRepair?: boolean;
  contract?: { metric: string; threshold: number; higherIsBetter: boolean };
  gateAttempt: (input: {
    call: number;
    prompt: string;
    opts: RunOpts;
  }) => { verdict: Record<string, unknown>; metric?: Record<string, unknown>; output?: string };
}

async function runScenario(options: ScenarioOptions): Promise<{
  final: Awaited<ReturnType<typeof runWorkflow>>;
  runDirPath: string;
  gateCalls: number;
  repairCalls: number;
  planCalls: number;
  gatePrompts: string[];
}> {
  const { config, yaml } = workflow(options.maxIterations ?? 1);
  let gateCalls = 0;
  let repairCalls = 0;
  let planCalls = 0;
  const gatePrompts: string[] = [];
  const adapter: Adapter = {
    async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') {
        return { output: '## Gate attempt contract fixture', exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === 'plan') {
        planCalls += 1;
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), dispatchYaml(options.includeRepair === true));
        if (options.contract) {
          writeFileSync(join(opts.runDir, 'gate_contract.json'), JSON.stringify(options.contract, null, 2) + '\n');
        }
        return { output: `plan ${planCalls}`, exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === GATE_ID) {
        gateCalls += 1;
        gatePrompts.push(prompt);
        const attempt = options.gateAttempt({ call: gateCalls, prompt, opts });
        writeFileSync(
          join(opts.runDir, `verdict_${GATE_ID}.json`),
          JSON.stringify(attempt.verdict, null, 2) + '\n',
        );
        if (attempt.metric) {
          writeFileSync(
            join(opts.runDir, 'stages', GATE_ID, 'metric.json'),
            JSON.stringify(attempt.metric, null, 2) + '\n',
          );
        }
        return { output: attempt.output ?? `gate ${gateCalls}`, exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === REPAIR_ID) {
        repairCalls += 1;
        return { output: `repair ${repairCalls}`, exitCode: 0, duration_ms: 1 };
      }
      return { output: `unexpected ${opts.stageId}`, exitCode: 1, duration_ms: 1 };
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
    'Gate attempt freshness contract fixture with no declared metric.',
    true,
  );
  return {
    final,
    runDirPath: runDir(projectDir, final.runId),
    gateCalls,
    repairCalls,
    planCalls,
    gatePrompts,
  };
}

function failingMetric(): Record<string, unknown> {
  return {
    hasMetric: true,
    metric: 'quality',
    value: 0,
    threshold: 1,
    higherIsBetter: true,
    pass: false,
    source: { path: 'fixture', evidence: 'quality=0' },
  };
}

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  root = join(tmpdir(), `flowcrew-gate-attempt-${randomBytes(6).toString('hex')}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  writeFileSync(
    join(projectDir, 'config', 'defaults.yaml'),
    readFileSync(join(REPOSITORY_ROOT, 'config', 'defaults.yaml')),
  );
  setFcGlobalDir(join(root, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcHome);
  rmSync(root, { recursive: true, force: true });
});

describe('per-attempt gate metric contract', () => {
  it('accepts a qualitative gate with no metric declaration or worker-authored metric', async () => {
    const result = await runScenario({
      gateAttempt: () => ({ verdict: { pass: true, reason: 'qualitative audit passed' } }),
    });

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(1);
    expect(JSON.parse(readFileSync(
      join(result.runDirPath, 'stages', GATE_ID, 'metric.json'),
      'utf-8',
    ))).toMatchObject({ hasMetric: false, source: { kind: 'engine_attempt_default' } });
  });

  it('replaces a prior iteration failing metric before a new passing gate writes no metric', async () => {
    const result = await runScenario({
      maxIterations: 2,
      gateAttempt: ({ call }) => call === 1
        ? { verdict: { pass: false, reason: 'iteration one rejected' }, metric: failingMetric() }
        : { verdict: { pass: true, reason: 'iteration two qualitative audit passed' } },
    });

    expect(result.gateCalls).toBe(2);
    expect(result.final.status).toBe('complete');
    expect(readGateVerdict(projectDir, GATE_ID, result.final.runId)).toMatchObject({ pass: true });
    expect(JSON.parse(readFileSync(
      join(result.runDirPath, 'stages', GATE_ID, 'metric.json'),
      'utf-8',
    ))).toMatchObject({ hasMetric: false, source: { kind: 'engine_attempt_default' } });
  });

  it('still rejects a current attempt that contradicts its own failing metric', async () => {
    const result = await runScenario({
      gateAttempt: () => ({
        verdict: { pass: true, reason: 'dishonest pass' },
        metric: failingMetric(),
      }),
    });

    expect(result.final.status).not.toBe('complete');
    expect(readGateVerdict(projectDir, GATE_ID, result.final.runId)).toEqual({
      pass: false,
      reason: 'verdict/metric.json mismatch: metric says fail, verdict says pass',
    });
  });

  it('gives a rejecting gate a durable verdict citation that exists after archiving', async () => {
    let citedPath = '';
    const result = await runScenario({
      gateAttempt: ({ prompt }) => {
        citedPath = /Durable rejected-verdict citation: (.+\.json)/.exec(prompt)?.[1] ?? '';
        return {
          verdict: { pass: false, reason: 'substantive rejection' },
          output: `Rejected. Verdict evidence: ${citedPath || 'missing durable citation'}`,
        };
      },
    });

    const expected = join(
      result.runDirPath,
      'gate_reevaluation',
      'iteration_1',
      'round_1',
      `rejected_verdict_${GATE_ID}.json`,
    );
    expect(citedPath).toBe(expected);
    expect(readFileSync(join(result.runDirPath, 'stages', GATE_ID, 'output.md'), 'utf-8')).toContain(expected);
    expect(existsSync(expected)).toBe(true);
    expect(JSON.parse(readFileSync(expected, 'utf-8'))).toMatchObject({ pass: false });
  });

  it('refuses a scored gate missing its required numeric value without dispatching product repair', async () => {
    const result = await runScenario({
      maxIterations: 2,
      includeRepair: true,
      contract: { metric: 'quality', threshold: 10, higherIsBetter: true },
      gateAttempt: () => ({
        verdict: { pass: true, reason: 'claimed pass without a measured value', metric: 'quality' },
      }),
    });

    expect(result.final.status).toBe('failed');
    expect(result.final.failureReason).toContain('missing required numeric gate value');
    expect(result.final.failureReason).toContain('metric="quality"');
    expect(result.final.failureReason).toContain('threshold=10');
    expect(result.planCalls).toBe(1);
    expect(result.gateCalls).toBe(1);
    expect(result.repairCalls).toBe(0);
  });
});
