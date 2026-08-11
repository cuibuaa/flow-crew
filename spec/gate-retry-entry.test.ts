import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { routeLogsToFile } from '../src/logging.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const metricReadControl = vi.hoisted(() => ({
  path: '',
  reads: 0,
  staleReads: 0,
  stale: '',
  passing: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: unknown) {
      if (metricReadControl.path && String(path) === metricReadControl.path) {
        metricReadControl.reads++;
        const text = metricReadControl.reads <= metricReadControl.staleReads
          ? metricReadControl.stale
          : metricReadControl.passing;
        return options === undefined ? Buffer.from(text) : text;
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options);
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, '..');
const GATE_ID = 'verify_e18';
const REPAIR_ID = 'fix_e18';
const UNRELATED_GATE_ID = 'verify_unrelated';

let root: string;
let projectDir: string;
let previousFcHome: string;
let restoreLogs: (() => void) | undefined;

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
    config: {
      name: 'e18-gate-retry-entry',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [],
        scope: ['src/scheduler.ts', 'spec/e18-gate-retry-entry.test.ts', 'docs/task_summary.md'],
        prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false,
      }],
    },
  };
}

function dispatchYaml(includeUnrelatedRejectedGate = false): string {
  return [
    'stages:',
    `  - id: ${GATE_ID}`,
    '    role: qa',
    '    scope: [src/scheduler.ts, spec/e18-gate-retry-entry.test.ts, tests/e18-gate-retry-entry.test.ts]',
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
    ] : []),
    `  - id: ${REPAIR_ID}`,
    '    role: repair',
    '    scope: [src/scheduler.ts, spec/e18-gate-retry-entry.test.ts, docs/task_summary.md]',
    `    depends_on: [${GATE_ID}]`,
    `    dependency_reasons: {${GATE_ID}: "repair only an explicit E18 rejection"}`,
    `    retry_to: [${GATE_ID}]`,
    '    task: repair E18',
  ].join('\n');
}

interface ScenarioOptions {
  gatePasses: boolean[];
  staleMetricReads?: number;
  logPath?: string;
  includeUnrelatedRejectedGate?: boolean;
}

async function runScenario(options: ScenarioOptions): Promise<{
  final: Awaited<ReturnType<typeof runWorkflow>>;
  runDirPath: string;
  gateCalls: number;
  repairCalls: number;
  repairSawArchivedNegative: boolean;
}> {
  const { config, yaml } = workflow();
  let gateCalls = 0;
  let repairCalls = 0;
  let repairSawArchivedNegative = false;
  if (options.logPath) restoreLogs = routeLogsToFile(options.logPath);
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') {
        return { output: '## E18 fixture summary', exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === 'plan') {
        writeFileSync(
          join(opts.runDir, 'dispatch.yaml'),
          dispatchYaml(options.includeUnrelatedRejectedGate),
        );
        return { output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      if (opts.stageId === GATE_ID) {
        const pass = options.gatePasses[Math.min(gateCalls, options.gatePasses.length - 1)];
        gateCalls++;
        writeFileSync(
          join(opts.runDir, `verdict_${GATE_ID}.json`),
          JSON.stringify(scoredVerdict(pass, pass ? 'accepted' : 'explicit rejection'), null, 2) + '\n',
        );
        const metricPath = join(opts.runDir, 'stages', GATE_ID, 'metric.json');
        writeFileSync(metricPath, JSON.stringify(metricArtifact(pass), null, 2) + '\n');
        if (options.staleMetricReads !== undefined && gateCalls === 1) {
          Object.assign(metricReadControl, {
            path: metricPath,
            reads: 0,
            staleReads: options.staleMetricReads,
            stale: JSON.stringify(metricArtifact(false)),
            passing: JSON.stringify(metricArtifact(true)),
          });
        }
        return { output: `gate ${gateCalls}: ${pass}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      if (opts.stageId === UNRELATED_GATE_ID) {
        writeFileSync(
          join(opts.runDir, `verdict_${UNRELATED_GATE_ID}.json`),
          JSON.stringify(scoredVerdict(false, 'unrelated rejection'), null, 2) + '\n',
        );
        return { output: 'unrelated gate: false', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
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
        return { output: 'repair executed', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      return { output: `unexpected stage ${opts.stageId}`, exitCode: 1, duration_ms: 1 };
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
    'E18 scheduler-level integration fixture',
    true,
  );
  if (restoreLogs) {
    restoreLogs();
    restoreLogs = undefined;
  }
  return { final, runDirPath: runDir(projectDir, final.runId), gateCalls, repairCalls, repairSawArchivedNegative };
}

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  root = mkdtempSync(join(tmpdir(), `flowcrew-e18-${randomBytes(4).toString('hex')}-`));
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  writeFileSync(
    join(projectDir, 'config', 'defaults.yaml'),
    readFileSync(join(REPOSITORY_ROOT, 'config', 'defaults.yaml')),
  );
  setFcGlobalDir(join(root, 'fc-home'));
  Object.assign(metricReadControl, { path: '', reads: 0, staleReads: 0, stale: '', passing: '' });
});

afterEach(() => {
  restoreLogs?.();
  restoreLogs = undefined;
  Object.assign(metricReadControl, { path: '', reads: 0, staleReads: 0, stale: '', passing: '' });
  setFcGlobalDir(previousFcHome);
  rmSync(root, { recursive: true, force: true });
});

describe('gate retry loop entry', () => {
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
    expect(existsSync(join(
      result.runDirPath,
      'gate_reevaluation',
      'iteration_1',
      'round_2',
    ))).toBe(false);
  });

  it('uses a fresh round-zero entrance read instead of reaching the dispatch guard', async () => {
    const logPath = join(root, 'mechanism.log');
    const result = await runScenario({ gatePasses: [true], staleMetricReads: 2, logPath });
    const logs = readFileSync(logPath, 'utf-8');

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(1);
    expect(result.repairCalls).toBe(0);
    expect(result.final.stages[REPAIR_ID]?.status).toBe('skipped');
    expect(logs).toContain('"event":"gate_retry_entry_check"');
    expect(logs).toContain('"source":"fresh-runtime-collection","allPass":true');
    expect(logs).toContain('"decision":"break"');
    expect(logs).not.toContain('"event":"gate_retry_dispatch_guard"');
    expect(existsSync(join(result.runDirPath, 'gate_reevaluation'))).toBe(false);
  });

  it('re-reads related verdicts at the dispatch point and blocks a stale entrance', async () => {
    const logPath = join(root, 'guard.log');
    const result = await runScenario({ gatePasses: [true], staleMetricReads: 4, logPath });
    const logs = readFileSync(logPath, 'utf-8');

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(1);
    expect(result.repairCalls).toBe(0);
    expect(logs).toContain('"event":"gate_retry_dispatch_guard"');
    expect(logs).toContain('"decision":"skip-repair-dispatch"');
    expect(JSON.parse(readFileSync(join(result.runDirPath, `verdict_${GATE_ID}.json`), 'utf-8'))).toMatchObject({ pass: true });
    expect(existsSync(join(result.runDirPath, 'gate_reevaluation'))).toBe(false);
  });

  it('keeps policy-aware metric rejection authoritative at the dispatch guard', async () => {
    const result = await runScenario({ gatePasses: [true, true], staleMetricReads: 6 });

    expect(result.final.status).toBe('complete');
    expect(result.gateCalls).toBe(2);
    expect(result.repairCalls).toBe(1);
    expect(result.final.stages[REPAIR_ID]?.status).toBe('complete');
    expect(JSON.parse(readFileSync(join(
      result.runDirPath,
      'gate_reevaluation',
      'iteration_1',
      'round_1',
      `rejected_verdict_${GATE_ID}.json`,
    ), 'utf-8'))).toMatchObject({ pass: true });
  });

  it('guards a related pass even while an unrelated gate remains rejected', async () => {
    const logPath = join(root, 'related-only-guard.log');
    const result = await runScenario({
      gatePasses: [true],
      staleMetricReads: 6,
      logPath,
      includeUnrelatedRejectedGate: true,
    });
    const logs = readFileSync(logPath, 'utf-8');

    expect(result.repairCalls).toBe(0);
    expect(logs).toContain(`"activeGateIds":["${GATE_ID}"]`);
    expect(logs).toContain('"decision":"skip-repair-dispatch"');
    expect(JSON.parse(readFileSync(join(result.runDirPath, `verdict_${GATE_ID}.json`), 'utf-8'))).toMatchObject({ pass: true });
    const archiveDir = join(result.runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
    expect(existsSync(join(archiveDir, `rejected_verdict_${GATE_ID}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(
      join(archiveDir, `rejected_verdict_${UNRELATED_GATE_ID}.json`),
      'utf-8',
    ))).toMatchObject({ pass: false, reason: 'unrelated rejection' });
  });
});
