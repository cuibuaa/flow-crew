import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { execFileSync } from 'node:child_process';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const root = join(import.meta.dirname, '..');
const agentsDir = join(root, 'config', 'agents');
const authorSession = '12345678-1234-4234-8234-123456789abc';
const reviewerSession = '87654321-4321-4321-8321-cba987654321';
let projectDir: string;
let fixtureRoot: string;
let previousStore: string;

beforeEach(() => {
  setEngineDefaults({});
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-direct-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(fixtureRoot, 'private-store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(fixtureRoot, { recursive: true, force: true }); });

function brief(frontmatter: string): string {
  return ["---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"The greeting added.\"},{\"id\":\"fixture_2\",\"text\":\"The test command and its direct exit code.\"}]", frontmatter, '---', '# Add a greeting', '', '## What the report must show',
    '1. The greeting added.', '2. The test command and its direct exit code.', ''].join('\n');
}

/** Records every adapter call; the gate rejects its first review when asked to. */
function adapter(calls: string[], rejectFirstReview: boolean, observe?: (prompt: string, role: AgentConfig, opts: RunOpts) => void): Adapter {
  let reviews = 0;
  return {
    async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      calls.push(opts.stageId);
      observe?.(prompt, role, opts);
      if (opts.stageId === 'review') {
        const pass = !(rejectFirstReview && ++reviews === 1);
        const { criteria } = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> };
        writeFileSync(stageWorkPath(opts.runDir, 'fixture_verdict_review.json'), JSON.stringify({
          pass, reason: pass ? 'accepted' : 'the greeting is missing',
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'docs/report.md' }])),
        }));
        return fixtureResult({ output: 'reviewed', exitCode: 0, duration_ms: 1, sessionId: reviewerSession }, opts);
      }
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'report.md'), `# Report written by ${opts.stageId}\n`);
      return fixtureResult({ output: `${opts.stageId} done`, exitCode: 0, duration_ms: 1, sessionId: authorSession, writes: ['docs/report.md'], writeAttribution: 'structured' }, opts);
    },
  };
}

async function runDirect(task: string, calls: string[], rejectFirstReview = false, observe?: (prompt: string, role: AgentConfig, opts: RunOpts) => void) {
  const { config, raw } = loadWorkflow(join(root, 'config', 'workflows', 'direct.yaml'));
  return runWorkflow(config, raw, projectDir, withConfirmedRejections(adapter(calls, rejectFirstReview, observe)), new Map(), undefined, agentsDir, undefined, task, true);
}

describe('direct workflow', () => {
  it('keeps the full role and execution contracts on author, independent review and repair calls', async () => {
    const task = brief('outputs:\n  - docs/report.md').replace('---\n#', '---\n\n#');
    const captured: Array<{ id: string; system: string; user: string }> = [];
    const result = await runDirect(task, [], true, (user, role, opts) => {
      captured.push({ id: opts.stageId, system: role.prompt, user });
      expect(opts.outputSchema).toBeDefined();
      if (opts.stageId === 'review') {
        expect(opts.resumeSessionId).not.toBe(authorSession);
        expect(opts.resumeSessionId).toBeUndefined();
        expect(user).toContain('evidence-ledger.jsonl');
        expect(user).toContain('change.diff');
      }
    });
    expect(result.status).toBe('complete');
    expect(captured.map(call => call.id)).toEqual(['implement', 'review', 'repair', 'review']);
    for (const call of captured) {
      expect(call.system).toContain(task.trim());
      expect(call.system).toContain('## Review contract');
      expect(call.system).toContain('Never read or expose secrets');
      if (call.id === 'repair') {
        expect(call.user).toContain('rejected_verdict_review.json');
        expect(call.user).toContain('# Gate repair facts');
      } else {
        expect(call.user).toContain('Canonical brief criteria assigned to this stage');
      }
      expect(call.user).toContain('Planner project-path estimate');
      expect(call.user).toContain('Stage budget:');
      expect(call.user).toContain('# Execution clock');
      expect(call.user).toContain('Engine state query');
      if (call.id === 'review') {
        expect(call.system).toContain('including the limits of the inputs the brief allows');
        expect(call.system).toContain("The author's summary, tests and evidence alone");
        expect(call.system).toContain('independent evidence across the allowed input families and complete observable');
        expect(call.system).toContain('unchanged baseline is the oracle wherever preservation is required');
        expect(call.system).toContain('supplied references and constraints');
      } else {
        expect(call.system).toContain('After the last change, supply relevant evidence');
      }
    }
  });

  it('accepts independent review with a failed command marked unverified without inferring an uncited repair', async () => {
    const task = brief('outputs:\n  - docs/report.md');
    const readyPath = writeReadySetupRecord(projectDir, task, fcGlobalDir());
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    ready.validationBaseline.discovery.commands[0].args = ['validation-probe.mjs'];
    writeFileSync(readyPath, JSON.stringify(ready));
    writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.exit(0);\n');
    for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'base']]) isolatedProjectCommand('git', args, projectDir, fixtureRoot);
    const calls: string[] = [];
    const receipts: string[] = [];
    const final = await runDirect(task, calls, false, (prompt, _role, opts) => {
      if (opts.stageId === 'implement') writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.stderr.write("FAIL spec/new.test.ts\\n"); process.exit(1);\n');
      if (opts.stageId === 'repair') writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.exit(0);\n');
      if (opts.stageId === 'review') {
        expect(prompt).toContain('evidence-ledger.jsonl');
        expect(prompt).toContain('change.diff');
        const ledger = readEvidence(opts.runDir);
        const validation = ledger.filter(entry => entry.kind === 'validation').at(-1)!;
        receipts.push(String(validation.sequence));

      }
    });
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'review']);
    expect(receipts).toHaveLength(1);
    expect(final.validation).toEqual([expect.objectContaining({ exitCode: 1, measurement: 'unverified' })]);
  });

  // A no-regression receipt can still carry commands that failed or never ran
  // (a red baseline that stays red); only passing commands make a rerun redundant.
  it.each([
    { state: 'passed', probe: 'process.exit(0);\n', rerunAdvised: false },
    { state: 'failed', probe: 'process.exit(1);\n', rerunAdvised: true },
  ])('consumes recorded commands without a gate rerun when the attempt is $state', async ({ state, probe, rerunAdvised }) => {
    const task = brief('outputs:\n  - docs/report.md');
    const readyPath = writeReadySetupRecord(projectDir, task, fcGlobalDir());
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    ready.validationBaseline.discovery.commands[0].args = ['validation-probe.mjs'];
    if (state === 'failed') {
      ready.validationBaseline.results[0] = { ...ready.validationBaseline.results[0], state: 'failed', exitCode: 1, failureIdentity: 'unknown' };
      ready.validationBaseline.gateCriteria[0] = { role: 'build', rule: 'no_regression_from_baseline', baselineFailureIdentifiers: [], description: 'Fixture build failed at baseline' };
    }
    writeFileSync(readyPath, JSON.stringify(ready));
    writeFileSync(join(projectDir, 'validation-probe.mjs'), probe);
    const prompts: string[] = [];
    const final = await runDirect(task, [], false, (prompt, _role, opts) => { if (opts.stageId === 'review') prompts.push(prompt); });
    expect(final.status, final.failureReason).toBe('complete');
    if (state === 'failed') expect(readEvidence(runDir(projectDir, final.runId)).filter(fact => fact.kind === 'validation').at(-1)?.pass).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('evidence-ledger.jsonl');
    expect(prompts[0]).toContain('change.diff');
    expect(prompts[0]).toContain('decisions consume its tree-bound results without rerunning the suite');

  });

  it('cannot accept a missing declared output even when the reviewer accepts', async () => {
    const { config, raw } = loadWorkflow(join(root, 'config', 'workflows', 'direct.yaml'));
    const accepting = adapter([], false);
    const final = await runWorkflow(config, raw, projectDir, {
      async run(prompt, role, opts) {
        if (opts.stageId === 'implement' || opts.stageId === 'repair') {
          return fixtureResult({ output: 'delivered', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
        }
        return accepting.run(prompt, role, opts);
      },
    }, new Map(), undefined, agentsDir, undefined, brief('outputs:\n  - docs/report.md'), true);
    expect(final.status).not.toBe('complete');
    expect(final.stages.implement.status).toBe('failed');
    expect(final.stages.implement.error).toContain('DECLARED_OUTPUT_REQUIRED');
    expect(existsSync(runRecordPath(runDir(projectDir, final.runId), 'verdict_review.json'))).toBe(false);
    expect(existsSync(join(projectDir, 'docs', 'report.md'))).toBe(false);
  });

  it('admits its fixed plan without a planner call and repairs a rejection like a planned run', async () => {
    const calls: string[] = [];
    const final = await runDirect(brief('outputs:\n  - docs/report.md'), calls, true);
    const directory = runDir(projectDir, final.runId);
    const criteria = (JSON.parse(readFileSync(runRecordPath(directory, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> }).criteria.map(({ id }) => id);
    const admission = JSON.parse(readFileSync(runRecordPath(directory, 'dispatch_admission.json'), 'utf8')) as { pass: boolean; criterionGateRefs: Record<string, string[]> };

    expect(final.status).toBe('complete');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(final.stages.plan).toMatchObject({ status: 'complete' });
    expect(final.stages.plan.attempts ?? []).toEqual([]);
    expect(criteria).toHaveLength(2);
    expect(admission).toMatchObject({ pass: true, criterionGateRefs: { review: criteria } });
    expect(existsSync(runRecordPath(directory, 'declared_outputs', 'docs', 'report.md'))).toBe(true);
  });

  it('refuses malformed declarations before claiming a run or invoking a stage', async () => {
    const calls: string[] = [];
    await expect(runDirect(brief('inputs: [{path: source.txt, typo: true}]'), calls)).rejects.toThrow('typo');
    expect(calls).toEqual([]);
  });

  it('authors and repairs with declared read-only files and trees without a planner call', async () => {
    mkdirSync(join(projectDir, 'evidence'));
    writeFileSync(join(projectDir, 'evidence', 'source.md'), 'frozen evidence\n');
    writeFileSync(join(projectDir, 'notes.md'), 'frozen notes\n');
    const calls: string[] = [];
    const final = await runDirect(brief('inputs:\n  - {path: notes.md, frozen: true}\n  - {path: evidence, frozen: true}\noutputs: [docs/report.md]') + '\nKeep all declared inputs frozen.\n', calls, true);
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('frozen notes\n');
    expect(readFileSync(join(projectDir, 'evidence', 'source.md'), 'utf8')).toBe('frozen evidence\n');
  });

  it('rejects frozen input corruption across repairs while restoring exact bytes', async () => {
    writeFileSync(join(projectDir, 'notes.md'), 'frozen notes\n');
    const final = await runDirect(brief('inputs: [{path: notes.md, frozen: true}]\noutputs: [docs/report.md]') + '\nKeep all declared inputs frozen.\n', [], false, (_prompt, _role, opts) => {
      if (opts.stageId === 'implement' || opts.stageId === 'repair') {
        writeFileSync(join(projectDir, 'notes.md'), 'unauthorized\n');
      }
    });
    expect(final.status).not.toBe('complete');
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('frozen notes\n');
    const audits = Object.values(final.stages).flatMap(stage => stage.attempts ?? [])
      .flatMap(attempt => attempt.constraintAudit
        ? [JSON.parse(readFileSync(runRecordPath(runDir(projectDir, final.runId), attempt.constraintAudit.path), 'utf8'))] : []);
    expect(audits.flatMap(audit => audit.rollbackFailures)).toEqual([]);
    expect(audits.flatMap(audit => audit.rolledBackWrites)).toContain('notes.md');
  });

  it.each(['notes.md', 'evidence/source.md', 'evidence/new.md', 'alias/source.md'])('restores an input write to %s despite broad scope', async (path) => {
    mkdirSync(join(projectDir, 'evidence'));
    writeFileSync(join(projectDir, 'notes.md'), 'frozen notes\n');
    writeFileSync(join(projectDir, 'evidence', 'source.md'), 'frozen evidence\n');
    symlinkSync('evidence', join(projectDir, 'alias'));
    // Existing Git objects provide rollback without copying read-only inputs.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { execFileSync } from 'node:child_process';
      for (const args of [
        ['init', '-q'], ['add', '.'],
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'],
      ]) execFileSync('git', args);
    `], { cwd: projectDir, env: { ...process.env, HOME: fixtureRoot, FC_HOME: join(fixtureRoot, 'private-store') } });
    const final = await runDirect(brief('inputs:\n  - {path: notes.md, frozen: true}\n  - {path: evidence, frozen: true}\noutputs: [docs/report.md]') + '\nKeep all declared inputs frozen.\n', [], false, (_prompt, _role, opts) => {
      if (opts.stageId === 'implement' || opts.stageId === 'repair') writeFileSync(join(projectDir, path), 'unauthorized\n');
    });
    expect(final.status).not.toBe('complete');
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('frozen notes\n');
    expect(readFileSync(join(projectDir, 'evidence', 'source.md'), 'utf8')).toBe('frozen evidence\n');
    expect(existsSync(join(projectDir, 'evidence', 'new.md'))).toBe(false);
    expect(final.stages.implement.attempts?.length).toBeGreaterThan(0);
    const audits = final.stages.implement.attempts!.flatMap(attempt => attempt.constraintAudit
      ? [JSON.parse(readFileSync(runRecordPath(runDir(projectDir, final.runId), attempt.constraintAudit.path), 'utf8'))] : []);
    const canonicalPath = path.replace(/^alias\//, 'evidence/');
    expect(audits.flatMap(audit => audit.rolledBackWrites)).toContain(canonicalPath);
    expect(audits.flatMap(audit => audit.rollbackFailures)).toEqual([]);
  });
});
