import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { appendGuidanceEnvelope, guidanceForStageFromText } from '../src/guidance.js';
import { runProjectValidationBaseline } from '../src/project-validation.js';

import { fcGlobalDir, setFcGlobalDir, type StoreState } from '../src/store.js';
import { inspectDispatchAdmission, parseDispatchedStageConfig, recordGateValidationDelta, tryAdvanceResearch } from '../src/scheduler.js';

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
          storageLayout: 2, runId, status: 'running', startedAt: new Date(Date.now() - 2_000).toISOString(), stages: {},
          research: { baseline: 0, policy: 'greedy_stack', higherIsBetter: true,
            resultFile: resultRel, reportDir: 'research',
            stop: { beat: 0.1, maxRounds: 1, haltAfterNoImprovement: 1 },
            confirm: { command: `node confirm.cjs ${resultRel}`, requires: 'result and evidence match', timeoutSeconds: 10 } },
        } as StoreState;
        writeFileSync(join(runDirPath, 'run.json'), JSON.stringify(state));
        mkdirSync(join(runDirPath, 'engine'), { recursive: true });
        const { beginResearchInputGeneration } = await import('../src/research-candidate.js');
        beginResearchInputGeneration(projectDir, state);
        writeFileSync(join(projectDir, resultRel), JSON.stringify(caseName === 'confirmed'
          ? { label: 'measured', result: 0.25 }
          : { label: 'measured', result: 0.25, evidence: evidencePath }));
        writeFileSync(join(projectDir, 'research/evidence.json'), JSON.stringify({ label: 'measured', result: evidenceScore, primary: true, confirmation: true }));
        const terminal = await tryAdvanceResearch(state, {
          projectDir, runId, runDirPath, iteration: 1, adapter: new ScriptedAdapter({}),
        });
        const confirmation = JSON.parse(readFileSync(runRecordPath(runDirPath, 'research_confirm.json'), 'utf8'));
        const manifest = JSON.parse(readFileSync(join(projectDir, 'research/run_manifest.json'), 'utf8'));
        const consumed = JSON.parse(readFileSync(runRecordPath(runDirPath, 'research_round_1_consumed.json'), 'utf8'));
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

  it('allows ordinary linked-input writes and still fails a contained regression', async () => {
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
      writeFileSync(runRecordPath(runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), source: 'ship-setup-ready-record', baseline }));
      const readable = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(readable?.results.every(result => result.state === 'passed' || result.state === 'not_configured'), JSON.stringify(readable)).toBe(true);
      expect(readable?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });

      writeFileSync(join(projectDir, 'test.cjs'), "require('node:fs').writeFileSync('linked/ledger.txt', 'changed');\n");
      const blocked = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(blocked?.results.every(result => result.state === 'passed' || result.state === 'not_configured')).toBe(true);
      expect(blocked?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('changed');

      writeFileSync(join(projectDir, 'test.cjs'), [
        "const { spawnSync } = require('node:child_process');",
        `const remount = spawnSync('mount', ['-o', 'remount,bind,rw', ${JSON.stringify(external)}]);`,
        "if (remount.status === 0) process.exit(88);",
        "require('node:fs').writeFileSync('linked/ledger.txt', 'changed');",
      ].join('\n'));
      const attemptedRemount = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(attemptedRemount?.results.every(result => result.state === 'passed' || result.state === 'not_configured')).toBe(true);
      expect(attemptedRemount?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('changed');

      const secondLive = join(root, 'second-live');
      mkdirSync(secondLive);
      writeFileSync(join(secondLive, 'ledger.txt'), 'second-original');
      writeFileSync(join(projectDir, 'test.cjs'), [
        "const fs = require('node:fs');",
        "fs.unlinkSync('linked');",
        `fs.symlinkSync(${JSON.stringify(secondLive)}, 'linked', 'dir');`,
        "fs.writeFileSync('linked/ledger.txt', 'changed');",
      ].join('\n'));
      const retargeted = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(retargeted?.results.every(result => result.state === 'passed' || result.state === 'not_configured')).toBe(true);
      expect(retargeted?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });
      expect(readFileSync(join(secondLive, 'ledger.txt'), 'utf8')).toBe('changed');
      expect(readFileSync(join(external, 'ledger.txt'), 'utf8')).toBe('changed');
      unlinkSync(join(projectDir, 'linked'));
      symlinkSync(external, join(projectDir, 'linked'));

      const nestedTarget = join(root, 'nested-live');
      mkdirSync(nestedTarget);
      writeFileSync(join(nestedTarget, 'ledger.txt'), 'nested-original');
      symlinkSync(nestedTarget, join(external, 'forward'));
      writeFileSync(join(projectDir, 'test.cjs'), "if (require('node:fs').readFileSync('linked/forward/ledger.txt', 'utf8') !== 'nested-original') process.exit(1);\n");
      const nested = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(nested?.results.every(result => result.state === 'passed' || result.state === 'not_configured')).toBe(true);
      expect(nested?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });
      expect(readFileSync(join(nestedTarget, 'ledger.txt'), 'utf8')).toBe('nested-original');

      unlinkSync(join(projectDir, 'linked'));
      mkdirSync(join(projectDir, 'linked'));
      writeFileSync(join(projectDir, 'test.cjs'), "require('node:fs').writeFileSync('linked/ledger.txt', 'local'); process.exit(1);\n");
      const realFailure = await runProjectValidationBaseline(projectDir, { commands: [command] });
      expect(realFailure?.results.every(result => result.state === 'passed' || result.state === 'not_configured')).toBe(false);
      expect(realFailure?.results.find((entry) => entry.role === 'test')).toMatchObject({ state: 'failed', exitCode: 1 });
      expect(readFileSync(join(projectDir, 'linked/ledger.txt'), 'utf8')).toBe('local');
    } finally {
      setFcGlobalDir(previousHome);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes operator rulings by the declared target, independently of prohibition wording', () => {
    const root = fixture('guidance');
    try {
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'operator', knownStageIds: ['fit_one', 'fit_two'], body: 'Do not advance this fit in any later fit window.' });
      const runWide = appendGuidanceEnvelope({ runDir: root, target: '*', source: 'operator', knownStageIds: ['fit_one', 'fit_two'], body: 'Keep this ruling in every stage.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'supervisor', knownStageIds: ['fit_one', 'fit_two'], body: 'Do not advance this fit in any later fit window.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'operator', knownStageIds: ['fit_one', 'fit_two'], body: 'Inspect the fit only while working in fit_one.' });
      appendGuidanceEnvelope({ runDir: root, target: 'fit_one', source: 'supervisor', knownStageIds: ['fit_one', 'fit_two'], body: 'Inspect the fit only while working in fit_one.' });
      const ledger = readFileSync(join(root, 'supervisor_guidance.md'), 'utf8');
      expect(guidanceForStageFromText(ledger, 'fit_two').map((entry) => entry.id)).toEqual([runWide.id]);
      expect(guidanceForStageFromText(ledger, 'fit_one')).toHaveLength(5);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('assigns omitted downstream coverage while refusing a plan with no gate', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const criteria = { version: 1 as const, briefDigest: 'fixture', criteria: [{ id: criterionId, text: 'Audit the work', line: 1, section: 'Report' }] };
    const stage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({ prompt_template: 'fixture', skills: [], criterion_refs: [], scope: [], is_gate: false, depends_on: [], dependency_reasons: {}, ...raw,
      artifact_contract: { version: 1, produces: raw.is_gate ? [{ id: 'verdict', root: 'run', path: `verdict_${raw.id}.json` }] : [], reads: [] } });
    const work = stage({ id: 'work', role: 'coder', criterion_refs: [criterionId], scope: ['src/**'] });
    const gate = stage({ id: 'verify', role: 'qa', is_gate: true, depends_on: ['work'], dependency_reasons: { work: 'audits work' } });
    const repair = stage({ id: 'repair', role: 'coder', scope: ['src/**'], depends_on: ['verify'], dependency_reasons: { verify: 'Repairs rejected work' }, retry_to: ['verify'] });
    const missingRefs = inspectDispatchAdmission({ dispatched: [work, gate, repair], baseStages: [], dispatchStageId: 'plan', criteria });
    expect(missingRefs.pass).toBe(true);
    expect(gate.criterion_refs).toEqual([criterionId]);
    expect(inspectDispatchAdmission({ dispatched: [work, { ...gate, criterion_refs: [criterionId] }, repair], baseStages: [], dispatchStageId: 'plan', criteria }).pass).toBe(true);
    const absentGate = inspectDispatchAdmission({ dispatched: [{ ...work, criterion_refs: [] }], baseStages: [], dispatchStageId: 'plan', criteria });
    expect(absentGate.pass).toBe(false);
    expect(absentGate.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('not assigned to a gate');
  });
});
