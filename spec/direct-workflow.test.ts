import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { loadWorkflow, } from '../src/scheduler.js';
import { runPreparedWorkflow as runWorkflow } from './test-support/ready-setup.js';
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
      expect(call.user).toContain('Work-division note (scope)');
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

  // A nonzero exit never completes a run, whatever the base was: spec/validation-ownership.test.ts
  // ('exit-code-only: refuses terminal acceptance for a nonzero final tree') and ('author and repair end first;
  // each tree has one execution') hold the failing side; here the passing record is consumed without a rerun.
  it('consumes the engine record of a passing attempt without a gate rerun', async () => {
    const task = brief('outputs:\n  - docs/report.md');
    const readyPath = writeReadySetupRecord(projectDir, task, fcGlobalDir());
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    ready.validationBaseline.discovery.commands[0].args = ['validation-probe.mjs'];
    ready.validationBaseline.results[0].args = ['validation-probe.mjs'];
    writeFileSync(readyPath, JSON.stringify(ready));
    writeFileSync(join(projectDir, 'validation-probe.mjs'), 'process.exit(0);\n');
    const prompts: string[] = [];
    const final = await runDirect(task, [], false, (prompt, _role, opts) => { if (opts.stageId === 'review') prompts.push(prompt); });
    expect(final.status, final.failureReason).toBe('complete');
    expect(readEvidence(runDir(projectDir, final.runId)).filter(fact => fact.kind === 'validation').at(-1)).toMatchObject({ pass: true, resourceState: 'complete' });
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

  it('reviews a two-defect tree once, gives repair both entries and findings verbatim, then carries untouched evidence', async () => {
    const { config, raw } = loadWorkflow(join(root, 'config', 'workflows', 'direct.yaml'));
    const task = brief('outputs: [docs/report.md]').replace('}]\noutputs:', '},{"id":"stable","text":"Stable evidence remains valid."}]\noutputs:');
    const calls: string[] = [];
    let reviewCount = 0;
    const completeReviewer: Adapter = { async run(prompt, role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        expect(role.prompt).toContain('continue through all brief criteria after finding a defect');
        expect(prompt).toContain('report all findings in one verdict');
        const defects = ['one', 'two'].filter(name => readFileSync(join(projectDir, name), 'utf8') === 'bad');
        const criteria = Object.fromEntries(['fixture_1', 'fixture_2'].map((id, index) => [id,
          { status: defects.includes(['one', 'two'][index]) ? 'fail' : 'pass', evidence: `literal evidence ${index}` }]));
        const stable = ++reviewCount === 1 ? { status: 'pass', evidence: 'stable.txt unchanged' }
          : { status: 'carried', evidence: 'stable.txt unchanged', from: { iteration: 1, round: 1 } };
        if (reviewCount === 2) {
          const facts = JSON.parse(prompt.split('# Gate evaluation facts\n')[1].split('\n')[0]);
          expect(facts.rejections.at(-1).criteria).toMatchObject({ fixture_1: { status: 'fail' }, fixture_2: { status: 'fail' }, stable: { status: 'pass' } });
          expect(facts.repairChangedFiles).toEqual(['docs/report.md', 'one', 'two']);
          expect(prompt).toContain('This is your judgment');
          expect(prompt).not.toContain('Reject again only');
        }
        const findings = defects.map((name, index) => ({ id: name, paths: [name], reason: `verbatim defect ${name}\nwith detail`,
          criterion_ids: [`fixture_${index + 1}`], invalidates_plan: false, repair_role: 'coder' }));
        return { output: JSON.stringify({ pass: defects.length === 0, reason: 'Complete independent review',
          criteria: { ...criteria, stable }, audit_findings: { version: 1, findings },
          ...(defects.length ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Replace both bad values' } } : {}) }), exitCode: 0, duration_ms: 1 };
      }
      if (opts.stageId === 'repair') {
        const facts = JSON.parse(prompt.split('# Gate repair facts\n')[1].split('\n')[0]);
        const original = JSON.parse(readFileSync(facts.rejections[0].verdictPath, 'utf8'));
        expect(facts.rejections[0].criteria).toEqual(original.criteria);
        expect(facts.rejections[0].audit_findings).toEqual(original.audit_findings);
        expect(original.audit_findings.findings.map((finding: { id: string }) => finding.id)).toEqual(['one', 'two']);
        expect(Object.values(original.criteria as Record<string, { status: string }>).filter(entry => entry.status === 'fail')).toHaveLength(2);
      } else writeFileSync(join(projectDir, 'stable.txt'), 'stable');
      for (const name of ['one', 'two']) writeFileSync(join(projectDir, name), opts.stageId === 'repair' ? 'good' : 'bad');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs/report.md'), opts.stageId);
      return { output: JSON.stringify({ status: 'delivered', summary: 'Complete author work', caveats: [], remaining_work: [], blocks: null }),
        exitCode: 0, duration_ms: 1, writes: ['docs/report.md', 'one', 'two', ...(opts.stageId === 'implement' ? ['stable.txt'] : [])], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(config, raw, projectDir, withConfirmedRejections(completeReviewer), new Map(), undefined, agentsDir, undefined, task, true);
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    const directory = runDir(projectDir, final.runId);
    expect(JSON.parse(readFileSync(runRecordPath(directory, 'verdict_review.json'), 'utf8')).criteria.stable)
      .toMatchObject({ status: 'carried', from: { iteration: 1, round: 1 } });
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
    for (const args of [['init', '-q', '--separate-git-dir', join(fixtureRoot, 'git')], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=' + ['fixture', 'example.invalid'].join('@'), 'commit', '-qm', 'Pinned frozen input']]) isolatedProjectCommand('git', args, projectDir, fixtureRoot);
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

  it.each(['notes.md', 'evidence/source.md', 'evidence/new.md', 'alias/source.md'])('fails a frozen input write to %s and restores only pinned Git content', async (path) => {
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
    expect(existsSync(join(projectDir, 'evidence', 'new.md'))).toBe(path === 'evidence/new.md');
    expect(final.stages.implement.attempts?.length).toBeGreaterThan(0);
    const audits = final.stages.implement.attempts!.flatMap(attempt => attempt.constraintAudit
      ? [JSON.parse(readFileSync(runRecordPath(runDir(projectDir, final.runId), attempt.constraintAudit.path), 'utf8'))] : []);
    const canonicalPath = path.replace(/^alias\//, 'evidence/');
    if (path === 'evidence/new.md') expect(audits.flatMap(audit => audit.rollbackFailures)).toContain(canonicalPath);
    else { expect(audits.flatMap(audit => audit.rolledBackWrites)).toContain(canonicalPath); expect(audits.flatMap(audit => audit.rollbackFailures)).toEqual([]); }
  });
});
