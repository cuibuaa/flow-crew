import { fixtureResult } from './test-support/declared-dispatch.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { findAllReady, inspectRealityCheckReachability, runWorkflow, selectRunnableBatch, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';
import { artifacts, producedRead } from './spec_contracts/declared-fixtures.js';
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
  const merged = proposed.dispatch;
  const entries = (parseYaml(merged) as { stages: Array<Record<string, unknown>> }).stages;
  const stages = entries.map((entry): StageConfig => ({ criterion_refs: [], artifact_contract: artifacts(entry.is_gate === true ? [{ id: 'verdict', root: 'run', path: `verdict_${String(entry.id)}.json` }] : entry.id === 'write_report' ? [{ id: 'report', root: 'project', path: 'docs/report.md' }] : [], [], []),
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

  it('keeps a declared report writer runnable when the repaired gate rejects', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-b-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const { stages } = writerCase();
      const markdown = '## Reality checks\n```yaml\nchecks:\n  - name: report-exists\n    type: file-exists-nonempty\n    reads: [{id: report, root: project, path: docs/report.md, source: {kind: stage, stage: write_report, artifact: report}}]\n    params:\n      paths: [docs/report.md]\n```\n';
      expect(parseChecksFromMarkdown(markdown)).toHaveLength(1);
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

  it('lets a non-gate qa stage with a passing verdict release its dependents without a validation delta', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-audit-b-nongate-'));
    const previousHome = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const runId = 'nongate-verdict-fixture';
      const dir = runDir(projectDir, runId);
      mkdirSync(dir, { recursive: true });
      // A run-local validation baseline exists, but no delta: deltas are recorded
      // only when a declared gate completes.
      writeFileSync(join(dir, 'validation_baseline.json'), '{"version":1}\n');
      writeFileSync(join(dir, 'verdict_baseline.json'), '{"pass":true,"reason":"baseline captured"}\n');
      const stage = (id: string, extra: Record<string, unknown>) => ({ artifact_contract: artifacts([], [], []),
        id, role: 'coder', depends_on: [], dependency_reasons: {}, scope: [], criterion_refs: [],
        skills: [], prompt_template: id, is_gate: false, ...extra,
      });
      const work = stage('work', { depends_on: ['baseline'], dependency_reasons: { baseline: 'needs the baseline' } });
      const state = {
        projectDir, runId,
        stages: { baseline: { status: 'complete' }, work: { status: 'pending' } },
      };
      const asStages = (items: unknown[]) => items as Parameters<typeof findAllReady>[0];
      const nonGate = asStages([stage('baseline', { role: 'qa' }), work]);
      expect(findAllReady(nonGate, state as Parameters<typeof findAllReady>[1]).map((s) => s.id)).toContain('work');
      // Control: a declared gate with the same verdict still needs its bound delta.
      const declaredGate = asStages([stage('baseline', { role: 'qa', is_gate: true }), work]);
      expect(findAllReady(declaredGate, state as Parameters<typeof findAllReady>[1]).map((s) => s.id)).not.toContain('work');
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
});
