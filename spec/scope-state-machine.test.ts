import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

let projectDir: string;
let isolatedStateDir: string;
let previousStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-m3-project-'));
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'flowcrew-m3-state-'));
  previousStateDir = fcGlobalDir();
  setFcGlobalDir(isolatedStateDir);
});

afterEach(() => {
  setFcGlobalDir(previousStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

function writeRoles(...names: string[]): string {
  const directory = join(projectDir, 'config', 'agents');
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    writeFileSync(join(directory, `${name}.yaml`), [
      `name: ${name}`,
      'description: synthetic M3 fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: fixture',
    ].join('\n'));
  }
  return directory;
}

function prepareRun(config: WorkflowConfig, yaml: string) {
  const created = createRun(projectDir, config.name, yaml, config.stages.map((stage) => stage.id));
  writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.maxRetries = 2;
  writeRunState(projectDir, created.runId, state);
  return created;
}

function summaryResult(opts: RunOpts): RunResult | undefined {
  return opts.stageId === '_summary' ? { output: 'summary', exitCode: 0, duration_ms: 1 } : undefined;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
}

async function waitForDecision(directory: string): Promise<Record<string, any>> {
  return waitForPathEvent(directory, () => {
    const decision = readdirSync(directory).find((file) => file.startsWith('scope_revision_decision_') && file.endsWith('.json'));
    if (decision) return readJson(join(directory, decision));
    return undefined;
  });
}

function singleStageWorkflow(input: { gate: boolean; scopePresent: boolean; name: string }): { config: WorkflowConfig; yaml: string } {
  const role = input.gate ? 'qa' : 'coder';
  const scope = input.scopePresent ? ['src/declared.ts'] : undefined;
  const stage = {
    id: 'subject', role, depends_on: [], prompt_template: 'M3 matrix fixture', skills: [],
    dynamic_dispatch: false, is_gate: input.gate, ...(scope ? { scope } : {}),
  };
  const config: WorkflowConfig = {
    name: input.name,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [stage],
  };
  const yaml = [
    `name: ${input.name}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: subject',
    `    role: ${role}`,
    ...(scope ? ['    scope: [src/declared.ts]'] : []),
    ...(input.gate ? ['    is_gate: true'] : []),
    '    prompt_template: M3 matrix fixture',
  ].join('\n');
  return { config, yaml };
}

const matrixCells = (['ordinary', 'gate'] as const).flatMap((stageKind) =>
  (['missing', 'present'] as const).flatMap((scopePresence) =>
    (['accepted', 'rejected'] as const).map((decision) => ({ stageKind, scopePresence, decision }))),
);

describe('eight-cell atomic scope state matrix', () => {
  it.each(matrixCells)(
    '$stageKind × scope $scopePresence × $decision',
    { timeout: 15_000 },
    async ({ stageKind, scopePresence, decision }) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared preimage\n');
      const gate = stageKind === 'gate';
      const scopePresent = scopePresence === 'present';
      const { config, yaml } = singleStageWorkflow({ gate, scopePresent, name: `m3-${stageKind}-${scopePresence}-${decision}` });
      const created = prepareRun(config, yaml);
      const requestedPath = 'src/requested.ts';
      const outsidePath = 'src/outside.ts';
      const requestedPaths = [requestedPath];
      const prewriteCase = stageKind === 'ordinary' && scopePresence === 'missing' && decision === 'rejected';
      const adapter: Adapter = { async run(prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return summary;
        expect(prompt).toContain(`(declaration ${scopePresence})`);
        expect(prompt).toContain('A missing declaration is closed, never allow-all');
        if (gate) expect(prompt).toContain('Gate project writes remain subject to isolation policy');
        const directory = join(opts.runDir, 'stages', opts.stageId);
        if (prewriteCase) writeFileSync(join(projectDir, requestedPath), 'write before request must not be ratified\n');
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1,
          kind: 'scope_revision',
          requestId: `${stageKind}-${scopePresence}-${decision}`,
          runId: created.runId,
          stageId: opts.stageId,
          attemptIndex: 1,
          requestedPaths,
          pathDigest: scopePathDigest(requestedPaths),
          reason: decision === 'accepted' || prewriteCase ? 'fixture requires the requested path' : '',
        }));
        const policyDecision = await waitForDecision(directory);
        expect(policyDecision).toMatchObject({
          runId: created.runId,
          stageId: opts.stageId,
          attemptIndex: 1,
          pathDigest: scopePathDigest(requestedPaths),
          decision,
          accepted: decision === 'accepted',
        });
        if (prewriteCase) expect(policyDecision.rejectionReason).toContain('changed before scope approval');
        writeFileSync(join(projectDir, requestedPath), 'requested raw write\n');
        writeFileSync(join(projectDir, outsidePath), 'outside raw write\n');
        if (gate) {
          writeFileSync(join(opts.runDir, `verdict_${opts.stageId}.json`), JSON.stringify({ pass: true, reason: 'fixture verdict stays separate from scope policy' }));
        }
        return {
          output: 'matrix raw writes complete', exitCode: 0, duration_ms: 20,
          writes: [requestedPath, outsidePath], writeAttribution: 'structured',
        };
      } };

      await runWorkflow(
        config, yaml, projectDir, adapter, new Map(), undefined,
        writeRoles('coder', 'qa'), created.runId, 'M3 matrix', true,
      );

      const status = readStageStatus(projectDir, created.runId, 'subject');
      const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
      expect(audit).toMatchObject({
        declaredScope: scopePresent ? ['src/declared.ts'] : null,
        rawWrites: [requestedPath, outsidePath],
        appliedWrites: decision === 'accepted' ? [requestedPath] : [],
        rolledBackWrites: decision === 'accepted' ? [outsidePath] : [requestedPath, outsidePath],
        rollbackFailures: [],
        durableWrites: decision === 'accepted' ? [requestedPath] : [],
      });
      expect(audit.stateTransitions).toHaveLength(1);
      expect(audit.stateTransitions[0]).toMatchObject({ stageKind, scopePresence, decision });
      expect(audit.stateTransitions[0].transitions.map((entry: Record<string, unknown>) => entry.event)).toEqual([
        scopePresent ? 'declared_scope_loaded' : 'scope_missing_closed',
        'request_produced',
        decision === 'accepted' ? 'policy_accepted' : 'policy_rejected',
        'writes_enforced',
      ]);
      expect(audit.stateTransitions[0].transitions.at(-1).durableWrites).toEqual(
        decision === 'accepted' ? [requestedPath] : [],
      );
      expect(existsSync(join(projectDir, requestedPath))).toBe(decision === 'accepted');
      expect(existsSync(join(projectDir, outsidePath))).toBe(false);
      expect(status.constraintAudit).toMatchObject({
        acceptedRevisionCount: decision === 'accepted' ? 1 : 0,
        rejectedRevisionCount: decision === 'rejected' ? 1 : 0,
        rawWriteCount: 2,
        appliedWriteCount: decision === 'accepted' ? 1 : 0,
        rolledBackWriteCount: decision === 'accepted' ? 1 : 2,
      });
    },
  );
});

async function runRejectedSnapshotMutation(mutation: 'delete' | 'deep-create') {
  const relativePath = mutation === 'delete'
    ? 'src/protected.txt'
    : 'one/two/three/four/five/six/escape.txt';
  const absolutePath = join(projectDir, relativePath);
  const original = Buffer.from('original preimage\n');
  if (mutation === 'delete') {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(absolutePath, original);
  }
  const { config, yaml } = singleStageWorkflow({
    gate: false,
    scopePresent: false,
    name: `m3-${mutation}`,
  });
  const created = prepareRun(config, yaml);
  const adapter: Adapter = { async run(_prompt, _agent, opts) {
    const summary = summaryResult(opts);
    if (summary) return summary;
    const directory = join(opts.runDir, 'stages', opts.stageId);
    writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
      version: 1, kind: 'scope_revision', requestId: `rejected-${mutation}`,
      runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
      requestedPaths: [relativePath], pathDigest: scopePathDigest([relativePath]), reason: '',
    }));
    expect(await waitForDecision(directory)).toMatchObject({ accepted: false, decision: 'rejected' });
    if (mutation === 'delete') unlinkSync(absolutePath);
    else {
      mkdirSync(join(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, 'unauthorized deep file\n');
    }
    return { output: mutation, exitCode: 0, duration_ms: 2 };
  } };

  await runWorkflow(
    config, yaml, projectDir, adapter, new Map(), undefined,
    writeRoles('coder'), created.runId, `M3 ${mutation}`, true,
  );
  const status = readStageStatus(projectDir, created.runId, 'subject');
  const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
  return { absolutePath, audit, original, relativePath };
}

describe('scheduler-authoritative full-tree enforcement', () => {
  it('rejected deletion restores an existing project file', { timeout: 15_000 }, async () => {
    const result = await runRejectedSnapshotMutation('delete');
    expect(result.audit).toMatchObject({
      rawWrites: [result.relativePath], appliedWrites: [],
      rolledBackWrites: [result.relativePath], rollbackFailures: [], durableWrites: [],
    });
    expect(readFileSync(result.absolutePath)).toEqual(result.original);
  });

  it('deep creation is removed beyond the worker snapshot depth', { timeout: 15_000 }, async () => {
    const result = await runRejectedSnapshotMutation('deep-create');
    expect(result.audit).toMatchObject({
      rawWrites: [result.relativePath], appliedWrites: [],
      rolledBackWrites: [result.relativePath], rollbackFailures: [], durableWrites: [],
    });
    expect(existsSync(result.absolutePath)).toBe(false);
  });

  it('directory prewrite is rejected before tree scope can be authorized', { timeout: 15_000 }, async () => {
    const requestedTree = 'src/';
    const prewrittenPath = 'src/prewritten.txt';
    const { config, yaml } = singleStageWorkflow({ gate: false, scopePresent: false, name: 'm3-directory-prewrite' });
    const created = prepareRun(config, yaml);
    let decision: Record<string, any> | undefined;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, prewrittenPath), 'written before requesting the tree\n');
      const directory = join(opts.runDir, 'stages', opts.stageId);
      writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
        version: 1, kind: 'scope_revision', requestId: 'directory-prewrite',
        runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
        requestedPaths: [requestedTree], pathDigest: scopePathDigest([requestedTree]),
        reason: 'request the tree only after its descendant changed',
      }));
      decision = await waitForDecision(directory);
      return {
        output: 'directory prewrite', exitCode: 0, duration_ms: 2,
        writes: [prewrittenPath], writeAttribution: 'structured',
      };
    } };

    await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'M3 directory prewrite', true,
    );
    expect(decision).toMatchObject({ accepted: false, decision: 'rejected', authorizedPaths: [] });
    expect(String(decision?.rejectionReason)).toContain(`changed before scope approval: ${prewrittenPath}`);
    const status = readStageStatus(projectDir, created.runId, 'subject');
    const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
    expect(audit).toMatchObject({
      rawWrites: [prewrittenPath], appliedWrites: [],
      rolledBackWrites: [prewrittenPath], rollbackFailures: [], durableWrites: [],
    });
    expect(existsSync(join(projectDir, prewrittenPath))).toBe(false);
  });
});

// Each entry reproduces the shape of a stage that was measured writing outside an
// undeclared scope: whether it was a gate, and how many project writes it attempted.
// The originating run identifiers stay OUT of this file on purpose — `spec/purity.ts`
// rule `real-history` forbids author-specific run history in public tests, so they are
// recorded in `docs/execution_plan.md` under the M3 empty-scope shapes table instead.
// The stage names are kept because they carry the traceability without pinning a run.
const historicalShapes = [
  { origin: 'non-gate probe stage', stage: 'probe_doc_contract', writes: 13, gate: false },
  { origin: 'gate verify stage', stage: 'verify_e13', writes: 1, gate: true },
  { origin: 'gate re-verify stage', stage: 'reverify_e13b', writes: 1, gate: true },
  { origin: 'gate verify after implement', stage: 'verify_m7', writes: 3, gate: true },
];

describe('synthetic regressions for the four measured historical QA shapes', () => {
  it.each(historicalShapes)(
    '$origin / $stage negotiates missing scope without operator supplementation',
    { timeout: 15_000 },
    async (shape) => {
      const role = shape.gate ? 'qa' : 'coder';
      const config: WorkflowConfig = {
        name: `historical-${shape.stage}`,
        defaults: { max_iterations: 1, max_retries: 0 },
        stages: [{
          id: shape.stage, role, depends_on: [], prompt_template: `synthetic shape ${shape.origin}`,
          skills: [], dynamic_dispatch: false, is_gate: shape.gate,
        }],
      };
      const yaml = [
        `name: historical-${shape.stage}`, 'defaults:', '  max_iterations: 1', '  max_retries: 0',
        'stages:', `  - id: ${shape.stage}`, `    role: ${role}`,
        ...(shape.gate ? ['    is_gate: true'] : []),
        `    prompt_template: synthetic shape ${shape.origin}`,
      ].join('\n');
      const created = prepareRun(config, yaml);
      const requestedPaths = Array.from({ length: shape.writes }, (_, index) => `synthetic/${shape.stage}/write_${index + 1}.txt`);
      const canonicalPaths = [...requestedPaths].sort();
      const adapter: Adapter = { async run(prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return summary;
        expect(prompt).toContain('Declared project-write scope: [] (declaration missing)');
        expect(prompt).toContain(`"runId":"${created.runId}"`);
        const directory = join(opts.runDir, 'stages', opts.stageId);
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: `synthetic-${shape.stage}`,
          runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
          requestedPaths, pathDigest: scopePathDigest(requestedPaths),
          reason: `stage autonomously declares the ${shape.writes} synthetic project writes`,
        }));
        const decision = await waitForDecision(directory);
        expect(decision).toMatchObject({ accepted: true, requestedPaths: canonicalPaths });
        for (const path of requestedPaths) {
          mkdirSync(join(projectDir, path, '..'), { recursive: true });
          writeFileSync(join(projectDir, path), `${shape.origin}\n`);
        }
        if (shape.gate) {
          writeFileSync(join(opts.runDir, `verdict_${opts.stageId}.json`), JSON.stringify({ pass: true, reason: 'synthetic historical shape passed' }));
        }
        return { output: 'autonomous scope negotiated', exitCode: 0, duration_ms: 20, writes: requestedPaths, writeAttribution: 'structured' };
      } };

      const final = await runWorkflow(
        config, yaml, projectDir, adapter, new Map(), undefined,
        writeRoles('coder', 'qa'), created.runId, `synthetic ${shape.origin}`, true,
      );
      expect(final.status).toBe('complete');
      const status = readStageStatus(projectDir, created.runId, shape.stage);
      expect(status.constraintAudit).toMatchObject({
        declaredScope: null,
        effectiveScope: canonicalPaths,
        acceptedRevisionCount: 1,
        rejectedRevisionCount: 0,
        violationCount: 0,
        rawWriteCount: shape.writes,
        appliedWriteCount: shape.writes,
      });
      expect(requestedPaths.every((path) => existsSync(join(projectDir, path)))).toBe(true);
    },
  );
});

describe('rejected digest handoff across planner iterations', () => {
  it.each(['resolve', 'defer'] as const)(
    'publishes one digest and records planner %s on iteration two',
    { timeout: 25_000 },
    async (disposition) => {
      const config: WorkflowConfig = {
        name: `m3-two-iteration-${disposition}`,
        defaults: { max_iterations: 2, max_retries: 0 },
        stages: [{
          id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [],
          dynamic_dispatch: true, is_gate: false,
        }],
      };
      const yaml = [
        `name: m3-two-iteration-${disposition}`, 'defaults:', '  max_iterations: 2', '  max_retries: 0',
        'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
      ].join('\n');
      const created = prepareRun(config, yaml);
      const requestedPath = 'src/pending.ts';
      let planCalls = 0;
      let observedDigest = '';
      const adapter: Adapter = { async run(prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return summary;
        if (opts.stageId === 'plan') {
          planCalls++;
          if (planCalls === 1) {
            writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
              'stages:',
              '  - id: work_1', '    role: coder', '    scope: []', '    depends_on: [plan]',
              '    dependency_reasons: {plan: "consume the first planner iteration"}', '    task: produce one rejected scope digest',
              '  - id: review_gate_1', '    role: qa', '    scope: []', '    depends_on: [work_1]',
              '    dependency_reasons: {work_1: "review the first iteration work"}',
              '    is_gate: true', '    task: first iteration gate',
            ].join('\n'));
          } else {
            const inputName = readdirSync(opts.runDir).find((file) => file.startsWith('scope_negotiation_input_'));
            if (!inputName) throw new Error('iteration two did not receive a scope planning input artifact');
            observedDigest = String(readJson(join(opts.runDir, inputName)).digest);
            expect(prompt).toContain('# Pending scope-negotiation planning input');
            expect(prompt).toContain(observedDigest);
            expect(prompt).toContain('# Engine-owned unresolved stage obligations');
            expect(prompt).toContain('review_gate_1');
            const scopeLine = disposition === 'resolve' ? `    scope: [${requestedPath}]` : '    scope: []';
            writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
              'scope_negotiation:',
              '  defer:',
              ...(disposition === 'defer' ? [`    - ${observedDigest}`] : []),
              'stages:',
              '  - id: work_2', '    role: coder', scopeLine, '    depends_on: [plan]',
              '    dependency_reasons: {plan: "consume the second planner iteration"}', '    task: disposition consumer',
              '  - id: review_gate_2', '    role: qa', '    scope: []', '    depends_on: [work_2]',
              '    dependency_reasons: {work_2: "review the disposition consumer"}',
              '    is_gate: true', '    task: second iteration gate',
            ].join('\n'));
          }
          return { output: `planner iteration ${planCalls}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
        }
        if (opts.stageId === 'work_1') {
          const directory = join(opts.runDir, 'stages', opts.stageId);
          writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
            version: 1, kind: 'scope_revision', requestId: 'one-rejected-digest', runId: created.runId,
            stageId: opts.stageId, attemptIndex: 1, requestedPaths: [requestedPath],
            pathDigest: scopePathDigest([requestedPath]), reason: '',
          }));
          const decision = await waitForDecision(directory);
          expect(decision).toMatchObject({ accepted: false, decision: 'rejected' });
          mkdirSync(join(projectDir, 'src'), { recursive: true });
          writeFileSync(join(projectDir, requestedPath), 'must be rolled back\n');
          return { output: 'one rejected raw write', exitCode: 0, duration_ms: 20, writes: [requestedPath], writeAttribution: 'structured' };
        }
        if (opts.stageId === 'work_2') {
          if (disposition === 'resolve') {
            mkdirSync(join(projectDir, 'src'), { recursive: true });
            writeFileSync(join(projectDir, requestedPath), 'planner predeclared resolution\n');
            return { output: 'resolved', exitCode: 0, duration_ms: 2, writes: [requestedPath], writeAttribution: 'structured' };
          }
          return { output: 'deferred without a project write', exitCode: 0, duration_ms: 2, writes: [], writeAttribution: 'structured' };
        }
        if (opts.stageId === 'review_gate_2') {
          writeFileSync(join(opts.runDir, 'verdict_review_gate_2.json'), JSON.stringify({ pass: true, reason: 'digest disposition recorded' }));
          return { output: 'pass', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
        }
        return { output: 'blocked first-iteration gate should not run', exitCode: 1, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      } };

      const final = await runWorkflow(
        config, yaml, projectDir, adapter, new Map(), undefined,
        writeRoles('planner', 'coder', 'qa'), created.runId, 'two iteration M3 fixture', true,
      );
      expect(final.status).toBe('complete');
      expect(final.unresolvedStageObligations).toBeUndefined();
      expect(planCalls).toBe(2);
      expect(observedDigest).not.toBe('');
      const inputFiles = readdirSync(created.runDirPath).filter((file) => file.startsWith('scope_negotiation_input_'));
      const dispositionFiles = readdirSync(created.runDirPath).filter((file) => file.startsWith('scope_negotiation_disposition_'));
      expect(inputFiles).toHaveLength(1);
      expect(dispositionFiles).toHaveLength(1);
      expect(readJson(join(created.runDirPath, dispositionFiles[0]))).toMatchObject({
        digest: observedDigest,
        iteration: 2,
        disposition,
      });
      const firstAuditStatus = readStageStatus(projectDir, created.runId, 'work_1');
      const firstAudit = readJson(join(created.runDirPath, firstAuditStatus.constraintAudit!.path));
      expect(firstAudit.planningDigests).toEqual([observedDigest]);
      expect(firstAudit.violations).toHaveLength(1);
      const secondAuditStatus = readStageStatus(projectDir, created.runId, 'work_2');
      const secondAudit = readJson(join(created.runDirPath, secondAuditStatus.constraintAudit!.path));
      expect(secondAudit.planningDigests).toEqual([]);
      expect(secondAudit.violations).toEqual([]);
      expect(readFileSync(join(created.runDirPath, 'iteration_log.md'), 'utf-8')).toContain(observedDigest);
      expect(existsSync(join(projectDir, requestedPath))).toBe(disposition === 'resolve');
    },
  );
});
