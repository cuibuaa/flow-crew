import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { appendGuidanceEnvelope, guidanceForStageFromText } from '../src/guidance.js';
import { runProjectValidationBaseline } from '../src/project-validation.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { ArtifactContractSchema, type ArtifactContract } from '../src/artifact-declarations.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';
import { createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState, type StoreState } from '../src/store.js';
import { inspectDispatchAdmission, parseDispatchedStageConfig, recordGateValidationDelta, runWorkflow, tryAdvanceResearch } from '../src/scheduler.js';
import { buildSupervisorRolePrompt } from '../src/supervisor.js';

const fixture = (name: string): string => mkdtempSync(join(tmpdir(), `fc-boundaries-4-${name}-`));

describe('engine boundaries from recorded runs', () => {
  it('confirms a met research round using its result and manifest-linked evidence, and still refuses an unconfirmed round', async () => {
    const previousHome = fcGlobalDir();
    const root = fixture('research');
    try {
      setFcGlobalDir(join(root, 'home'));
      for (const [caseName, evidencePath, evidenceScore, expected] of [
        ['confirmed', 'research/evidence.json', 0.25, 'shipped'],
        ['unconfirmed', 'research/missing.json', 0.20, 'ceiling_hit'],
      ] as const) {
        const projectDir = join(root, caseName);
        const runId = `${caseName}-round`;
        const runDirPath = join(root, 'home', 'runs', runId);
        const resultRel = 'research/round_result.json';
        mkdirSync(join(projectDir, 'research'), { recursive: true });
        mkdirSync(runDirPath, { recursive: true });
        writeFileSync(join(projectDir, resultRel), JSON.stringify(caseName === 'confirmed'
          ? { label: 'measured', result: 0.25 }
          : { label: 'measured', result: 0.25, evidence: evidencePath }));
        writeFileSync(join(projectDir, 'research/evidence.json'), JSON.stringify({ label: 'measured', result: evidenceScore, primary: true, confirmation: true }));
        writeFileSync(join(projectDir, 'confirm.cjs'), [
          "const fs = require('node:fs');",
          'const result = JSON.parse(fs.readFileSync(process.argv[2]));',
          "const manifest = JSON.parse(fs.readFileSync('research/run_manifest.json'));",
          'const round = manifest.rounds.find((entry) => entry.label === result.label);',
          'if (!round || !round.evidence || !fs.existsSync(round.evidence)) process.exit(1);',
          'const evidence = JSON.parse(fs.readFileSync(round.evidence));',
          'if (round.result !== result.result || evidence.result !== result.result || !evidence.primary || !evidence.confirmation) process.exit(1);',
        ].join('\n'));
        const state = {
          runId, status: 'running', startedAt: new Date(Date.now() - 2_000).toISOString(), stages: {},
          research: { baseline: 0, policy: 'best_of_n', higherIsBetter: true,
            resultFile: resultRel, reportDir: 'research',
            stop: { beat: 0.1, maxRounds: 1, haltAfterNoImprovement: 1 },
            confirm: { command: `node confirm.cjs ${resultRel}`, requires: 'result and evidence match', timeoutSeconds: 10 } },
        } as StoreState;
        const terminal = await tryAdvanceResearch(state, {
          projectDir, runId, runDirPath, iteration: 1, adapter: new ScriptedAdapter({}),
        });
        const confirmation = JSON.parse(readFileSync(join(runDirPath, 'research_confirm.json'), 'utf8'));
        const manifest = JSON.parse(readFileSync(join(projectDir, 'research/run_manifest.json'), 'utf8'));
        const consumed = JSON.parse(readFileSync(join(runDirPath, 'research_round_1_consumed.json'), 'utf8'));
        expect(terminal?.status, JSON.stringify(confirmation)).toBe(expected);
        expect(confirmation.pass).toBe(caseName === 'confirmed');
        expect(manifest.rounds[0].evidence).toBe(evidencePath);
        expect(consumed.evidence === undefined).toBe(caseName === 'confirmed');
        expect(manifest.rounds[0].confirmFailed === true).toBe(caseName === 'unconfirmed');
      }
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a read-only linked-input replay, blocks a write-through, and still fails a contained regression', async () => {
    const previousHome = fcGlobalDir();
    const root = fixture('validation');
    try {
      const projectDir = join(root, 'project');
      const external = join(root, 'external');
      const runId = 'validation-case';
      const runDirPath = join(root, 'home', 'runs', runId);
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(external, { recursive: true });
      mkdirSync(runDirPath, { recursive: true });
      setFcGlobalDir(join(root, 'home'));
      symlinkSync(external, join(projectDir, 'linked'));
      writeFileSync(join(external, 'ledger.txt'), 'original');
      writeFileSync(join(projectDir, 'test.cjs'), "if (require('node:fs').readFileSync('linked/ledger.txt', 'utf8') !== 'original') process.exit(1); console.log('1 passed');\n");
      const command = { role: 'test' as const, command: process.execPath, args: ['test.cjs'], display: 'node test.cjs' };
      const baseline = await runProjectValidationBaseline(projectDir, {
        commands: [command], runCommand: () => ({ exitCode: 0, stdout: '1 passed', durationMs: 1 }),
      });
      writeFileSync(join(runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), source: 'ship-setup-ready-record', baseline }));
      const readable = await recordGateValidationDelta(projectDir, runId, 'qa_readonly');
      expect(readable?.pass, JSON.stringify(readable)).toBe(true);
      expect(readable?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });

      writeFileSync(join(projectDir, 'test.cjs'), "require('node:fs').writeFileSync('linked/ledger.txt', 'changed');\n");
      const blocked = await recordGateValidationDelta(projectDir, runId, 'qa');
      expect(blocked?.pass).toBe(false);
      expect(blocked?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'failed', exitCode: 1 });
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('original');

      writeFileSync(join(projectDir, 'test.cjs'), [
        "const { spawnSync } = require('node:child_process');",
        `const remount = spawnSync('mount', ['-o', 'remount,bind,rw', ${JSON.stringify(external)}]);`,
        "if (remount.status === 0) process.exit(88);",
        "require('node:fs').writeFileSync('linked/ledger.txt', 'changed');",
      ].join('\n'));
      const attemptedRemount = await recordGateValidationDelta(projectDir, runId, 'qa_remount');
      expect(attemptedRemount?.pass).toBe(false);
      expect(attemptedRemount?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'failed', exitCode: 1 });
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('original');

      const secondLive = join(root, 'second-live');
      mkdirSync(secondLive);
      writeFileSync(join(secondLive, 'ledger.txt'), 'second-original');
      writeFileSync(join(projectDir, 'test.cjs'), [
        "const fs = require('node:fs');",
        "fs.unlinkSync('linked');",
        `fs.symlinkSync(${JSON.stringify(secondLive)}, 'linked', 'dir');`,
        "fs.writeFileSync('linked/ledger.txt', 'changed');",
      ].join('\n'));
      const retargeted = await recordGateValidationDelta(projectDir, runId, 'qa_retarget');
      expect(retargeted?.pass).toBe(false);
      expect(retargeted?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'failed', exitCode: 1 });
      expect(readFileSync(join(secondLive, 'ledger.txt'), 'utf8')).toBe('second-original');
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('original');
      unlinkSync(join(projectDir, 'linked'));
      symlinkSync(external, join(projectDir, 'linked'));

      const nestedTarget = join(root, 'nested-live');
      mkdirSync(nestedTarget);
      writeFileSync(join(nestedTarget, 'ledger.txt'), 'nested-original');
      symlinkSync(nestedTarget, join(external, 'forward'));
      writeFileSync(join(projectDir, 'test.cjs'), "if (require('node:fs').readFileSync('linked/forward/ledger.txt', 'utf8') !== 'nested-original') process.exit(1);\n");
      const nested = await recordGateValidationDelta(projectDir, runId, 'qa_nested');
      expect(nested?.pass).toBe(false);
      expect(nested?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'launch_error' });
      expect(readFileSync(join(nestedTarget, 'ledger.txt'), 'utf8')).toBe('nested-original');

      unlinkSync(join(projectDir, 'linked'));
      mkdirSync(join(projectDir, 'linked'));
      writeFileSync(join(projectDir, 'test.cjs'), "require('node:fs').writeFileSync('linked/ledger.txt', 'local'); process.exit(1);\n");
      const realFailure = await recordGateValidationDelta(projectDir, runId, 'qa_real_failure');
      expect(realFailure?.pass).toBe(false);
      expect(realFailure?.current.find((entry) => entry.role === 'test')).toMatchObject({ state: 'failed', exitCode: 1 });
      expect(readFileSync(join(projectDir, 'linked/ledger.txt'), 'utf8')).toBe('local');
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a targeted Vitest transient file from failing its concurrent batch, but still fails an authored source write', async () => {
    const previousHome = fcGlobalDir();
    const root = fixture('vite');
    try {
      const home = join(root, 'home');
      const projectDir = join(root, 'project');
      const agentsDir = join(projectDir, 'config', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(join(projectDir, 'node_modules', '.vite-temp'), { recursive: true });
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      setFcGlobalDir(home);
      writeFileSync(join(projectDir, 'config/defaults.yaml'), 'live_constraint_fallback_scan_ms: 100\n');
      for (const role of ['coder', 'planner']) writeFileSync(join(agentsDir, `${role}.yaml`), `name: ${role}\nmodel: default\ntools: []\nprompt: fixture\n`);
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: 'fixture' } }));
      const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const runCase = async (stageIds: string[], writePath: string, declaredInput = false) => {
        const stages = stageIds.map((id) => ({ id, role: 'coder', depends_on: [], scope: [], prompt_template: 'fixture', skills: [], dynamic_dispatch: false, is_gate: false, artifact_contract: { version: 1 as const, produces: [], reads: [], replays: [] } }));
        const config = { name: `vite-${stageIds.length}`, defaults: { max_iterations: 1, max_retries: 0 }, stages };
        const yaml = `name: ${config.name}\nstages:\n${stageIds.map((id) => `  - id: ${id}\n    role: coder\n    scope: []\n    prompt_template: fixture\n    artifact_contract: {version: 1, produces: [], reads: [], replays: []}\n`).join('')}`;
        const created = createRun(projectDir, config.name, yaml, stageIds);
        if (declaredInput) {
          writeFileSync(join(projectDir, writePath), 'protected input');
          writeFileSync(join(home, 'runs', created.runId, 'task_brief.md'), `---\ninputs:\n  - ${writePath}\n---\n`);
        }
        const state = readRunState(projectDir, created.runId);
        state.autoApprove = true;
        state.maxRetries = 0;
        writeRunState(projectDir, created.runId, state);
        const adapter = { async run(_prompt: string, _role: unknown, options: any) {
          if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
          if (options.stageId === stageIds[0]) {
            options.onCommandLifecycle?.({ phase: 'started', id: 'vitest-fixture', command: 'vitest run spec/fixture.test.ts', timestamp: new Date().toISOString() });
            writeFileSync(join(projectDir, writePath), 'fixture');
            await delay(1200);
            if (writePath.endsWith('timestamp-fixture.mjs')) unlinkSync(join(projectDir, writePath));
            options.onCommandLifecycle?.({ phase: 'completed', id: 'vitest-fixture', timestamp: new Date().toISOString() });
          } else await delay(1300);
          return { output: 'stage settled', exitCode: 0, duration_ms: 1200 };
        } } as Adapter;
        const final = await runWorkflow(config as any, yaml, projectDir, adapter, new Map(), undefined, agentsDir, created.runId, '# fixture', true, false);
        return { final: final.status, stages: stageIds.map((id) => readStageStatus(projectDir, created.runId, id)?.status) };
      };
      expect(await runCase(['a', 'b', 'c'], join('node_modules', '.vite-temp', 'vitest.config.ts.timestamp-fixture.mjs')))
        .toEqual({ final: 'complete', stages: ['complete', 'complete', 'complete'] });
      const authored = await runCase(['authored'], 'src/forbidden.ts');
      expect(authored.final).toBe('failed');
      expect(authored.stages).toEqual(['failed']);
      const protectedInput = await runCase(['protected'], join('node_modules', '.vite-temp', 'pinned.json'), true);
      expect(protectedInput.final).toBe('failed');
      expect(protectedInput.stages).toEqual(['failed']);
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('carries an explicit operator prohibition to later stages without spreading ordinary targeted advice', () => {
    const root = fixture('guidance');
    try {
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'operator', knownStageIds: ['fit_one', 'fit_two'], body: 'Do not advance this fit in any later fit window.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'supervisor', knownStageIds: ['fit_one', 'fit_two'], body: 'Do not advance this fit in any later fit window.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'operator', knownStageIds: ['fit_one', 'fit_two'], body: 'Inspect the fit only while working in fit_one.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'supervisor', knownStageIds: ['fit_one', 'fit_two'], body: 'Inspect the fit only while working in fit_one.' });
      const ledger = readFileSync(join(root, 'supervisor_guidance.md'), 'utf8');
      expect(guidanceForStageFromText(ledger, 'fit_two').map((entry) => entry.source)).toEqual(['operator']);
      expect(guidanceForStageFromText(ledger, 'fit_one')).toHaveLength(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('names an empty downstream gate field while still refusing a plan with no downstream gate', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const criteria = { version: 1 as const, briefDigest: 'fixture', criteria: [{ id: criterionId, text: 'Audit the work', line: 1, section: 'Report' }] };
    const stage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({ prompt_template: 'fixture', skills: [], criterion_refs: [], scope: [], is_gate: false, depends_on: [], dependency_reasons: {}, ...raw,
      artifact_contract: { version: 1, produces: raw.is_gate ? [{ id: 'verdict', root: 'run', path: `verdict_${raw.id}.json` }] : [], reads: [], replays: [] } });
    const work = stage({ id: 'work', role: 'coder', criterion_refs: [criterionId], scope: ['src/**'] });
    const gate = stage({ id: 'verify', role: 'qa', is_gate: true, depends_on: ['work'], dependency_reasons: { work: 'audits work' } });
    const missingRefs = inspectDispatchAdmission({ dispatched: [work, gate], baseStages: [], dispatchStageId: 'plan', criteria });
    expect(missingRefs.pass).toBe(false);
    expect(missingRefs.errors.join('\n')).toContain('verify.criterion_refs is empty');
    expect(inspectDispatchAdmission({ dispatched: [work, { ...gate, criterion_refs: [criterionId] }], baseStages: [], dispatchStageId: 'plan', criteria }).pass).toBe(true);
    const absentGate = inspectDispatchAdmission({ dispatched: [{ ...work, criterion_refs: [] }], baseStages: [], dispatchStageId: 'plan', criteria });
    expect(absentGate.pass).toBe(false);
    expect(absentGate.errors.join('\n')).toContain('not assigned to a capable work/finalizer stage');
  });

  it('catches a rounded numeric grep at admission while preserving an exact contractual literal check', async () => {
    const root = fixture('reality');
    try {
      const projectDir = join(root, 'project');
      mkdirSync(projectDir, { recursive: true });
      const report = join(projectDir, 'report.md');
      writeFileSync(report, 'The measured value is 0.1825625.\n');
      const checks = "## Reality checks\n```yaml\nchecks:\n  - name: numeric text\n    type: exec-script-exit-zero\n    reads: [{id: report, root: project, path: report.md, source: {kind: input}}]\n    params:\n      script: |\n        grep '0\\.1826' report.md >/dev/null || exit 1\n```\n";
      const displayBrief = 'The reported measurement is 0.1826 for this checkpoint.';
      expect(inspectRealityChecks(displayBrief, checks).refusingFindings.map((entry) => entry.code))
        .toContain('numeric_display_literal_proxy');
      const actual = await runAllChecks(parseChecksFromMarkdown(checks), { taskDir: root, projectDir });
      expect(actual.pass).toBe(false);
      const exactBrief = 'The report must contain the exact literal 0.1826 as text.';
      expect(inspectRealityChecks(exactBrief, checks).refusingFindings).toEqual([]);
      writeFileSync(report, 'A different measurement appears here.\n');
      expect((await runAllChecks(parseChecksFromMarkdown(checks), { taskDir: root, projectDir })).pass).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps report commands inert and refuses an unsupported declared replay', () => {
    const root = fixture('artifact');
    try {
      const projectDir = join(root, 'project');
      const runDir = join(root, 'run');
      const report = join(projectDir, 'reports/report.md');
      mkdirSync(dirname(report), { recursive: true });
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(projectDir, 'vitest.setup.ts'), 'export {};\n');
      writeFileSync(report, 'The setup file is `vitest.setup.ts`.\n');
      const artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'report', root: 'project', path: 'reports/report.md' }], reads: [], replays: [] });
      const inspect = (contract: ArtifactContract = artifactContract) => inspectStageArtifactContract({ stageId: 'writer', template: 'Write reports/report.md.', projectDir, runDir, writes: ['reports/report.md'], artifactContract: contract });
      const prose = inspect();
      expect(prose.replayExecutions).toEqual([]);
      expect(prose.violations).toEqual([]);
      writeFileSync(report, 'Replay command: `sh unsafe.sh`\n');
      expect(inspect().replayExecutions).toEqual([]);
      expect(inspect().violations).toEqual([]);
      const explicit = inspect({ ...artifactContract, replays: [{ id: 'shell', runner: 'unsupported', targets: ['report'], argv: ['sh', 'unsafe.sh'], expected: { exit_code: 0, failures: [] } }] } as unknown as ArtifactContract);
      expect(explicit.replayExecutions).toEqual([]);
      expect(explicit.violations[0].reason).toContain('ARTIFACT_DECLARATION_INVALID');
      expect(explicit.violations[0].reason).toContain('runner');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes authorized own-run artifacts from writes to another run or shared ledger in the supervisor prompt', () => {
    const prompt = buildSupervisorRolePrompt(600_000, 'Do not modify ~/.fc/ history.');
    expect(prompt).toContain('own run directory');
    expect(prompt).toContain('other runs and shared registry or ledger files');
  });
});
