import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mergePlanRetryPair } from '../src/plan-retry-monotone.js';
import { captureStageArtifactContractPreimages, inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { findAllReady, inspectRealityCheckReachability, runWorkflow, selectRunnableBatch, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

const writerCase = (gateNeedsReport = true) => {
  const gateScope = gateNeedsReport ? 'docs/cache.json' : 'src/validation.json';
  const gatePrompt = gateNeedsReport ? 'Validate docs/report.md.' : 'Validate src/fix.ts.';
  const proposedGateDependency = gateNeedsReport ? 'write_report' : 'trial_fix';
  const incumbent = { dispatch: `stages:
  - id: trial_fix
    role: coder
    scope: [src/fix.ts]
  - id: audit_cache
    role: qa
    is_gate: true
    depends_on: [trial_fix]
    scope: [${gateScope}, .cache/**]
    prompt_template: ${gatePrompt}
  - id: write_report
    role: coder
    depends_on: [audit_cache]
    condition: audit_cache.pass == true
    scope: [docs/report.md, .cache/**]
` };
  const proposed = { dispatch: `stages:
  - id: trial_fix
    role: coder
    scope: [src/fix.ts]
  - id: audit_cache
    role: qa
    is_gate: true
    depends_on: [${proposedGateDependency}]
    scope: [${gateScope}, .cache/**]
    prompt_template: ${gatePrompt}
  - id: write_report
    role: coder
    depends_on: [trial_fix]
    scope: [docs/report.md, .cache/**]
` };
  const refusal = [{
    id: 'reality-check:report-exists', source: 'admission' as const,
    detail: 'reality check "report-exists" references absent docs/report.md, but every producer is conditional or repair-only',
  }];
  const merged = mergePlanRetryPair(incumbent, proposed, refusal).pair.dispatch;
  const entries = (parseYaml(merged) as { stages: Array<Record<string, unknown>> }).stages;
  const stages = entries.map((entry): StageConfig => ({
    id: String(entry.id), role: String(entry.role),
    scope: entry.scope as string[],
    depends_on: (entry.depends_on as string[] | undefined) ?? [],
    condition: entry.condition as string | undefined,
    retry_to: entry.retry_to as string[] | undefined,
    is_gate: entry.is_gate === true,
    prompt_template: String(entry.prompt_template ?? 'fixture'), skills: [], dynamic_dispatch: false,
  }));
  return { merged, stages };
};

describe('engine boundary audit probes', () => {
  it('credits a required file written before acceptance when re-dispatch reuses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-a-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 10000\n');
      writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'),
        'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
      const stage: StageConfig = {
        id: 'writer', role: 'coder', scope: ['docs/report.md'], depends_on: [],
        prompt_template: 'Write docs/report.md.', skills: [], dynamic_dispatch: false, is_gate: false,
      };
      const config: WorkflowConfig = {
        name: 'reuse-before-boundary', defaults: { max_iterations: 1, max_retries: 0 }, stages: [stage],
      };
      const yaml = 'name: reuse-before-boundary\ndefaults:\n  max_iterations: 1\n  max_retries: 0\nstages:\n  - id: writer\n    role: coder\n    scope: [docs/report.md]\n    prompt_template: Write docs/report.md.\n';
      const created = createRun(projectDir, config.name, yaml, ['writer']);
      writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
      const state = readRunState(projectDir, created.runId);
      state.autoApprove = true;
      state.maxRetries = 0;
      writeRunState(projectDir, created.runId, state);
      const calls: number[] = [];
      const adapter = { async run(_prompt: string, _role: unknown, opts: {
        stageId: string; runDir: string; attemptIndex: number; abortSignal?: AbortSignal;
        onCommandLifecycle?: (event: {
          phase: 'started' | 'completed'; id: string; command: string; timestamp: string;
        }) => void;
      }) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        calls.push(opts.attemptIndex);
        const reportPath = join(projectDir, 'docs', 'report.md');
        if (calls.length === 1) {
          writeFileSync(reportPath, 'completed before acceptance\n');
          const stageDir = join(opts.runDir, 'stages', opts.stageId);
          writeFileSync(join(stageDir, 'scope_revision_request.json'), JSON.stringify({
            version: 1, kind: 'scope_revision', requestId: randomBytes(16).toString('hex'),
            runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
            requestedPaths: ['src/extra.ts'], pathDigest: scopePathDigest(['src/extra.ts']),
            reason: 'later source output needs scope',
          }));
          const decision = await waitForPathEvent(stageDir, () => {
            const name = readdirSync(stageDir).find((file) =>
              file.startsWith('scope_revision_decision_') && file.endsWith('.json'));
            return name ? JSON.parse(readFileSync(join(stageDir, name), 'utf8')) as { accepted: boolean } : undefined;
          });
          expect(decision.accepted).toBe(true);
          const event = { id: 'tool_1', command: 'read report', timestamp: new Date().toISOString() };
          opts.onCommandLifecycle?.({ ...event, phase: 'started' });
          opts.onCommandLifecycle?.({ ...event, phase: 'completed' });
          return { output: 'boundary', exitCode: 137, duration_ms: 1,
            writes: ['docs/report.md'], writeAttribution: 'structured' as const };
        }
        expect(readFileSync(reportPath, 'utf8')).toBe('completed before acceptance\n');
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src', 'extra.ts'), 'export const extra = true;\n');
        return { output: 'reused report', exitCode: 0, duration_ms: 1,
          writes: ['src/extra.ts'], writeAttribution: 'structured' as const };
      } };
      const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined,
        join(projectDir, 'config', 'agents'), created.runId, 'reuse fixture', true);
      const violations = readRunEvents(projectDir, created.runId)
        .filter((event) => event.type === 'stage_artifact_contract_violation');
      expect({ status: final.status, calls, violations: violations.length })
        .toEqual({ status: 'complete', calls: [1, 2], violations: 0 });
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a declared report writer runnable when the repaired gate rejects', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-b-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const { stages } = writerCase();
      const markdown = '```yaml\nchecks:\n  - name: report-exists\n    type: file-exists-nonempty\n    params:\n      paths: [docs/report.md]\n```\n';
      expect(inspectRealityCheckReachability({ markdown, projectDir, stages })).toEqual([]);

      const runId = 'failed-gate-fixture';
      const dir = runDir(projectDir, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'verdict_audit_cache.json'), '{"pass":false,"reason":"fixture rejection"}\n');
      const state = {
        projectDir, runId,
        stages: {
          trial_fix: { status: 'complete' },
          audit_cache: { status: 'complete' },
          write_report: { status: 'pending' },
        },
      };
      expect(findAllReady(stages, state as Parameters<typeof findAllReady>[1])
        .map((stage) => stage.id)).toContain('write_report');
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits to run the report gate until its report writer completes', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-b-order-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const { stages } = writerCase();
      const runId = 'report-order-fixture';
      mkdirSync(runDir(projectDir, runId), { recursive: true });
      const state = {
        projectDir, runId,
        stages: {
          trial_fix: { status: 'complete' },
          audit_cache: { status: 'pending' },
          write_report: { status: 'pending' },
        },
      };
      const ready = findAllReady(stages, state as Parameters<typeof findAllReady>[1]);
      expect(stages.find((stage) => stage.id === 'audit_cache')?.depends_on).toContain('write_report');
      expect(selectRunnableBatch(ready).selected.map((stage) => stage.id))
        .toEqual(['write_report']);
      state.stages.write_report.status = 'complete';
      expect(selectRunnableBatch(findAllReady(stages, state as Parameters<typeof findAllReady>[1]))
        .selected.map((stage) => stage.id)).toEqual(['audit_cache']);
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an independent gate on its original prerequisite when it does not request the report', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-b-control-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const { stages } = writerCase(false);
      const runId = 'independent-gate-fixture';
      mkdirSync(runDir(projectDir, runId), { recursive: true });
      const state = {
        projectDir, runId,
        stages: {
          trial_fix: { status: 'complete' },
          audit_cache: { status: 'pending' },
          write_report: { status: 'pending' },
        },
      };
      expect(stages.find((stage) => stage.id === 'audit_cache')?.depends_on).toEqual(['trial_fix']);
      expect(stages.find((stage) => stage.id === 'audit_cache')?.prompt_template).toBe('Validate src/fix.ts.');
      const ready = findAllReady(stages, state as Parameters<typeof findAllReady>[1]);
      expect(selectRunnableBatch(ready).selected.map((stage) => stage.id)).toEqual(['audit_cache']);
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a changed run-local file without adapter write attribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-c-'));
    try {
      const projectDir = join(root, 'project');
      const runDirectory = join(root, 'run');
      mkdirSync(runDirectory, { recursive: true });
      const template = "Write this run's validation_final.json.";
      const preimages = captureStageArtifactContractPreimages({ template, projectDir, runDir: runDirectory });
      writeFileSync(join(runDirectory, 'validation_final.json'), '{"passed":true}\n');
      const result = inspectStageArtifactContract({
        stageId: 'write_report', template, projectDir, runDir: runDirectory,
        preimages, writes: [],
      });
      expect(result.violations).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not credit an unchanged preexisting run file to a new attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-c-control-'));
    try {
      const projectDir = join(root, 'project');
      const runDirectory = join(root, 'run');
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(join(runDirectory, 'validation_final.json'), '{"old":true}\n');
      const template = "Write this run's validation_final.json.";
      const preimages = captureStageArtifactContractPreimages({ template, projectDir, runDir: runDirectory });
      const result = inspectStageArtifactContract({
        stageId: 'write_report', template, projectDir, runDir: runDirectory,
        preimages, writes: [],
      });
      expect(result.violations).toEqual([expect.objectContaining({
        reason: expect.stringContaining('no attributable stage write'),
      })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
