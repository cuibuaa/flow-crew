import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFinalMessage, generateRunSummary } from '../src/run-summary.js';
import type { Adapter } from '../src/adapters/base.js';
import { archiveGateRoundEvidence } from '../src/scheduler/sched_settlement/gate-archives.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

describe('extractFinalMessage', () => {
  it('returns claude-style clean output unchanged', () => {
    const clean = '## What was done\n- a\n- b';
    expect(extractFinalMessage(clean)).toBe(clean);
  });

  it('recovers the final agent message from a codex transcript', () => {
    // Codex echoes the whole prompt (which itself contains prior `codex` /
    // `tokens used` markers from polluted stage outputs), then the real answer.
    const raw = [
      'OpenAI Codex v0.130.0',
      'user',
      '# Stage Results',
      '## Stage: plan',
      'codex',           // marker inside the echoed prompt — must be ignored
      'old stage answer',
      'tokens used',
      '111,485',
      '# Dispatch Plan',
      '  some yaml',
      '',
      'codex',           // the real final turn
      '## What was tried & learned',
      '- the real answer',
      'tokens used',
      '6,883',
      '## What was tried & learned',  // duplicate reprint after footer
      '- the real answer',
    ].join('\n');
    expect(extractFinalMessage(raw)).toBe('## What was tried & learned\n- the real answer');
  });

  it('drops the tokens-used footer even without a leading codex marker', () => {
    const raw = '## Next steps\n- ship it\ntokens used\n42';
    expect(extractFinalMessage(raw)).toBe('## Next steps\n- ship it');
  });
});

describe('Reality-Gate advisory summary', () => {
  it('keeps terminal and active stage data in the summary while naming omitted optional history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-summary-optional-history-'));
    const previousFcGlobalDir = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'fc-home'));
      const projectDir = join(root, 'project'); mkdirSync(projectDir);
      const created = createRun(projectDir, 'test', 'name: test', ['active_work']);
      const path = join(runDir(projectDir, created.runId), 'run.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.status = 'complete'; state.supervise = false;
      state.stages.active_work = { status: 'complete', retries: 0 };
      state.retiredStageUsage = [{ stageId: 'work', iteration: 'damaged-optional-iteration', status: { status: 'failed', retries: 0 } }];
      writeFileSync(path, JSON.stringify(state));
      const summary = await generateRunSummary(projectDir, created.runId, {
        run: async () => ({ output: '## What was done\n- deterministic narrative', exitCode: 0, duration_ms: 1 }),
      });
      expect(summary).toContain('active_work: complete');
      expect(summary).toContain('RUN_STAGE_HISTORY_INVALID: retiredStageUsage[0]: optional history omitted');
      expect(summary).not.toContain('work [iteration');
    } finally {
      setFcGlobalDir(previousFcGlobalDir);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('renders failed advisory checks into the deterministic run summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-summary-advisory-'));
    const previousFcGlobalDir = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'fc-home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir);
      const created = createRun(projectDir, 'test', 'name: test', []);
      const state = readRunState(projectDir, created.runId);
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, created.runId, state);
      writeFileSync(join(runDir(projectDir, created.runId), '.reality-gate.json'), JSON.stringify({
        pass: true,
        checkedAt: new Date().toISOString(),
        checksRun: 1,
        results: [{
          name: 'authentication-wording',
          type: 'exec-script-exit-zero',
          pass: false,
          advisory: true,
          details: 'script exited 1',
        }],
      }, null, 2), 'utf-8');
      const adapter: Adapter = {
        run: async () => ({
          output: '## What was done\n- completed with an advisory',
          exitCode: 0,
          duration_ms: 1,
        }),
      };

      const summary = await generateRunSummary(projectDir, created.runId, adapter);

      expect(summary).toContain('## Reality-Gate advisories');
      expect(summary).toContain('authentication-wording');
      expect(summary).toContain('script exited 1');
    } finally {
      setFcGlobalDir(previousFcGlobalDir);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders archived iteration records without asking a model to rewrite them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-summary-stage-evidence-'));
    const previousFcGlobalDir = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'fc-home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir);
      const created = createRun(projectDir, 'test', 'name: test', ['active_work']);
      const state = readRunState(projectDir, created.runId);
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      state.supervise = false;
      state.stages.active_work = { status: 'complete', retries: 0, duration_ms: 2_000 };
      const evidenceRoot = 'stage_evidence/iteration_1/retired';
      state.stageEvidence = [{
        iteration: 1,
        stageId: 'retired_work',
        status: {
          status: 'complete',
          retries: 0,
          duration_ms: 1_000,
          attempts: [{
            index: 1,
            startedAt: '2026-08-12T00:00:00.000Z',
            completedAt: '2026-08-12T00:00:01.000Z',
            status: 'complete',
            duration_ms: 1_000,
            exitCode: 0,
          }],
        },
        statusPath: `${evidenceRoot}/status.json`,
        outputPath: `${evidenceRoot}/output.md`,
        attemptOutputPaths: [{ attemptIndex: 1, path: `${evidenceRoot}/output_attempt_1.md` }],
      }];
      state.retiredStageUsage = [
        { stageId: 'retired_work', iteration: 1, status: state.stageEvidence[0].status },
        { stageId: 'legacy_work', iteration: 0, status: { status: 'failed', retries: 0 } },
      ];
      writeRunState(projectDir, created.runId, state);
      const evidenceDir = join(runDir(projectDir, created.runId), evidenceRoot);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'output.md'), JSON.stringify({ status: 'delivered', summary: 'historical output remains reachable', files_modified: [], checks: [], caveats: ['historical caveat'] }), 'utf-8');
      writeFileSync(join(runDir(projectDir, created.runId), 'stages', 'active_work', 'output.md'), 'active output', 'utf-8');
      let narrativePrompt = '';
      const adapter: Adapter = {
        run: async (prompt) => {
          narrativePrompt = prompt;
          return {
            output: '## What was done\n- summarized active and historical evidence',
            exitCode: 0,
            duration_ms: 1,
          };
        },
      };

      const summary = await generateRunSummary(projectDir, created.runId, adapter);

      expect(summary).toContain('retired_work [iteration 1, archived]: complete');
      expect(summary?.split('## Stages')[1].match(/retired_work \[iteration 1, archived\]:/g)).toHaveLength(1);
      expect(summary).toContain('legacy_work [iteration 0, archived]: failed');
      expect(narrativePrompt).toBe('');
      expect(summary).toContain('historical output remains reachable');
      expect(summary).toContain('historical caveat');
      expect(summary).toContain('stage_evidence/iteration_1/retired/output.md');
    } finally {
      setFcGlobalDir(previousFcGlobalDir);
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// The engine must preserve what was verified, failed and left open without a
// second authoring call or inferring verification from prose.
async function terminalFixture(check: (projectDir: string, runId: string, directory: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-summary-results-'));
  const previous = fcGlobalDir();
  try {
    setFcGlobalDir(join(root, 'fc-home'));
    const project = join(root, 'project'); mkdirSync(project);
    const created = createRun(project, 'test', 'name: test', ['work', 'review']);
    const state = readRunState(project, created.runId);
    state.status = 'complete'; state.completedAt = new Date().toISOString();
    state.stages.work = { status: 'complete', retries: 0 };
    state.stages.review = { status: 'complete', retries: 0 };
    writeRunState(project, created.runId, state);
    await check(project, created.runId, runDir(project, created.runId));
  } finally { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); }
}

function workRecord(summary = 'Added the greeting.') {
  return { status: 'delivered', summary, files_modified: ['greeting.txt'],
    checks: [{ command: 'node check.mjs', exit_code: 7, evidence: 'probe/check.stdout' }],
    caveats: ['The optional locale check remains open.'] };
}

function gateRecord(pass: boolean) {
  return { pass, reason: pass ? 'Greeting verified.' : 'Greeting missing.',
    criteria: { greeting: { status: pass ? 'pass' : 'fail', evidence: 'greeting.txt:1' } },
    audit_findings: { version: 1, findings: pass ? [] : [{ id: 'missing', paths: ['greeting.txt'],
      reason: 'Greeting missing.', criterion_ids: ['greeting'], invalidates_plan: false, repair_role: 'coder' }] },
    ...(pass ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: 'greeting.txt absent' } }) };
}

describe('engine-assembled terminal reports', () => {
  it.each(['incomplete', 'complete'] as const)('retains an engine rejection of an authored PASS when the run is %s', async status => {
    await terminalFixture(async (project, id, directory) => {
      const state = readRunState(project, id); state.status = status;
      if (status === 'incomplete') state.failureReason = 'Bounded repair attempts exhausted.';
      writeRunState(project, id, state);
      const reason = 'verdict/metric.json mismatch: metric says fail, verdict says pass';
      writeFileSync(join(directory, 'stages/review/output.md'), JSON.stringify(gateRecord(true)));
      writeFileSync(join(directory, 'verdict_review.json'), JSON.stringify(gateRecord(true)));
      archiveGateRoundEvidence(directory, { iteration: 1, round: 1 }, ['review'],
        new Map([['review', { pass: false, reason }]]));
      if (status === 'complete') {
        writeFileSync(join(directory, 'stages/review/output.md'), JSON.stringify({ ...gateRecord(true), reason: 'Repair verified.' }));
        archiveGateRoundEvidence(directory, { iteration: 2, round: 1 }, ['review'],
          new Map([['review', { pass: false, reason: 'A later contract refusal.' }]]));
      }
      const report = await generateRunSummary(project, id);
      expect(report).toContain(`Status: **${status}**`);
      expect(report).toContain('Independent verdict: PASS');
      expect(report).toContain('Archived authored verdict: PASS');
      expect(report).toContain(`Engine effective verdict: FAIL — ${reason}`);
      expect(report).toContain('review [iteration 1, round 1]');
      expect(report).toContain('gate_reevaluation/iteration_1/round_1/engine_verdict_review.json');
      expect(report).toContain('gate_reevaluation/iteration_1/round_1/rejected_verdict_review.json');
      if (status === 'complete') {
        expect(report).toContain('Independent verdict: PASS — Repair verified.');
        expect(report).toContain('review [iteration 2, round 1]');
        expect(report).toContain('A later contract refusal.');
      }
    });
  });

  it.each(['missing', 'invalid'])('links an archived rejection with a %s engine record without guessing its conclusion', async condition => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, 'verdict_review.json'), JSON.stringify(gateRecord(true)));
      archiveGateRoundEvidence(directory, { iteration: 1, round: 2 }, ['review'],
        new Map([['review', { pass: false, reason: 'Refused.' }]]));
      const path = join(directory, 'gate_reevaluation/iteration_1/round_2/engine_verdict_review.json');
      if (condition === 'missing') rmSync(path);
      else writeFileSync(path, JSON.stringify({ gateId: 'review', engine_effective_pass: 'false' }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('review [iteration 1, round 2]');
      expect(report).toContain('archived rejection remains recorded');
      expect(report).not.toContain('Engine effective verdict:');
      expect(report).toContain('gate_reevaluation/iteration_1/round_2/rejected_verdict_review.json');
    });
  });

  it('retains legacy engine rejections for a retired gate with unknown iteration', async () => {
    await terminalFixture(async (project, id, directory) => {
      const state = readRunState(project, id);
      delete state.stages.review;
      state.retiredStageUsage = [{ stageId: 'review', iteration: 1, status: { status: 'complete', retries: 0 } }];
      writeRunState(project, id, state);
      const archive = join(directory, 'gate_reevaluation/round_3'); mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'rejected_verdict_review.json'), JSON.stringify(gateRecord(true)));
      writeFileSync(join(archive, 'engine_verdict_review.json'), JSON.stringify({ gateId: 'review',
        written_verdict_pass: true, engine_effective_pass: false, engine_rejection_reason: 'Legacy metric conflict.' }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('review [legacy iteration unknown, round 3]');
      expect(report).toContain('Engine effective verdict: FAIL — Legacy metric conflict.');
      expect(report).toContain('gate_reevaluation/round_3/engine_verdict_review.json');
    });
  });

  it('shows typed changes, literal checks, caveats and independent verdict without a model or Git', async () => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, 'stages/work/output.md'), JSON.stringify(workRecord()));
      writeFileSync(join(directory, 'stages/review/output.md'), JSON.stringify(gateRecord(true)));
      const run = vi.fn(async () => { throw new Error('No summary model available'); });
      const report = await generateRunSummary(project, id, { run });
      expect(run).not.toHaveBeenCalled();
      expect(report).toContain('work: delivered — Added the greeting.');
      expect(report).toContain('Reported files: `greeting.txt`');
      expect(report).toContain('`node check.mjs` — exit 7; evidence: probe/check.stdout');
      expect(report).toContain('The optional locale check remains open.');
      expect(report).toContain('Independent verdict: PASS — Greeting verified.');
      expect(report).toContain('greeting: pass — greeting.txt:1');
      expect(report).toContain('Git measurement unavailable');
      expect(readRunState(project, id).auxiliaryAttempts?._summary).toBeUndefined();
      expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toBe(report);
    });
  });

  it('preserves failed checks and rejected findings across successful repair executions', async () => {
    await terminalFixture(async (project, id, directory) => {
      const state = readRunState(project, id);
      for (const stage of ['work', 'review']) state.stages[stage].attempts = [
        { index: 1, startedAt: state.startedAt, status: 'complete', exitCode: 0 },
        { index: 2, startedAt: state.startedAt, status: 'complete', exitCode: 0 },
      ];
      writeRunState(project, id, state);
      writeFileSync(join(directory, 'stages/work/output_attempt_1.md'), JSON.stringify(workRecord('Greeting attempt failed.')));
      const repaired = workRecord('Greeting repaired.'); repaired.checks[0].exit_code = 0;
      writeFileSync(join(directory, 'stages/work/output_attempt_2.md'), JSON.stringify(repaired));
      writeFileSync(join(directory, 'stages/review/output_attempt_1.md'), JSON.stringify(gateRecord(false)));
      writeFileSync(join(directory, 'stages/review/output_attempt_2.md'), JSON.stringify(gateRecord(true)));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('Greeting attempt failed.');
      expect(report).toContain('exit 7');
      expect(report).toContain('exit 0');
      expect(report).toContain('Independent verdict: FAIL');
      expect(report).toContain('Finding missing: Greeting missing.');
      expect(report).toContain('Repairability: repairable');
      expect(report).toContain('Independent verdict: PASS');
      expect(report).toContain('review, execution 1');
      expect(report).toContain('review, execution 2');
    });
  });

  it('uses configured receipts for direct exits, totals and unresolved comparisons', async () => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, 'validation_delta_review.json'), JSON.stringify({
        stageId: 'review', checkedAt: '2026-10-09T00:00:00Z', pass: false,
        immutablePath: 'validation_delta_review_attempt_1_exact.json',
        current: [
          { role: 'test', display: 'npm run test', state: 'failed', exitCode: 1, durationMs: 43,
            output: ' Test Files  1 failed | 2 passed (3)\n Tests  1 failed | 9 passed (10)', failureIdentifiers: ['greeting > locale'] },
          { role: 'lint', display: 'npm run lint', state: 'launch_error', durationMs: 2,
            output: '', failureIdentifiers: [], reason: 'spawn failed' },
        ], delta: [{ role: 'test', state: 'regression', reason: 'new failing locale' },
          { role: 'lint', state: 'unresolved', reason: 'no comparable execution' }],
      }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('`npm run test` — failed; direct exit 1; 43ms');
      expect(report).toContain('Tests  1 failed | 9 passed (10)');
      expect(report).toContain('Failure: greeting > locale');
      expect(report).toContain('`npm run lint` — launch_error; direct exit unknown');
      expect(report).toContain('test baseline comparison: regression');
      expect(report).toContain('lint baseline comparison: unresolved');
      expect(report).toContain('validation_delta_review_attempt_1_exact.json');
    });
  });

  it('retains earlier engine validation failures while deduplicating bound receipt aliases', async () => {
    await terminalFixture(async (project, id, directory) => {
      const receipt = (checkedAt: string, pass: boolean) => ({ stageId: 'review', checkedAt, pass,
        current: [{ role: 'test', display: 'npm run test', state: pass ? 'passed' : 'failed',
          exitCode: pass ? 0 : 1, durationMs: 12, output: '# tests 2\n# fail ' + (pass ? '0' : '1'), failureIdentifiers: [] }],
        delta: [{ role: 'test', state: pass ? 'pass' : 'regression', reason: pass ? 'Green' : 'Locale failed' }] });
      writeFileSync(join(directory, 'validation_delta_review_attempt_1_failed.json'), JSON.stringify(receipt('earlier', false)));
      const accepted = { ...receipt('later', true), immutablePath: 'validation_delta_review_attempt_2_passed.json' };
      writeFileSync(join(directory, 'validation_delta_review_attempt_2_passed.json'), JSON.stringify(accepted));
      writeFileSync(join(directory, 'validation_delta_review.json'), JSON.stringify(accepted));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('direct exit 1');
      expect(report).toContain('Locale failed');
      expect(report?.match(/direct exit 0/g)).toHaveLength(1);
      expect(report).toContain('validation_delta_review_attempt_1_failed.json');
      expect(report).toContain('validation_delta_review_attempt_2_passed.json');
    });
  });

  it.each(['legacy prose: 9999 passed; npm run test exit 0', '{"status":"delivered"}', 'null'])('links unsupported output without claiming verification: %s', async output => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, 'stages/work/output.md'), output);
      const report = await generateRunSummary(project, id);
      expect(report).toContain('Typed result unavailable or invalid');
      expect(report).toContain('No engine validation receipts recorded');
      expect(report).not.toContain('9999 passed');
      expect(report).not.toContain('npm run test exit 0');
    });
  });

  it('retains a failed lifecycle and blocked result without inferring success from exit zero', async () => {
    await terminalFixture(async (project, id, directory) => {
      const state = readRunState(project, id); state.status = 'failed'; state.failureReason = 'No usable locale source';
      state.stages.work = { status: 'failed', exitCode: 1, retries: 0, error: 'Blocked: missing source' };
      state.stages.review.status = 'pending'; writeRunState(project, id, state);
      writeFileSync(join(directory, 'stages/work/output.md'), JSON.stringify({ ...workRecord(), status: 'blocked' }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('Status: **failed**');
      expect(report).toContain('No usable locale source');
      expect(report).toContain('Failure: Blocked: missing source');
      expect(report).toContain('work: blocked');
      expect(report).toContain('review: pending');
    });
  });

  it('shows deterministic hard checks and their measured command exits alongside advisories', async () => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, '.reality-gate.json'), JSON.stringify({ results: [
        { name: 'greeting content', type: 'exec-script-exit-zero', pass: false, details: 'greeting missing',
          evidence: { command: 'node verify.mjs', exit: { code: 9 } } },
        { name: 'artifact exists', type: 'file-exists-nonempty', pass: true, details: 'greeting.mjs exists' },
        { name: 'optional wording', type: 'exec-script-exit-zero', pass: false, advisory: true, details: 'environment missing' },
      ] }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('greeting content (exec-script-exit-zero): FAIL — greeting missing');
      expect(report).toContain('command: `node verify.mjs`; direct exit 9');
      expect(report).toContain('artifact exists (file-exists-nonempty): PASS');
      expect(report).toContain('## Reality-Gate advisories');
      expect(report).toContain('optional wording');
      expect(report).toContain('Receipt: `.reality-gate.json`');
    });
  });

  it('keeps partial report data when a collector entry is malformed', async () => {
    await terminalFixture(async (project, id, directory) => {
      writeFileSync(join(directory, 'stages/work/output.md'), JSON.stringify(workRecord()));
      writeFileSync(join(directory, 'validation_delta_review.json'), JSON.stringify({ stageId: 'review',
        current: [null], delta: [], pass: false }));
      const report = await generateRunSummary(project, id);
      expect(report).toContain('Added the greeting.');
      expect(report).toContain('Command receipt unavailable or invalid');
    });
  });
});
