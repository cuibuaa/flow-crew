import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
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
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-direct-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(fixtureRoot, 'private-store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(fixtureRoot, { recursive: true, force: true }); });

function brief(frontmatter: string): string {
  return ['---', frontmatter, '---', '# Add a greeting', '', '## What the report must show',
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
        const { criteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> };
        writeFileSync(join(opts.runDir, 'fixture_verdict_review.json'), JSON.stringify({
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
  return runWorkflow(config, raw, projectDir, adapter(calls, rejectFirstReview, observe), new Map(), undefined, agentsDir, undefined, task, true);
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
        if (captured.filter(call => call.id === 'review').length === 1) {
          expect(opts.resumeSessionId).not.toBeDefined();
          expect(user).toContain('Previous stage: implement');
        } else if (opts.resumeSessionId) {
          expect(opts.resumeSessionId).toBe(reviewerSession);
          expect(opts.sessionOwnerStageId).toBe('review');
        }
      }
    });
    expect(result.status).toBe('complete');
    expect(captured.map(call => call.id)).toEqual(['implement', 'review', 'repair', 'review']);
    for (const call of captured) {
      expect(call.system).toContain(task.trim());
      expect(call.system).toContain('## Review contract');
      expect(call.system).toContain('Never read or expose secrets');
      if (call.id === 'repair') {
        expect(call.user).toContain('archived rejected verdict:');
        expect(call.user).toContain('Gate repair round 1');
      } else {
        expect(call.user).toContain('Canonical brief criteria assigned to this stage');
      }
      expect(call.user).toContain('scope_revision_request');
      expect(call.user).toContain('Stage budget:');
      expect(call.user).toContain('# Execution clock');
      expect(call.user).toContain('Engine state query');
      if (call.id === 'review') {
        expect(call.system).toContain('including the limits of the inputs the brief allows');
        expect(call.system).toContain("The author's summary, tests and evidence alone");
        expect(call.system).toContain('independent evidence across the allowed input families and complete observable');
        expect(call.system).toContain('unchanged baseline is the oracle wherever preservation is required');
        expect(call.system).toContain('supplied references and constraints');
        expect(call.user).toContain('Quantified-remedy feasibility contract');
      } else {
        expect(call.system).toContain('After the last change, supply relevant evidence');
      }
    }
  });

  it('rejects a model acceptance on an engine-observed regression and repairs the concrete failure', async () => {
    const task = brief('outputs:\n  - docs/report.md');
    const readyPath = writeReadySetupRecord(projectDir, task, fcGlobalDir());
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    ready.validationBaseline.discovery.commands[0].args = ['validation-probe.mjs'];
    writeFileSync(readyPath, JSON.stringify(ready));
    const calls: string[] = [];
    const receipts: string[] = [];
    const final = await runDirect(task, calls, false, (prompt, _role, opts) => {
      if (opts.stageId === 'implement') writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.stderr.write("FAIL spec/new.test.ts\\n"); process.exit(1);\n');
      if (opts.stageId === 'repair') writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.exit(0);\n');
      if (opts.stageId === 'review') {
        expect(prompt).toContain('Engine validation:');
        expect(prompt).toContain('exit=');
        const receipt = prompt.match(/Receipt: (.+?\.json)/)?.[1];
        expect(receipt).toBeDefined();
        receipts.push(receipt!);
        expect(JSON.parse(readFileSync(receipt!, 'utf8')).current[0].exitCode).toBe(0);
      }
    });
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'repair', 'review']);
    expect(receipts).toHaveLength(1);
  });

  // A no-regression receipt can still carry commands that failed or never ran
  // (a red baseline that stays red); only passing commands make a rerun redundant.
  it.each([
    { state: 'passed', probe: 'process.exit(0);\n', rerunAdvised: false },
    { state: 'failed', probe: 'process.exit(1);\n', rerunAdvised: true },
  ])('advises against rerunning configured commands only when they $state', async ({ state, probe, rerunAdvised }) => {
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
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Engine validation: pass=true');
    expect(prompts[0]).toContain(`exit=${state === 'passed' ? 0 : 1}, state=${state}`);
    expect(prompts[0]).toContain("(each command's result and output tail)");
    expect(prompts[0].includes('Do not rerun configured commands')).toBe(!rerunAdvised);
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
    expect(existsSync(join(runDir(projectDir, final.runId), 'verdict_review.json'))).toBe(false);
    expect(existsSync(join(projectDir, 'docs', 'report.md'))).toBe(false);
  });

  it('admits its fixed plan without a planner call and repairs a rejection like a planned run', async () => {
    const calls: string[] = [];
    const final = await runDirect(brief('outputs:\n  - docs/report.md'), calls, true);
    const directory = runDir(projectDir, final.runId);
    const criteria = (JSON.parse(readFileSync(join(directory, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> }).criteria.map(({ id }) => id);
    const admission = JSON.parse(readFileSync(join(directory, 'dispatch_admission.json'), 'utf8')) as { pass: boolean; criterionGateRefs: Record<string, string[]> };

    expect(final.status).toBe('complete');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(final.stages.plan).toMatchObject({ status: 'complete' });
    expect(final.stages.plan.attempts ?? []).toEqual([]);
    expect(criteria).toHaveLength(2);
    expect(admission).toMatchObject({ pass: true, criterionGateRefs: { review: criteria } });
    expect(existsSync(join(directory, 'declared_outputs', 'docs', 'report.md'))).toBe(true);
  });

  it('refuses at admission a brief its fixed plan cannot satisfy, before any stage runs', async () => {
    const refusals: Array<[string, string]> = [
      ['workflow: direct\nresearch:\n  baseline: 0.5', 'direct cannot run the research loop'],
      ['workflow: direct\nprogram:\n  name: study\n  phase: first', 'direct cannot run the program loop'],
    ];
    for (const [frontmatter, reason] of refusals) {
      const calls: string[] = [];
      const final = await runDirect(brief(frontmatter), calls);
      expect(['failed', 'escalated']).toContain(final.status);
      const admissionPath = join(runDir(projectDir, final.runId), 'dispatch_admission.json');
      const errors = existsSync(admissionPath) ? JSON.parse(readFileSync(admissionPath, 'utf8')).errors : [];
      expect([final.failureReason, ...errors].join('\n')).toContain(reason);
      expect(calls).toEqual([]);
    }
  });

  it('authors and repairs with declared read-only files and trees without a planner call', async () => {
    mkdirSync(join(projectDir, 'evidence'));
    writeFileSync(join(projectDir, 'evidence', 'source.md'), 'frozen evidence\n');
    writeFileSync(join(projectDir, 'notes.md'), 'frozen notes\n');
    const calls: string[] = [];
    const final = await runDirect(brief('workflow: direct\ninputs: [notes.md, evidence]\noutputs: [docs/report.md]'), calls, true);
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('frozen notes\n');
    expect(readFileSync(join(projectDir, 'evidence', 'source.md'), 'utf8')).toBe('frozen evidence\n');
  });

  it('keeps an unrestored input violation blocking completion across repairs', async () => {
    writeFileSync(join(projectDir, 'notes.md'), 'frozen notes\n');
    const final = await runDirect(brief('workflow: direct\ninputs: [notes.md]\noutputs: [docs/report.md]'), [], false, (_prompt, _role, opts) => {
      if (opts.stageId === 'implement' || opts.stageId === 'repair') {
        writeFileSync(join(projectDir, 'notes.md'), 'unauthorized\n');
      }
    });
    expect(final.status).not.toBe('complete');
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('unauthorized\n');
    const audits = Object.values(final.stages).flatMap(stage => stage.attempts ?? [])
      .flatMap(attempt => attempt.constraintAudit
        ? [JSON.parse(readFileSync(join(runDir(projectDir, final.runId), attempt.constraintAudit.path), 'utf8'))] : []);
    expect(audits.flatMap(audit => audit.rollbackFailures)).toContain('notes.md');
    expect(audits.flatMap(audit => audit.rolledBackWrites)).not.toContain('notes.md');
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
    const final = await runDirect(brief('workflow: direct\ninputs: [notes.md, evidence]\noutputs: [docs/report.md]'), [], false, (_prompt, _role, opts) => {
      if (opts.stageId === 'implement' || opts.stageId === 'repair') writeFileSync(join(projectDir, path), 'unauthorized\n');
    });
    expect(final.status).not.toBe('complete');
    expect(readFileSync(join(projectDir, 'notes.md'), 'utf8')).toBe('frozen notes\n');
    expect(readFileSync(join(projectDir, 'evidence', 'source.md'), 'utf8')).toBe('frozen evidence\n');
    expect(existsSync(join(projectDir, 'evidence', 'new.md'))).toBe(false);
    expect(final.stages.implement.attempts?.length).toBeGreaterThan(0);
    const audits = final.stages.implement.attempts!.flatMap(attempt => attempt.constraintAudit
      ? [JSON.parse(readFileSync(join(runDir(projectDir, final.runId), attempt.constraintAudit.path), 'utf8'))] : []);
    const canonicalPath = path.replace(/^alias\//, 'evidence/');
    expect(audits.flatMap(audit => audit.rolledBackWrites)).toContain(canonicalPath);
    expect(audits.flatMap(audit => audit.rollbackFailures)).toEqual([]);
  });
});
