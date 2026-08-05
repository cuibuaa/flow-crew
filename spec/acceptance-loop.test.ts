import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { buildCodexExecArgs } from '../src/adapters/codex.js';
import {
  buildGateReevaluationPreamble,
  canResumeOwnGateSession,
  gateVerdictCorrectionPath,
  GATE_VERDICT_CORRECTION_VERSION,
  runWorkflow,
  type WorkflowConfig,
} from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const GATE_ID = 'release_gate';
const FIX_ID = 'fix_release';
const GATE_UUID = '11111111-1111-4111-8111-111111111111';
const BUILDER_UUID = '22222222-2222-4222-8222-222222222222';

let root: string;
let projectDir: string;
let previousFcHome: string;
let previousReuse: string | undefined;

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: E7 fixture role',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: E7 fixture system prompt',
    ].join('\n'));
  }
  return agentsDir;
}

function workflow(maxIterations = 1): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: e7-acceptance-loop',
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
      name: 'e7-acceptance-loop',
      defaults: { max_iterations: maxIterations, max_retries: 0 },
      stages: [{ id: 'plan', role: 'planner', scope: [], depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }],
    },
  };
}

function dispatchYaml(): string {
  return [
    'stages:',
    `  - id: ${GATE_ID}`,
    '    role: qa',
    '    scope: []',
    '    depends_on: [plan]',
    '    dependency_reasons: {plan: "audit the planner output"}',
    '    is_gate: true',
    '    prompt_template: |',
    '      Audit the fixture and write the required verdict. On the first execution, audit exhaustively and emit your own Coverage Map.',
    `  - id: ${FIX_ID}`,
    '    role: repair',
    '    scope: [src/checked.ts]',
    `    depends_on: [${GATE_ID}]`,
    `    dependency_reasons: {${GATE_ID}: "repair the rejected fixture"}`,
    `    retry_to: [${GATE_ID}]`,
    '    prompt_template: Repair exactly the rejected fixture.',
  ].join('\n');
}

function writeSession(runDirPath: string, stageId: string, sessionId: string, ownerStageId = stageId): void {
  const dir = join(runDirPath, 'stages', stageId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    version: 1,
    sessionId,
    ownerStageId,
    capturedAt: '2026-08-01T00:00:00.000Z',
  }, null, 2) + '\n');
}

async function waitForScopeDecision(stagePath: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const decision = readdirSync(stagePath).find((name) => name.startsWith('scope_revision_decision_'));
    if (decision) {
      const value = JSON.parse(readFileSync(join(stagePath, decision), 'utf-8')) as { accepted?: boolean };
      if (!value.accepted) throw new Error('E7 fixture scope revision was rejected');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('E7 fixture timed out waiting for its scope revision decision');
}

interface ScenarioOptions {
  firstGatePass?: boolean;
  twoIterations?: boolean;
  writeWrongVerdictMarker?: boolean;
  writeOutsideScope?: boolean;
  onSecondGatePrompt?: (prompt: string) => void;
}

async function runScenario(options: ScenarioOptions = {}): Promise<{
  finalStatus: string;
  finalIteration: number | undefined;
  gateOpts: RunOpts[];
  gatePrompts: string[];
  fixPrompts: string[];
  runDirPath: string;
}> {
  const { config, yaml } = workflow(options.twoIterations ? 2 : 1);
  const gateOpts: RunOpts[] = [];
  const gatePrompts: string[] = [];
  const fixPrompts: string[] = [];
  let gateCalls = 0;

  const adapter: Adapter = {
    async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return { output: '## What was done\n- E7 fixture complete', exitCode: 0, duration_ms: 1 };
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), dispatchYaml());
        writeSession(opts.runDir, 'plan', BUILDER_UUID, 'plan');
        return { output: 'planned', exitCode: 0, duration_ms: 2, sessionId: BUILDER_UUID };
      }
      if (opts.stageId === GATE_ID) {
        gateCalls++;
        gateOpts.push({ ...opts });
        gatePrompts.push(prompt);
        const fixtureIteration = options.twoIterations ? Math.ceil(gateCalls / 2) : 1;
        const pass = options.firstGatePass === true || (options.twoIterations ? gateCalls % 2 === 0 : gateCalls > 1);
        writeFileSync(join(opts.runDir, `verdict_${GATE_ID}.json`), JSON.stringify({
          pass,
          reason: pass ? 'fixture fixed' : 'fixture still contains BROKEN',
          findings: pass ? [] : [{ id: 'broken-marker', path: 'src/checked.ts' }],
          marker: pass
            ? `iteration-${fixtureIteration}-reevaluation-pass`
            : `iteration-${fixtureIteration}-round-1-verdict`,
          ...(options.twoIterations && fixtureIteration === 1 && pass
            ? { phaseComplete: true, nextPhase: 'iteration-2' }
            : {}),
        }, null, 2) + '\n');
        if (!pass) {
          writeSession(opts.runDir, GATE_ID, GATE_UUID);
        } else {
          options.onSecondGatePrompt?.(prompt);
        }
        return {
          output: pass
            ? `All rejected items reproduced and fixed for iteration ${fixtureIteration}.\n\nCoverage Map\n- fixture marker: pass`
            : `iteration-${fixtureIteration}-round-1-output\n\nRejected broken marker.\n\nCoverage Map\n- fixture marker: fail via exact file read\n- session isolation: pass`,
          exitCode: 0,
          duration_ms: gateCalls === 1 ? 20 : 8,
          tokens_in: gateCalls === 1 ? 100 : 30,
          tokens_out: gateCalls === 1 ? 40 : 15,
          sessionId: GATE_UUID,
        };
      }
      if (opts.stageId === FIX_ID) {
        fixPrompts.push(prompt);
        if (options.writeOutsideScope) {
          const stagePath = join(opts.runDir, 'stages', opts.stageId);
          writeFileSync(join(stagePath, 'scope_revision_request.json'), JSON.stringify({
            version: 1,
            kind: 'scope_revision',
            requestId: 'e7-round-diff-fixture',
            stageId: opts.stageId,
            attemptIndex: 1,
            requestedPaths: ['src/outside.ts', 'src/outside.bin'],
            reason: 'the repair-round diff fixture must exercise added and modified files outside the original snapshot',
          }));
          await waitForScopeDecision(stagePath);
        }
        writeFileSync(join(projectDir, 'src', 'checked.ts'), 'export const state = "FIXED";\n');
        if (options.writeOutsideScope) {
          writeFileSync(join(projectDir, 'src', 'outside.ts'), 'export const outside = "CHANGED";\n');
          writeFileSync(join(projectDir, 'src', 'outside.bin'), Buffer.from([0, 1, 2, 3]));
        }
        if (options.writeWrongVerdictMarker) {
          const marker = gateVerdictCorrectionPath(opts.runDir, GATE_ID);
          mkdirSync(join(marker, '..'), { recursive: true });
          writeFileSync(marker, JSON.stringify({
            version: GATE_VERDICT_CORRECTION_VERSION,
            gateId: GATE_ID,
            previousVerdictWrong: true,
            reason: 'the prior probe read a stale generated file',
            evidence: 'node probe.js -> current source was already FIXED',
          }, null, 2) + '\n');
        }
        return {
          output: 'fixed the rejected marker',
          exitCode: 0,
          duration_ms: 5,
          writes: options.writeOutsideScope ? ['src/checked.ts', 'src/outside.ts', 'src/outside.bin'] : ['src/checked.ts'],
          writeAttribution: 'structured',
        };
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
    'E7 deterministic acceptance-loop fixture',
    true,
  );
  return {
    finalStatus: final.status,
    finalIteration: final.currentIteration,
    gateOpts,
    gatePrompts,
    fixPrompts,
    runDirPath: runDir(projectDir, final.runId),
  };
}

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  previousReuse = process.env.FC_SESSION_REUSE;
  root = join(tmpdir(), `flowcrew-e7-${randomBytes(6).toString('hex')}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'checked.ts'), 'export const state = "BROKEN";\n');
  writeFileSync(join(projectDir, 'src', 'outside.ts'), 'export const outside = "ORIGINAL";\n');
  setFcGlobalDir(join(root, 'fc-home'));
  process.env.FC_SESSION_REUSE = '0';
});

afterEach(() => {
  setFcGlobalDir(previousFcHome);
  if (previousReuse === undefined) delete process.env.FC_SESSION_REUSE;
  else process.env.FC_SESSION_REUSE = previousReuse;
  rmSync(root, { recursive: true, force: true });
});

describe('compressed acceptance loop', () => {
  it('resumes the same gate with its own explicit UUID and never uses global recency', async () => {
    const result = await runScenario();
    expect(result.finalStatus).toBe('complete');
    expect(result.gateOpts).toHaveLength(2);
    expect(result.gateOpts[0].resumeSessionId).toBeUndefined();
    expect(result.gateOpts[1]).toMatchObject({
      resumeSessionId: GATE_UUID,
      sessionOwnerStageId: GATE_ID,
      preserveSession: true,
    });
    const args = buildCodexExecArgs('continue audit', result.gateOpts[1].resumeSessionId);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args).toContain(GATE_UUID);
    expect(args).not.toContain(['--', 'last'].join(''));
    expect(existsSync(join(result.runDirPath, 'stages', GATE_ID, 'session.json'))).toBe(false);
  });

  it('keeps the construction-session inheritance ban on an initial gate', async () => {
    process.env.FC_SESSION_REUSE = '1';
    const result = await runScenario({ firstGatePass: true });
    expect(result.finalStatus).toBe('complete');
    expect(result.gateOpts).toHaveLength(1);
    expect(result.gateOpts[0].resumeSessionId).toBeUndefined();
    expect(result.gateOpts[0].sessionOwnerStageId).toBeUndefined();
    expect(result.gateOpts[0].resumeSessionId).not.toBe(BUILDER_UUID);
    expect(canResumeOwnGateSession({
      id: GATE_ID, role: 'qa', depends_on: ['plan'], prompt_template: '', is_gate: true, skills: [],
    }, {
      version: 1, sessionId: BUILDER_UUID, ownerStageId: 'plan', capturedAt: '2026-08-01T00:00:00.000Z',
    }, false)).toBe(false);
  });

  it('cold-starts after a structured marker proves the previous verdict wrong', async () => {
    const result = await runScenario({ writeWrongVerdictMarker: true });
    expect(result.finalStatus).toBe('complete');
    expect(result.gateOpts).toHaveLength(2);
    expect(result.gateOpts[1].resumeSessionId).toBeUndefined();
    expect(existsSync(gateVerdictCorrectionPath(result.runDirPath, GATE_ID))).toBe(false);
    expect(canResumeOwnGateSession({
      id: GATE_ID, role: 'qa', depends_on: [], prompt_template: '', is_gate: true, skills: [],
    }, {
      version: 1, sessionId: GATE_UUID, ownerStageId: GATE_ID, capturedAt: '2026-08-01T00:00:00.000Z',
    }, true)).toBe(false);
  });

  it('hands off the complete round diff and drives revalidation of a touched check', async () => {
    const touchedCheckProbe = vi.fn();
    const result = await runScenario({
      writeOutsideScope: true,
      onSecondGatePrompt(prompt) {
        const match = prompt.match(/Complete, untruncated repair-round diff: (.+repair_diff\.json)/);
        expect(match?.[1]).toBeTruthy();
        const artifact = JSON.parse(readFileSync(match![1], 'utf-8')) as {
          truncated: boolean;
          files: Array<{ path: string; status: string; before: { text?: string }; after: { text?: string; binary?: boolean; sha256?: string } }>;
        };
        expect(artifact.truncated).toBe(false);
        const touched = artifact.files.find((file) => file.path === 'src/checked.ts');
        expect(touched).toMatchObject({ status: 'modified' });
        expect(touched?.before.text).toContain('BROKEN');
        expect(touched?.after.text).toContain('FIXED');
        const scopeEscape = artifact.files.find((file) => file.path === 'src/outside.ts') as (typeof artifact.files)[number] & { preimageAvailable?: boolean };
        expect(scopeEscape).toMatchObject({ status: 'modified', preimageAvailable: true });
        expect(scopeEscape.after.text).toContain('CHANGED');
        const binary = artifact.files.find((file) => file.path === 'src/outside.bin');
        expect(binary).toMatchObject({ status: 'added', after: { binary: true } });
        expect(binary?.after.sha256).toMatch(/^[0-9a-f]{64}$/);
        touchedCheckProbe('fixture-marker-check');
      },
    });
    expect(result.finalStatus).toBe('complete');
    expect(touchedCheckProbe).toHaveBeenCalledExactlyOnceWith('fixture-marker-check');
    expect(result.gatePrompts[1]).toContain('re-run every check from the prior Coverage Map');
    expect(result.gatePrompts[1]).toContain('full mechanical regression suites');
  });

  it('keeps round-one evidence distinct and iteration-local across two outer iterations', { timeout: 20_000 }, async () => {
    const result = await runScenario({ twoIterations: true });
    expect(result.finalStatus).toBe('complete');
    expect(result.finalIteration).toBe(2);
    expect(result.gatePrompts).toHaveLength(4);
    expect(result.fixPrompts).toHaveLength(2);

    const archiveRoot = join(result.runDirPath, 'gate_reevaluation');
    const roundDirs = [1, 2].map((iteration) => join(archiveRoot, `iteration_${iteration}`, 'round_1'));
    const artifactMatrix = roundDirs.flatMap((roundDir) => [
      join(roundDir, `rejected_verdict_${GATE_ID}.json`),
      join(roundDir, `previous_output_${GATE_ID}.md`),
    ]);
    expect(new Set(artifactMatrix).size).toBe(4);
    for (const path of artifactMatrix) expect(existsSync(path)).toBe(true);

    for (const iteration of [1, 2]) {
      const roundDir = roundDirs[iteration - 1];
      const verdict = readFileSync(join(roundDir, `rejected_verdict_${GATE_ID}.json`), 'utf-8');
      const output = readFileSync(join(roundDir, `previous_output_${GATE_ID}.md`), 'utf-8');
      expect(verdict).toContain(`iteration-${iteration}-round-1-verdict`);
      expect(output).toContain(`iteration-${iteration}-round-1-output`);
      expect(verdict).not.toContain(`iteration-${iteration === 1 ? 2 : 1}-round-1-verdict`);
      expect(output).not.toContain(`iteration-${iteration === 1 ? 2 : 1}-round-1-output`);
      expect(JSON.parse(readFileSync(join(roundDir, 'repair_diff.json'), 'utf-8'))).toMatchObject({
        iteration,
        round: 1,
        truncated: false,
      });

      const reevaluationPrompt = result.gatePrompts[iteration === 1 ? 1 : 3];
      const fixPrompt = result.fixPrompts[iteration - 1];
      for (const prompt of [reevaluationPrompt, fixPrompt]) {
        expect(prompt).toContain(join(roundDir, `rejected_verdict_${GATE_ID}.json`));
        expect(prompt).toContain(join(roundDir, `previous_output_${GATE_ID}.md`));
        expect(prompt).not.toContain(join(archiveRoot, `iteration_${iteration === 1 ? 2 : 1}`));
        expect(prompt).not.toContain(join(archiveRoot, 'round_1'));
      }
      expect(reevaluationPrompt).toContain(join(roundDir, 'repair_diff.json'));
    }

    expect(existsSync(join(archiveRoot, 'round_1'))).toBe(false);
  });

  it('reads a pure round-only archive without mutating it', () => {
    const legacyRunDir = join(root, 'legacy-run');
    const legacyRoundDir = join(legacyRunDir, 'gate_reevaluation', 'round_1');
    mkdirSync(legacyRoundDir, { recursive: true });
    const legacyVerdict = join(legacyRoundDir, `rejected_verdict_${GATE_ID}.json`);
    const legacyOutput = join(legacyRoundDir, `previous_output_${GATE_ID}.md`);
    const verdictContents = '{"marker":"legacy-round-one-verdict"}\n';
    const outputContents = 'legacy-round-one-output\n';
    writeFileSync(legacyVerdict, verdictContents);
    writeFileSync(legacyOutput, outputContents);
    const legacyPreamble = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 7,
      repairRound: 1,
      runDirPath: legacyRunDir,
      gateId: GATE_ID,
      fixStageIds: [],
      roundDiffPath: join(legacyRoundDir, 'repair_diff.json'),
    });

    expect(legacyPreamble).toContain(`Rejected verdict: ${legacyVerdict}`);
    expect(legacyPreamble).toContain(`Original first-pass validator-owned Coverage Map: ${legacyOutput}`);
    expect(readFileSync(legacyVerdict, 'utf-8')).toBe(verdictContents);
    expect(readFileSync(legacyOutput, 'utf-8')).toBe(outputContents);
    expect(readdirSync(join(legacyRunDir, 'gate_reevaluation'))).toEqual(['round_1']);
  });

  it('fails closed instead of reading legacy evidence when any other iteration namespace exists', () => {
    const mixedRunDir = join(root, 'mixed-run');
    const mixedLegacyRound = join(mixedRunDir, 'gate_reevaluation', 'round_1');
    const otherIterationRound = join(mixedRunDir, 'gate_reevaluation', 'iteration_1', 'round_9');
    const requestedCanonicalRound = join(mixedRunDir, 'gate_reevaluation', 'iteration_2', 'round_1');
    mkdirSync(mixedLegacyRound, { recursive: true });
    mkdirSync(otherIterationRound, { recursive: true });
    const staleLegacyVerdict = join(mixedLegacyRound, `rejected_verdict_${GATE_ID}.json`);
    const staleLegacyOutput = join(mixedLegacyRound, `previous_output_${GATE_ID}.md`);
    const canonicalVerdict = join(requestedCanonicalRound, `rejected_verdict_${GATE_ID}.json`);
    const canonicalOutput = join(requestedCanonicalRound, `previous_output_${GATE_ID}.md`);
    writeFileSync(staleLegacyVerdict, '{"marker":"stale-legacy-verdict"}\n');
    writeFileSync(staleLegacyOutput, 'stale-legacy-output\n');
    writeFileSync(join(otherIterationRound, 'namespace-marker.txt'), 'iteration-one-namespace\n');
    const mixedPreamble = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 2,
      repairRound: 1,
      runDirPath: mixedRunDir,
      gateId: GATE_ID,
      fixStageIds: [],
      roundDiffPath: join(requestedCanonicalRound, 'repair_diff.json'),
    });

    expect(mixedPreamble).toContain(`Rejected verdict: ${canonicalVerdict}`);
    expect(mixedPreamble).toContain(`Original first-pass validator-owned Coverage Map: ${canonicalOutput}`);
    expect(mixedPreamble).not.toContain(staleLegacyVerdict);
    expect(mixedPreamble).not.toContain(staleLegacyOutput);
    expect(mixedPreamble).not.toContain(otherIterationRound);
    expect(existsSync(join(mixedRunDir, 'gate_reevaluation', 'iteration_2'))).toBe(false);
  });

  it('prefers canonical evidence over stale legacy artifacts when both layouts exist', () => {
    const runDirPath = join(root, 'canonical-precedence-run');
    const legacyRoundDir = join(runDirPath, 'gate_reevaluation', 'round_1');
    const canonicalRoundDir = join(runDirPath, 'gate_reevaluation', 'iteration_3', 'round_1');
    mkdirSync(legacyRoundDir, { recursive: true });
    mkdirSync(canonicalRoundDir, { recursive: true });
    const legacyVerdict = join(legacyRoundDir, `rejected_verdict_${GATE_ID}.json`);
    const legacyOutput = join(legacyRoundDir, `previous_output_${GATE_ID}.md`);
    const canonicalVerdict = join(canonicalRoundDir, `rejected_verdict_${GATE_ID}.json`);
    const canonicalOutput = join(canonicalRoundDir, `previous_output_${GATE_ID}.md`);
    writeFileSync(legacyVerdict, '{"marker":"stale-legacy-verdict"}\n');
    writeFileSync(legacyOutput, 'stale-legacy-output\n');
    writeFileSync(canonicalVerdict, '{"marker":"iteration-three-verdict"}\n');
    writeFileSync(canonicalOutput, 'iteration-three-output\n');

    const preamble = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 3,
      repairRound: 1,
      runDirPath,
      gateId: GATE_ID,
      fixStageIds: [],
      roundDiffPath: join(canonicalRoundDir, 'repair_diff.json'),
    });

    expect(preamble).toContain(`Rejected verdict: ${canonicalVerdict}`);
    expect(preamble).toContain(`Original first-pass validator-owned Coverage Map: ${canonicalOutput}`);
    expect(preamble).not.toContain(legacyVerdict);
    expect(preamble).not.toContain(legacyOutput);
  });

  it.each([
    { iteration: 0, repairRound: 1, component: 'iteration' },
    { iteration: 1.5, repairRound: 1, component: 'iteration' },
    { iteration: 1, repairRound: 0, component: 'round' },
    { iteration: 1, repairRound: Number.MAX_SAFE_INTEGER + 1, component: 'round' },
  ])('rejects an invalid gate archive $component coordinate', ({ iteration, repairRound, component }) => {
    expect(() => buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration,
      repairRound,
      runDirPath: join(root, 'invalid-coordinate-run'),
      gateId: GATE_ID,
      fixStageIds: [],
      roundDiffPath: 'unused',
    })).toThrow(`Gate archive ${component} must be a positive integer`);
  });

  it('locks the first-pass coverage map and bounded re-evaluation contracts in every prompt source', () => {
    const base = readFileSync(join(process.cwd(), 'config', 'agents', '_base.md'), 'utf-8');
    const planner = readFileSync(join(process.cwd(), 'config', 'agents', 'planner.yaml'), 'utf-8');
    const qa = readFileSync(join(process.cwd(), 'config', 'agents', 'qa.yaml'), 'utf-8');
    const source = readFileSync(join(process.cwd(), 'src', 'scheduler.ts'), 'utf-8');
    const preamble = buildGateReevaluationPreamble({
      evaluationRound: 2,
      iteration: 1,
      repairRound: 1,
      runDirPath: '/tmp/e7-run',
      gateId: GATE_ID,
      fixStageIds: [FIX_ID],
      roundDiffPath: '/tmp/e7-run/gate_reevaluation/iteration_1/round_1/repair_diff.json',
    });

    expect(base).toContain('validator-owned Coverage Map');
    expect(planner).toContain("validator's output");
    expect(planner).toContain('Do NOT turn the brief into a finite planner-owned checklist');
    expect(qa).toContain('do not invent unrelated probes');
    expect(qa).toContain('complete repair diff');
    expect(qa).not.toContain('write NEW tests');
    expect(preamble).toContain('Reproduce every rejected finding');
    expect(preamble).toContain('full mechanical regression suites');
    expect(preamble).toContain('complete repair diff');
    expect(preamble).not.toContain('Write NEW and DIFFERENT tests');
    expect(source).not.toContain('Write NEW and DIFFERENT tests');
  });
});
