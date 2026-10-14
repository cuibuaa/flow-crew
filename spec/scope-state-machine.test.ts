import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, RunOpts, RunResult } from '../src/adapters/base.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  fcGlobalDir,
  readStageStatus,
  setFcGlobalDir,
} from '../src/store.js';
import { scopeRevisionContract, scopeRevisionInstruction } from '../src/live-constraint-guard.js';
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
  return prepareFixtureRun(projectDir, config, yaml);
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
  const stage = { artifact_contract: fixtureArtifactContract('subject', input.gate),criterion_refs: [], 
    id: 'subject', role, depends_on: [], prompt_template: 'M3 matrix fixture', skills: [],
    dynamic_dispatch: false, is_gate: input.gate, ...(scope ? { scope } : {}),
  };
  const config: WorkflowConfig = {description: '', 
    name: input.name,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [stage, ...(input.gate ? [{ artifact_contract: fixtureArtifactContract('repair_subject'), criterion_refs: [],
      id: 'repair_subject', role: 'coder', depends_on: ['subject'], retry_to: ['subject'], scope: [],
      prompt_template: 'Repair the rejected subject.', skills: [], dynamic_dispatch: false, is_gate: false,
    }] : [])],
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
    ...(input.gate ? ['  - id: repair_subject', '    role: coder', '    scope: []', '    depends_on: [subject]',
      '    retry_to: [subject]', '    prompt_template: Repair the rejected subject.'] : []),
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
        if (summary) return fixtureResult(summary, opts);
        expect(prompt).toContain(`(declaration ${scopePresence})`);
        expect(prompt).toContain('An explicit empty declaration grants no project writes');
        expect(prompt).toContain('an omitted legacy declaration has no live scope guard');
        if (gate) expect(prompt).toContain('Gate project writes remain subject to isolation policy');
        const directory = join(opts.runDir, 'stages', opts.stageId);
        if (prewriteCase) writeFileSync(join(projectDir, requestedPath), 'write before request must not be ratified\n');
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1,
          kind: 'scope_revision',
          requestId: `${stageKind}-${scopePresence}-${decision}`,
          runId: created.runId,
          stageId: opts.stageId,
          attemptIndex: decision === 'rejected' && !prewriteCase ? 2 : 1,
          requestedPaths,
          pathDigest: scopePathDigest(requestedPaths),
          reason: decision === 'accepted' || prewriteCase ? 'fixture requires the requested path' : '',
        }));
        const policyDecision = await waitForDecision(directory);
        expect(policyDecision).toMatchObject({
          runId: created.runId,
          stageId: opts.stageId,
          attemptIndex: decision === 'rejected' && !prewriteCase ? 2 : 1,
          pathDigest: scopePathDigest(requestedPaths),
          decision,
          accepted: decision === 'accepted',
        });
        if (prewriteCase) expect(policyDecision.rejectionReason).toContain('requested content changed before scope approval');
        writeFileSync(join(projectDir, requestedPath), 'requested raw write\n');
        writeFileSync(join(projectDir, outsidePath), 'outside raw write\n');
        if (gate) {
          writeFileSync(join(opts.runDir, `fixture_verdict_${opts.stageId}.json`), JSON.stringify({ pass: true, reason: 'fixture verdict stays separate from scope policy' }));
        }
        return fixtureResult({
          output: 'matrix raw writes complete', exitCode: 0, duration_ms: 20,
          writes: [requestedPath, outsidePath], writeAttribution: 'structured',
        }, opts);
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
    if (summary) return fixtureResult(summary, opts);
    const directory = join(opts.runDir, 'stages', opts.stageId);
    writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
      version: 1, kind: 'scope_revision', requestId: `rejected-${mutation}`,
      runId: created.runId, stageId: opts.stageId, attemptIndex: 2,
      requestedPaths: [relativePath], pathDigest: scopePathDigest([relativePath]), reason: '',
    }));
    expect(await waitForDecision(directory)).toMatchObject({ accepted: false, decision: 'rejected' });
    if (mutation === 'delete') unlinkSync(absolutePath);
    else {
      mkdirSync(join(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, 'unauthorized deep file\n');
    }
    return fixtureResult({ output: mutation, exitCode: 0, duration_ms: 2 }, opts);
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
      if (summary) return fixtureResult(summary, opts);
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
      return fixtureResult({
        output: 'directory prewrite', exitCode: 0, duration_ms: 2,
        writes: [prewrittenPath], writeAttribution: 'structured',
      }, opts);
    } };

    await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'M3 directory prewrite', true,
    );
    expect(decision).toMatchObject({ accepted: false, decision: 'rejected', authorizedPaths: [] });
    expect(String(decision?.rejectionReason)).toContain(`requested content changed before scope approval: ${prewrittenPath}`);
    const status = readStageStatus(projectDir, created.runId, 'subject');
    const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
    expect(audit).toMatchObject({
      rawWrites: [prewrittenPath], appliedWrites: [],
      rolledBackWrites: [prewrittenPath], rollbackFailures: [], durableWrites: [],
    });
    expect(existsSync(join(projectDir, prewrittenPath))).toBe(false);
  });


});

describe('rejected digest retention without failure-driven restart', () => {
  it(
    'retains the pending rejected digest and rollback after the admitted work stops',
    { timeout: 25_000 },
    async () => {
      const config: WorkflowConfig = {description: '', 
        name: 'm3-stopped-digest',
        defaults: { max_iterations: 2, max_retries: 0 },
        stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [], 
          id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [],
          dynamic_dispatch: true, is_gate: false,
        }],
      };
      const yaml = [
        'name: m3-stopped-digest', 'defaults:', '  max_iterations: 2', '  max_retries: 0',
        'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
      ].join('\n');
      const created = prepareRun(config, yaml);
      const requestedPath = 'src/pending.ts';
      let planCalls = 0;
      const adapter: Adapter = { async run(_prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return fixtureResult(summary, opts);
        if (opts.stageId === 'plan') {
          planCalls++;
          writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
            'stages:',
            '  - id: work_1', '    role: coder', '    scope: []', '    depends_on: [plan]',
            '    dependency_reasons: {plan: "consume the first planner iteration"}', '    task: produce one rejected scope digest',
            '  - id: review_gate_1', '    role: qa', '    scope: []', '    depends_on: [work_1]',
            '    dependency_reasons: {work_1: "review the first iteration work"}',
            '    is_gate: true', '    task: first iteration gate',
            '  - id: repair_1', '    role: coder', '    scope: []', '    depends_on: [review_gate_1]',
            '    retry_to: [review_gate_1]', '    task: repair within the admitted scope',
          ].join('\n')));
          return fixtureResult({ output: `planner iteration ${planCalls}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
        }
        if (opts.stageId === 'work_1') {
          const directory = join(opts.runDir, 'stages', opts.stageId);
          writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
            version: 1, kind: 'scope_revision', requestId: 'one-rejected-digest', runId: created.runId,
            stageId: opts.stageId, attemptIndex: 2, requestedPaths: [requestedPath],
            pathDigest: scopePathDigest([requestedPath]), reason: '',
          }));
          const decision = await waitForDecision(directory);
          expect(decision).toMatchObject({ accepted: false, decision: 'rejected' });
          mkdirSync(join(projectDir, 'src'), { recursive: true });
          writeFileSync(join(projectDir, requestedPath), 'must be rolled back\n');
          return fixtureResult({ output: 'one rejected raw write', exitCode: 0, duration_ms: 20, writes: [requestedPath], writeAttribution: 'structured' }, opts);
        }
        return fixtureResult({ output: 'blocked first-iteration gate should not run', exitCode: 1, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      } };

      const final = await runWorkflow(
        config, yaml, projectDir, adapter, new Map(), undefined,
        writeRoles('planner', 'coder', 'qa'), created.runId, 'two iteration M3 fixture', true,
      );
      expect(final.status, final.failureReason).toBe('incomplete');
      expect(final.currentIteration).toBe(1);
      expect(planCalls).toBe(1);
      expect(final.unresolvedStageObligations).toBeDefined();
      const planningFiles = readdirSync(created.runDirPath).filter((file) => /^scope_negotiation_input_.*\.json$/.test(file));
      expect(planningFiles).toHaveLength(1);
      const observedDigest = readJson(join(created.runDirPath, planningFiles[0])).digest;
      expect(observedDigest).not.toBe('');
      const dispositionFiles = readdirSync(created.runDirPath).filter((file) => file.startsWith('scope_negotiation_disposition_'));
      expect(dispositionFiles).toEqual([]);
      const firstAuditStatus = readStageStatus(projectDir, created.runId, 'work_1');
      expect(firstAuditStatus.constraintAudit).toBeDefined();
      const firstAudit = readJson(join(created.runDirPath, firstAuditStatus.constraintAudit!.path));
      expect(firstAudit.planningDigests).toEqual([observedDigest]);
      expect(firstAudit.violations).toHaveLength(1);
      expect(firstAudit.rolledBackWrites).toEqual([requestedPath]);
      expect(firstAudit.durableWrites).toEqual([]);
      expect(existsSync(join(projectDir, requestedPath))).toBe(false);
    },
  );
});

// A revision changes the next child, while concurrently held capabilities stay held.
describe('partial revision at concurrent control boundaries', () => {
  it('continues with two safe grants, retaining peer ownership and withheld planning feedback', async () => {
    const paths = ['safe/one.txt', 'shared/one.txt', 'shared/two.txt', 'safe/two.txt'];
    const stage = (id: string, scope: string[]) => ({ id, scope, role: 'coder', depends_on: [], skills: [],
      dynamic_dispatch: false, is_gate: false, criterion_refs: [], prompt_template: 'perform independently scoped work',
      artifact_contract: fixtureArtifactContract(id) });
    const config: WorkflowConfig = { name: 'concurrent-scope', description: '',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [stage('work', []), stage('first', ['shared/one.txt']), stage('second', ['shared/two.txt'])] };
    const created = prepareRun(config, 'name: concurrent-scope\nstages: []');
    let releasePeers!: () => void;
    const peerRelease = new Promise<void>((resolve) => { releasePeers = resolve; });
    const waitingPeers = new Set<string>();
    let workCalls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      const summary = summaryResult(opts); if (summary) return fixtureResult(summary, opts);
      if (opts.stageId !== 'work') {
        waitingPeers.add(opts.stageId);
        await peerRelease;
        waitingPeers.delete(opts.stageId);
        return fixtureResult({ output: 'peer closed', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (++workCalls === 1) {
        const directory = join(opts.runDir, 'stages', 'work');
        opts.onCommandLifecycle?.({ phase: 'started', id: 'request', command: 'declare independent capabilities', timestamp: new Date().toISOString() });
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({ version: 1, kind: 'scope_revision',
          requestId: 'concurrent', runId: created.runId, stageId: 'work', attemptIndex: opts.attemptIndex,
          requestedPaths: paths, pathDigest: scopePathDigest(paths), reason: 'independent work products' }));
        const decision = await waitForDecision(directory);
        expect(waitingPeers.size).toBe(2);
        expect(decision).toMatchObject({ accepted: true, authorizedPaths: ['safe/one.txt', 'safe/two.txt'],
          rejectedPaths: ['shared/one.txt', 'shared/two.txt'], effectiveScope: ['safe/one.txt', 'safe/two.txt'] });
        opts.onCommandLifecycle?.({ phase: 'completed', id: 'request', timestamp: new Date().toISOString() });
        return fixtureResult({ output: 'closed at revision boundary', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      expect(opts.attemptIndex).toBe(2);
      expect(waitingPeers.size).toBe(2);
      expect(prompt).toContain('Declared project-write scope: ["safe/one.txt","safe/two.txt"]');
      expect(prompt).not.toContain('This attempt stops at the control boundary');
      mkdirSync(join(projectDir, 'safe'), { recursive: true });
      for (const path of ['safe/one.txt', 'safe/two.txt']) writeFileSync(join(projectDir, path), 'safe grant\n');
      releasePeers();
      return fixtureResult({ output: 'safe subset produced; withheld paths require planning', exitCode: 0, duration_ms: 1,
        writes: ['safe/one.txt', 'safe/two.txt'], writeAttribution: 'structured' }, opts);
    } };
    // A failed expectation must also release these test-owned waiters.
    const cleanupTimer = setTimeout(releasePeers, 5000);
    try {
      await runWorkflow(config, 'name: concurrent-scope', projectDir, adapter, new Map(), undefined,
        writeRoles('coder'), created.runId, 'produce safe outputs and report withheld work', true);
      const status = readStageStatus(projectDir, created.runId, 'work');
      expect(workCalls).toBe(2);
      expect(status.attempts?.map((attempt) => attempt.status)).toEqual(['suspended', 'complete']);
      const audit = readJson(join(created.runDirPath, status.attempts![0].constraintAudit!.path));
      const accepted = audit.stateTransitions[0].transitions.find((transition: { event: string }) => transition.event === 'policy_accepted');
      expect(accepted.authorizedRequestPaths).toEqual(['safe/one.txt', 'safe/two.txt']);
      const planning = readdirSync(created.runDirPath).filter((file) => /^scope_negotiation_input_.*\.json$/.test(file));
      expect(planning).toHaveLength(1);
      expect(readJson(join(created.runDirPath, planning[0])).requestedPaths).toEqual(['shared/one.txt', 'shared/two.txt']);
      expect(existsSync(join(projectDir, 'safe/one.txt'))).toBe(true);
      expect(existsSync(join(projectDir, 'shared/one.txt'))).toBe(false);
    } finally { clearTimeout(cleanupTimer); releasePeers(); }
  });
});

 it('addresses the durable decision outlet and binds a partial grant to later re-admission', () => {
  const input = { runDir: 'private-run', runId: 'private-id', stageId: 'work', attemptIndex: 3,
    scope: [], scopePresence: 'present' as const, gate: false };
  for (const prompt of [scopeRevisionContract(input), scopeRevisionInstruction({ ...input, violatingPaths: ['product.txt'] })]) {
    expect(prompt).toContain('scope_revision_decision_attempt_3_*.json');
    expect(prompt).not.toContain('scope_revision_decision_<requestId>.json');
    expect(prompt).toContain('runId, stageId, attemptIndex, requestId and canonical requestedPaths');
    expect(prompt).toContain('only a later re-admitted execution may write newly authorizedPaths');
    expect(prompt).toContain('Denied paths remain outside your authority');
  }
 });
