import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';
import {
  demoteRealityCheckAdvisories,
  inspectRealityChecks,
} from '../src/reality-check-preflight.js';
import {
  appendResearchTemporalPathContract,
  ensureTerminalArtifactValidation,
  findGateRecoveryStages,
  normalizedResearchEvidenceDigest,
  parseDispatchedStageConfig,
  recordGateValidationDelta,
  runWorkflow,
  scopeRevisionValidationConsequence,
  tryAdvanceResearch,
  tryTerminateOnTerminalState,
  type GateRecoveryFact,
  type StageConfig,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  runProjectValidationBaseline,
  validationPathImpacts,
  type ProjectValidationBaseline,
  type ProjectValidationDependencies,
} from '../src/project-validation.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeStageStatus,
  writeRunState,
  type StoreState,
} from '../src/store.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

const roots: string[] = [];
const originalStateRoot = fcGlobalDir();

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-runtime-${label}-`));
  roots.push(root);
  return root;
}

function seedProject(label: string, ...roles: string[]): { projectDir: string; agentsDir: string } {
  const projectDir = join(temporaryRoot(label), 'project');
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
    'default_timeout_ms: 60000',
    'default_max_iterations: 1',
    'default_gate_retry_loops: 1',
    'default_stage_technical_retries: 0',
  ].join('\n'));
  for (const role of roles) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: bounded runtime fixture',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: bounded runtime fixture',
    ].join('\n'));
  }
  setFcGlobalDir(join(dirname(projectDir), 'state'));
  return { projectDir, agentsDir };
}

function stage(raw: Record<string, unknown>): StageConfig {
  return parseDispatchedStageConfig({
    role: 'worker',
    prompt_template: 'runtime fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function summaryResult(opts: RunOpts): RunResult | undefined {
  return opts.stageId === '_summary'
    ? { output: 'runtime fixture summary', exitCode: 0, duration_ms: 1 }
    : undefined;
}

function researchBrief(maxRounds = 3): string {
  return [
    '---',
    'research:',
    '  baseline: 0',
    '  policy: best_of_n',
    '  result_file: artifacts/round.json',
    '  report_dir: artifacts',
    '  stop:',
    `    max_rounds: ${maxRounds}`,
    '---',
    '# Runtime fixture',
  ].join('\n');
}

function writeValidationSnapshot(
  runDirPath: string,
  baseline: ProjectValidationBaseline,
): { bytes: string; sha256: string } {
  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: 'ship-setup-ready-record',
    baseline,
  };
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(join(runDirPath, 'validation_baseline.json'), bytes);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function validationRunner(exitCode: number): NonNullable<ProjectValidationDependencies['runCommand']> {
  return (request) => ({
    exitCode,
    stdout: exitCode === 0 ? 'ok\n' : '',
    stderr: exitCode === 0 ? '' : 'FAIL spec/delivered.test.ts\n',
    durationMs: 1,
  });
}

async function configuredBaseline(projectDir: string): Promise<ProjectValidationBaseline> {
  return runProjectValidationBaseline(projectDir, {
    commands: (['build', 'test', 'lint'] as const).map((role) => ({
      role,
      command: process.execPath,
      args: [`fixture-${role}.mjs`],
      display: `node fixture-${role}.mjs`,
      evidencePath: `fixture-${role}.mjs`,
    })),
    runCommand: validationRunner(0),
  });
}

function terminalState(
  projectDir: string,
  runId: string,
  terminalPath: string,
  completedAt: string,
): StoreState {
  return {
    runId,
    workflowName: 'terminal-validation-fixture',
    projectDir,
    status: 'running',
    terminalStates: { complete: { paths: [terminalPath] } },
    stages: {
      finalizer: {
        status: 'complete',
        retries: 0,
        startedAt: new Date(Date.parse(completedAt) - 100).toISOString(),
        completedAt,
        writes: [terminalPath],
        attempts: [{
          index: 1,
          status: 'complete',
          startedAt: new Date(Date.parse(completedAt) - 100).toISOString(),
          completedAt,
          writes: [terminalPath],
          writeAttribution: 'structured',
        }],
      },
    },
    startedAt: new Date(Date.parse(completedAt) - 1_000).toISOString(),
  };
}

afterEach(() => {
  setFcGlobalDir(originalStateRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine generalization runtime bindings', () => {
  it('9 — routes authored/effective rejection facts to the responsible producer', async () => {
    const measure = stage({ id: 'measure', scope: ['artifacts/round.json'] });
    const gate = stage({
      id: 'qa', role: 'qa', is_gate: true, depends_on: ['measure'],
      dependency_reasons: { measure: 'audit measured work' },
    });
    const repair = stage({
      id: 'repair', depends_on: ['qa'], dependency_reasons: { qa: 'repair a substantive rejection' },
      retry_to: ['qa'],
    });
    const contractFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: true, reason: 'work itself passes' },
      effectiveVerdict: { pass: false, reason: 'Gate contract violation: missing required numeric gate value' },
      rejectionKind: 'engine_contract_or_evidence_rejection',
    };
    const substantiveFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: false, reason: 'product behavior is wrong' },
      effectiveVerdict: { pass: false, reason: 'product behavior is wrong' },
      rejectionKind: 'authored_substantive_failure',
    };
    const omittedFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: { pass: true, reason: 'audit completed' },
      effectiveVerdict: { pass: false, reason: 'Research round outcome is absent: no usable evidence' },
      rejectionKind: 'omitted_research_outcome',
    };
    const legacyFact: GateRecoveryFact = {
      gateId: 'qa',
      authoredVerdict: null,
      effectiveVerdict: { pass: false, reason: 'legacy rejection without typed authorship' },
      rejectionKind: 'unclassified_rejection',
    };
    const research = { baseline: 0, policy: 'best_of_n' as const, resultFile: 'artifacts/round.json' };
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: contractFact.effectiveVerdict?.reason }, research, { qa: contractFact },
    ).map((entry) => entry.id)).toEqual(['qa']);
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: substantiveFact.effectiveVerdict?.reason }, research, { qa: substantiveFact },
    ).map((entry) => entry.id)).toEqual(['repair']);
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: omittedFact.effectiveVerdict?.reason }, research, { qa: omittedFact },
    ).map((entry) => entry.id)).toEqual(['measure']);
    expect(findGateRecoveryStages(
      [measure, gate, repair], ['qa'], { qa: legacyFact.effectiveVerdict?.reason }, research, { qa: legacyFact },
    ).map((entry) => entry.id)).toEqual(['repair']);

    const { projectDir, agentsDir } = seedProject('recovery', 'planner', 'qa', 'repair');
    const workflow: WorkflowConfig = {
      name: 'typed-gate-recovery',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [stage({ id: 'plan', role: 'planner', dynamic_dispatch: true })],
    };
    const created = createRun(projectDir, workflow.name, 'name: typed-gate-recovery', ['plan']);
    writeFileSync(join(created.runDirPath, 'gate_contract.json'), JSON.stringify({
      metric: 'quality', threshold: 7, higherIsBetter: true,
    }));
    let gateCalls = 0;
    let repairCalls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:',
          '  - id: qa',
          '    role: qa',
          '    scope: []',
          '    depends_on: [plan]',
          '    dependency_reasons: {plan: "audit the planned work"}',
          '    is_gate: true',
          '    prompt_template: Write the typed verdict.',
          '  - id: repair',
          '    role: repair',
          '    scope: []',
          '    depends_on: [qa]',
          '    dependency_reasons: {qa: "repair a substantive product rejection"}',
          '    retry_to: [qa]',
          '    prompt_template: Repair only a product defect.',
        ].join('\n'));
        return { output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      if (opts.stageId === 'qa') {
        gateCalls++;
        writeFileSync(join(opts.runDir, 'verdict_qa.json'), JSON.stringify(gateCalls === 1
          ? { pass: true, reason: 'work itself passes', metric: 'quality' }
          : { pass: true, reason: 'contract evidence supplied', metric: 'quality', value: 8 }));
        if (gateCalls === 2) expect(prompt).toContain('engine_rejection_reason');
        return { output: `gate ${gateCalls}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      if (opts.stageId === 'repair') repairCalls++;
      return { output: 'unexpected repair', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(
      workflow,
      'name: typed-gate-recovery',
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      created.runId,
      '# Supply typed gate evidence.',
      true,
    );
    expect({ status: final.status, gateCalls, repairCalls }).toEqual({
      // The contract rejection must re-run only the gate/evidence producer; the
      // product-repair stage remains blocked because the authored verdict passed.
      status: 'complete', gateCalls: 2, repairCalls: 0,
    });
  });

  it('10 — binds a versioned-shape advisory to preflight bytes and judges produced bytes', async () => {
    const { projectDir } = seedProject('shape');
    const artifactPath = join(projectDir, 'output', 'result.json');
    mkdirSync(dirname(artifactPath), { recursive: true });
    const oldBytes = `${JSON.stringify({ artifact: 'generic.summary.v2' })}\n`;
    writeFileSync(artifactPath, oldBytes);
    const script = [
      "node <<'NODE'",
      "const fs = require('fs');",
      "const dataPath = 'output/result.json';",
      "const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
      "function fail(message) { console.error(message); process.exit(1); }",
      "if (!data.expected_one) fail('expected_one is absent');",
      "if (!data.expected_two || !Array.isArray(data.expected_two.rows)) fail('expected_two.rows is absent');",
      'NODE',
    ].join('\n');
    const markdown = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: produced JSON shape',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: |',
      ...script.split('\n').map((line) => `        ${line}`),
      '```',
    ].join('\n');
    const preflight = inspectRealityChecks('# Produce output/result.json.', markdown, { projectDir });
    const rewrite = demoteRealityCheckAdvisories(markdown, preflight.advisoryFindings);
    expect(rewrite.demotedCheckIndexes).toEqual([1]);
    expect(rewrite.markdown).toContain('__flowcrew_preflight_artifact_sha256');
    expect(parseChecksFromMarkdown(rewrite.markdown)[0]).not.toMatchObject({ advisory: true });

    writeFileSync(artifactPath, JSON.stringify({ artifact: 'generic.summary.v2', expected_one: true }));
    const producedInvalid = await runAllChecks(parseChecksFromMarkdown(rewrite.markdown), {
      taskDir: join(projectDir, 'run'), projectDir,
    });
    expect(producedInvalid).toMatchObject({
      pass: false,
      results: [{ pass: false, evidence: { code: 1 } }],
    });
    expect(producedInvalid.results[0]).not.toHaveProperty('advisory');

    writeFileSync(artifactPath, JSON.stringify({
      artifact: 'generic.summary.v2', expected_one: true, expected_two: { rows: [] },
    }));
    const compatible = await runAllChecks(parseChecksFromMarkdown(rewrite.markdown), {
      taskDir: join(projectDir, 'run'), projectDir,
    });
    expect(compatible).toMatchObject({ pass: true, results: [{ pass: true }] });

    writeFileSync(artifactPath, oldBytes);
    const unchangedPreflightBytes = await runAllChecks(parseChecksFromMarkdown(rewrite.markdown), {
      taskDir: join(projectDir, 'run'), projectDir,
    });
    expect(unchangedPreflightBytes).toMatchObject({
      pass: true,
      results: [{ pass: false, advisory: true }],
    });
  });

  it('12 — revalidates terminal writes after their last attributed write and retains later blessings', async () => {
    const runCase = async (
      label: string,
      revalidationExit: number,
      laterBlessing: false | 'legacy' | 'current',
      laterBlessingPass = true,
    ) => {
      const { projectDir } = seedProject(`terminal-${label}`);
      const terminalPath = 'docs/final.md';
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, terminalPath), '# delivered bytes\n');
      const created = createRun(projectDir, label, `name: ${label}`, ['finalizer']);
      const completedAt = new Date(Date.now() - 200).toISOString();
      const state = terminalState(projectDir, created.runId, terminalPath, completedAt);
      writeRunState(projectDir, created.runId, state);
      writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
        version: 1,
        pass: true,
        checkedAt: new Date().toISOString(),
        errors: [],
        terminalOwners: { [terminalPath]: 'finalizer' },
      }));
      const baseline = await configuredBaseline(projectDir);
      const snapshot = writeValidationSnapshot(created.runDirPath, baseline);
      const oldCheckedAt = new Date(Date.parse(completedAt) - 200).toISOString();
      let validationCalls = 0;
      if (laterBlessing === 'current') {
        const attemptStartedAt = new Date(Date.parse(completedAt) + 50).toISOString();
        const attemptCompletedAt = new Date(Date.parse(completedAt) + 100).toISOString();
        writeStageStatus(projectDir, created.runId, 'qa', {
          status: 'complete', retries: 0, startedAt: attemptStartedAt, completedAt: attemptCompletedAt,
          attempts: [{
            index: 1, status: 'complete', startedAt: attemptStartedAt, completedAt: attemptCompletedAt,
            duration_ms: 50, exitCode: 0, tokenUsage: 'unknown',
          }],
        });
        await recordGateValidationDelta(projectDir, created.runId, 'qa', {
          runCommand: validationRunner(laterBlessingPass ? 0 : 1),
        });
      } else {
        writeFileSync(join(created.runDirPath, 'validation_delta_qa.json'), JSON.stringify({
          version: 1,
          stageId: 'qa',
          checkedAt: laterBlessing === 'legacy'
            ? new Date(Date.parse(completedAt) + 100).toISOString()
            : oldCheckedAt,
          pass: laterBlessingPass,
          baselineSha256: snapshot.sha256,
          current: baseline.results,
          delta: [],
        }));
      }
      const result = await tryTerminateOnTerminalState(state, {
        projectDir,
        runId: created.runId,
        runDirPath: created.runDirPath,
        iteration: 1,
        adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) },
        validationDependencies: {
          runCommand: (request) => {
            validationCalls++;
            return validationRunner(revalidationExit)(request);
          },
        },
      });
      return { result, state, validationCalls, runDirPath: created.runDirPath };
    };

    const rejected = await runCase('stale-rejected', 1, false);
    expect(rejected.result.decision).toBe('deferred');
    expect(rejected.state.status).toBe('running');
    expect(rejected.validationCalls).toBe(3);
    expect(readFileSync(join(rejected.runDirPath, 'supervisor_guidance.md'), 'utf-8'))
      .toContain('Terminal artifact rejected');

    const revalidated = await runCase('stale-revalidated', 0, false);
    expect(revalidated.result.decision).toBe('matched');
    expect(revalidated.state.status).toBe('complete');
    expect(revalidated.validationCalls).toBe(3);
    expect(existsSync(join(revalidated.runDirPath, 'validation_delta_terminal_finalizer.json'))).toBe(true);

    const identityFree = await runCase('identity-free-later-delta', 0, 'legacy');
    expect(identityFree.result.decision).toBe('matched');
    expect(identityFree.state.status).toBe('complete');
    expect(identityFree.validationCalls).toBe(3);

    const blessed = await runCase('current-blessing', 1, 'current');
    expect(blessed.result.decision).toBe('matched');
    expect(blessed.state.status).toBe('complete');
    expect(blessed.validationCalls).toBe(0);

    const laterRegression = await runCase('current-regression', 0, 'current', false);
    expect(laterRegression.result.decision).toBe('deferred');
    expect(laterRegression.state.status).toBe('running');
    expect(laterRegression.validationCalls).toBe(0);

    const legacyRegression = await runCase('identity-free-regression', 0, 'legacy', false);
    expect(legacyRegression.result.decision).toBe('matched');
    expect(legacyRegression.state.status).toBe('complete');
    expect(legacyRegression.validationCalls).toBe(3);

    const noBaseline = await ensureTerminalArtifactValidation({
      projectDir: dirname(identityFree.runDirPath),
      runId: 'none',
      runDirPath: temporaryRoot('no-baseline'),
      state: identityFree.state,
      ownerStageId: 'finalizer',
      terminalPath: 'docs/final.md',
      artifactMtimeMs: Date.now(),
    });
    expect(noBaseline).toMatchObject({ required: false, pass: true, disposition: 'no_baseline' });
  });

  it('13 — rejects reused normalized round evidence while equal scores with independent evidence pass', async () => {
    const { projectDir } = seedProject('round-evidence');
    const runDirPath = join(dirname(projectDir), 'run');
    const resultPath = join(projectDir, 'artifacts', 'round.json');
    mkdirSync(dirname(resultPath), { recursive: true });
    mkdirSync(runDirPath, { recursive: true });
    const state = {
      runId: 'round-evidence', workflowName: 'fixture', projectDir, status: 'running', stages: {},
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      research: {
        baseline: 0, policy: 'best_of_n', resultFile: 'artifacts/round.json', reportDir: 'artifacts',
        stop: { maxRounds: 4 },
      },
    } as StoreState;
    const common = {
      result: 0.018,
      result_std: 0.001,
      control: { mean: 0.01, lower: 0.009, upper: 0.011 },
      evidence: { sample: 'control-pair-a', seed: 11 },
    };
    const first = { label: 'round-a', ...common };
    const reused = { label: 'round-b', ...common };
    expect(normalizedResearchEvidenceDigest(first)).toBe(normalizedResearchEvidenceDigest(reused));
    writeFileSync(resultPath, JSON.stringify(first));
    await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath, iteration: 1, adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) } });
    writeFileSync(resultPath, JSON.stringify(first));
    await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath, iteration: 2, adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) } });
    expect(readFileSync(join(runDirPath, 'supervisor_guidance.md'), 'utf-8')).toContain('immutable identity');
    writeFileSync(resultPath, JSON.stringify(reused));
    await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath, iteration: 3, adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) } });
    const rejected = JSON.parse(readFileSync(join(runDirPath, 'research_round_input_error.json'), 'utf-8')) as Record<string, unknown>;
    let journal = JSON.parse(readFileSync(join(runDirPath, 'research_journal.json'), 'utf-8')) as {
      rounds: Array<{ label: string; result: number }>;
      measurementEvidence: Array<{ label: string; normalizedSha256: string; source: string }>;
    };
    expect(rejected).toMatchObject({ kind: 'research_round_evidence_reused' });
    expect(journal.rounds.map((round) => round.label)).toEqual(['round-a']);
    expect(journal.measurementEvidence).toEqual([
      expect.objectContaining({ label: 'round-a', source: 'research_round_1_consumed.json' }),
    ]);

    const independent = {
      label: 'round-c',
      ...common,
      evidence: { sample: 'control-pair-c', seed: 29 },
    };
    expect(normalizedResearchEvidenceDigest(independent)).not.toBe(normalizedResearchEvidenceDigest(first));
    writeFileSync(resultPath, JSON.stringify(independent));
    await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath, iteration: 4, adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) } });
    journal = JSON.parse(readFileSync(join(runDirPath, 'research_journal.json'), 'utf-8'));
    expect(journal.rounds.map((round) => [round.label, round.result])).toEqual([
      ['round-a', 0.018],
      ['round-c', 0.018],
    ]);

    writeFileSync(resultPath, JSON.stringify({
      label: 'round-a', result: 0.019, evidence: { sample: 'new', seed: 41 },
    }));
    await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath, iteration: 5, adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) } });
    expect(readFileSync(join(runDirPath, 'supervisor_guidance.md'), 'utf-8')).toContain('immutable identity');
  });

  it('16 — names a proven configured-command intersection only while research rounds remain', async () => {
    const { projectDir, agentsDir } = seedProject('scope-message', 'worker');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'export {};\n');
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(projectDir, 'vitest.config.ts'), [
      'export default { test: {',
      "  include: ['spec/**/*.test.ts'],",
      '} };',
    ].join('\n'));
    const commands = [{
      role: 'test' as const,
      command: 'npm',
      args: ['run', 'test'],
      display: 'npm run test',
      evidencePath: 'package.json',
    }];
    expect(validationPathImpacts(projectDir, commands, ['spec/new-audit.test.ts'])).toEqual([
      expect.objectContaining({ path: 'spec/new-audit.test.ts', role: 'test', command: 'npm run test' }),
    ]);
    expect(validationPathImpacts(projectDir, commands, ['docs/note.md'])).toEqual([]);
    const misleadingConfig = [
      'export default { test: {',
      "  coverage: { include: ['docs/**'] },",
      "  // include: ['docs/**'],",
      '} };',
    ].join('\n');
    expect(validationPathImpacts(projectDir, commands, ['docs/note.md'], {
      exists: (path) => path.endsWith('vitest.config.ts'),
      readText: () => misleadingConfig,
    })).toEqual([]);

    const work = stage({ id: 'measure', role: 'worker', scope: ['src/declared.ts'] });
    const workflow: WorkflowConfig = {
      name: 'scope-consequence',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [work],
    };
    const created = createRun(projectDir, workflow.name, 'name: scope-consequence', [work.id]);
    const baseline = await runProjectValidationBaseline(projectDir, {
      commands,
      runCommand: validationRunner(0),
    });
    writeValidationSnapshot(created.runDirPath, baseline);
    let calls = 0;
    let redispatchPrompt = '';
    const adapter: Adapter = { async run(prompt, _role: AgentConfig, opts: RunOpts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      calls++;
      if (calls === 1) {
        const directory = join(opts.runDir, 'stages', opts.stageId);
        const requestedPaths = ['spec/new-audit.test.ts'];
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1,
          kind: 'scope_revision',
          requestId: 'validation-input',
          runId: opts.runId,
          stageId: opts.stageId,
          attemptIndex: 1,
          requestedBy: 'stage',
          requestedPaths,
          pathDigest: scopePathDigest(requestedPaths),
          reason: 'add a persistent validation audit',
        }));
        await waitForPathEvent(directory, () => {
          const name = readdirSync(directory).find((file) => file.startsWith('scope_revision_decision_'));
          return name ? JSON.parse(readFileSync(join(directory, name), 'utf-8')) as Record<string, unknown> : undefined;
        });
        return { output: 'scope accepted', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      redispatchPrompt = prompt;
      return { output: 'done', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    await runWorkflow(
      workflow,
      'name: scope-consequence',
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      created.runId,
      researchBrief(3),
      true,
    );
    expect(calls).toBe(2);
    expect(redispatchPrompt).toContain('Scope revision validation-input was accepted');
    expect(redispatchPrompt).toContain('spec/new-audit.test.ts -> test command "npm run test"');
    expect(redispatchPrompt).toContain('3 research rounds remain');
    expect(redispatchPrompt).toContain('new failing identifier will block acceptance');

    const current = readRunState(projectDir, created.runId);
    expect(scopeRevisionValidationConsequence({
      projectDir, runDirPath: created.runDirPath, state: { ...current, research: undefined },
      requestedPaths: ['spec/new-audit.test.ts'],
    })).toBeUndefined();
    expect(scopeRevisionValidationConsequence({
      projectDir, runDirPath: created.runDirPath, state: current,
      requestedPaths: ['docs/note.md'],
    })).toBeUndefined();
    writeFileSync(join(created.runDirPath, 'research_journal.json'), JSON.stringify({
      rounds: [{}, {}, {}],
    }));
    expect(scopeRevisionValidationConsequence({
      projectDir, runDirPath: created.runDirPath, state: current,
      requestedPaths: ['spec/new-audit.test.ts'],
    })).toBeUndefined();
    writeFileSync(join(created.runDirPath, 'research_journal.json'), JSON.stringify({ rounds: [] }));
    rmSync(join(created.runDirPath, 'validation_baseline.json'));
    expect(scopeRevisionValidationConsequence({
      projectDir, runDirPath: created.runDirPath, state: current,
      requestedPaths: ['spec/new-audit.test.ts'],
    })).toBeUndefined();
  });

  it('17 — carries the exact no-candidate shape through both dispatch paths and retains runtime refusals', async () => {
    const { projectDir, agentsDir } = seedProject('round-shape', 'planner', 'qa', 'repair');
    const workflow: WorkflowConfig = {
      name: 'round-shape-paths',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [stage({ id: 'plan', role: 'planner', dynamic_dispatch: true })],
    };
    let initialPrompt = '';
    let repairPrompt = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:',
          '  - id: qa',
          '    role: qa',
          '    scope: []',
          '    depends_on: [plan]',
          '    dependency_reasons: {plan: "audit the current round"}',
          '    is_gate: true',
          '    prompt_template: Reject the fixture once.',
          '  - id: repair',
          '    role: repair',
          '    scope: []',
          '    depends_on: [qa]',
          '    dependency_reasons: {qa: "repair the substantive rejection"}',
          '    retry_to: [qa]',
          '    prompt_template: Repair the fixture.',
        ].join('\n'));
      } else if (opts.stageId === 'qa') {
        initialPrompt ||= prompt;
        writeFileSync(join(opts.runDir, 'verdict_qa.json'), JSON.stringify({
          pass: false, reason: 'substantive fixture rejection',
        }));
      } else {
        repairPrompt = prompt;
      }
      return { output: opts.stageId, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    await runWorkflow(
      workflow,
      'name: round-shape-paths',
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      researchBrief(2),
      true,
    );
    const exactShape = '{"label":"<non-empty>","outcome":"no_candidate","reason":"<non-empty>"}';
    expect(initialPrompt).toContain(exactShape);
    expect(repairPrompt).toContain(exactShape);
    expect(appendResearchTemporalPathContract('ROUND', {
      baseline: 0, policy: 'best_of_n', resultFile: 'artifacts/round.json',
    }, undefined)).toContain(exactShape);

    const refusalRoot = temporaryRoot('round-refusals');
    const refusalProject = join(refusalRoot, 'project');
    const refusalRun = join(refusalRoot, 'run');
    mkdirSync(join(refusalProject, 'artifacts'), { recursive: true });
    mkdirSync(refusalRun, { recursive: true });
    const state = {
      runId: 'refusal', workflowName: 'fixture', projectDir: refusalProject, status: 'running', stages: {},
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'artifacts/round.json', stop: { maxRounds: 2 } },
    } as StoreState;
    const measured = join(refusalProject, 'artifacts', 'round.json');
    const sidecar = `${measured}.no_candidate.json`;
    writeFileSync(measured, JSON.stringify({ label: 'measured', result: 1 }));
    writeFileSync(sidecar, JSON.stringify({ label: 'none', outcome: 'no_candidate', reason: 'unsafe' }));
    await tryAdvanceResearch(state, { projectDir: refusalProject, runId: state.runId, runDirPath: refusalRun, iteration: 1, adapter });
    expect(JSON.parse(readFileSync(join(refusalRun, 'research_round_input_error.json'), 'utf-8')))
      .toMatchObject({ kind: 'ambiguous_measured_and_no_candidate' });
    rmSync(measured);
    writeFileSync(sidecar, JSON.stringify({ label: 'none', outcome: 'no_candidate', reason: '' }));
    await tryAdvanceResearch(state, { projectDir: refusalProject, runId: state.runId, runDirPath: refusalRun, iteration: 1, adapter });
    expect(JSON.parse(readFileSync(join(refusalRun, 'research_round_input_error.json'), 'utf-8')))
      .toMatchObject({ kind: 'invalid_no_candidate_shape' });
  });
});
