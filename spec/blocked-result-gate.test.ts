import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { runDir } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';

const root = join(import.meta.dirname, '..');
const BRIEF = ['# Upgrade the parser', '', '## What the report must show',
  '1. Every configuration accepted today loads as before.', '2. The test command and its direct exit code.', ''].join('\n');
const BLOCKED = JSON.stringify({
  status: 'blocked', summary: 'The new parser rejects merge sequences longer than 100 entries.', files_modified: ['docs/report.md'],
  checks: [{ command: 'node docs/experiment.mjs blockers', exit_code: 0, evidence: 'docs/v5-blockers.json' }],
  caveats: ['The cap is not configurable: https://example.invalid/upstream-commit'],
});
const IRREPARABLE = { pass: false, reason: 'Blocker confirmed by reproduction', repairability: { version: 1, disposition: 'irreparable', evidence: 'docs/v5-blockers.json reproduced' } };
const REPAIRABLE = { pass: false, reason: 'Blocker not real: the merge can be expanded before loading', repairability: { version: 1, disposition: 'repairable', evidence: 'expanded merge loads' } };
let projectDir: string;

beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-blocked-')); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

/** Each author answers its scripted records in turn, repeating the last (implement is blocked, others deliver, unless
 * scripted); the gate answers each review with the next verdict. */
async function run(verdicts: Array<Record<string, unknown>>, answers: Record<string, string[]> = { implement: [BLOCKED] },
  workflow = join(root, 'config', 'workflows', 'direct.yaml'), brief = BRIEF) {
  const calls: string[] = [];
  const prompts: Record<string, string[]> = {};
  const adapter: Adapter = {
    async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      calls.push(opts.stageId);
      const seen = (prompts[opts.stageId] ??= []).push(prompt);
      if (opts.stageId === 'review') {
        const verdict = verdicts[seen - 1];
        const { criteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> };
        writeFileSync(join(opts.runDir, 'fixture_verdict_review.json'), JSON.stringify({ ...verdict,
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: verdict.pass ? 'pass' : 'fail', evidence: 'docs/report.md' }])) }));
        return fixtureResult({ output: 'reviewed', exitCode: 0, duration_ms: 1 }, opts);
      }
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'report.md'), `# Report written by ${opts.stageId}\n`);
      const scripted = answers[opts.stageId] ?? [];
      const answer = scripted.length > 1 ? scripted.shift() : scripted[0];
      return fixtureResult({ output: answer ?? `${opts.stageId} did the work`, exitCode: 0, duration_ms: 1, writes: ['docs/report.md'], writeAttribution: 'structured' }, opts);
    },
  };
  const { config, raw } = loadWorkflow(workflow);
  const final = await runWorkflow(config, raw, projectDir, adapter, new Map(), undefined, join(root, 'config', 'agents'), undefined, brief, true);
  const ledger = readFileSync(join(runDir(projectDir, final.runId), 'evidence-ledger.jsonl'), 'utf8');
  return { final, calls, reviews: prompts.review ?? [], repairs: prompts.repair ?? [], ledger };
}

describe('a blocked author result goes to its gate', () => {
  it('settles a blocked author once, names structured blocker facts and retains its declaration for independent reading', async () => {
    const { final, calls, reviews, ledger } = await run([IRREPARABLE]);
    expect(calls).toEqual(['implement', 'review']);
    expect(final.stages.implement).toMatchObject({ status: 'complete', attempts: [{ status: 'complete' }] });
    for (const retained of ['rejects merge sequences longer than 100 entries', 'https://example.invalid/upstream-commit',
      'node docs/experiment.mjs blockers', 'docs/v5-blockers.json']) {
      expect(ledger).toContain(retained);
      expect(reviews[0]).not.toContain(retained);
    }
    expect(reviews[0]).toContain('"kind":"declaration","stageId":"implement","attemptIndex":1,"status":"blocked"');
    expect(reviews[0]).toContain('evidence-ledger.jsonl');
    expect(reviews[0]).toContain('"irreparable"');
    expect(final.status).toBe('escalated');
    expect(final.failureReason).toContain('Blocker confirmed by reproduction');
  });

  it('sends a blocker the gate rejects to the bounded repair, whose work the gate reviews again', async () => {
    const { final, calls, reviews, repairs } = await run([REPAIRABLE, { pass: true, reason: 'repaired' }]);
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(reviews[0]).toContain('\"kind\":\"declaration\"');
    expect(repairs[0]).toContain('rejected_verdict_review.json');
    expect(reviews[1]).toContain('\"stageId\":\"repair\"');
    expect(reviews[1]).not.toContain('The new parser rejects merge sequences');
    expect(final.status).toBe('complete');
  });

  it('lets a confirmed engine blocker proceed to repair when scope readmission can resolve it', async () => {
    const blocked = JSON.stringify({ status: 'blocked', summary: 'Engine scope denial prevents comparison cleanup',
      files_modified: ['docs/report.md'], checks: [],
      caveats: ['A failed rollback left temporary dependency files outside the admitted scope'] });
    const { final, calls, reviews } = await run([{ pass: false, reason: 'Confirmed blocker has a recovery route',
      repairability: { version: 1, disposition: 'repairable', evidence: 'exact recorded paths can request scope readmission' } },
    { pass: true, reason: 'cleanup and delivery verified' }], { implement: [blocked] });
    expect(reviews[0]).toContain('A reported blocker needs independent reproduction; it does not establish irreparability');
    expect(reviews[0]).toContain('Use repairability \"irreparable\" only with reproduced evidence that no available repair can meet the brief');
    expect(reviews[0]).not.toContain('Real, and the brief does not accept a blocked report');
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(final.status).toBe('complete');
  });

  it('returns a repair that reports the blocker again to the same gate, which may then confirm it', async () => {
    const { final, calls, reviews } = await run([REPAIRABLE, IRREPARABLE], { implement: [BLOCKED], repair: [BLOCKED] });
    expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    expect(reviews[1]).not.toContain('The new parser rejects merge sequences longer than 100 entries.');
    expect(reviews[1]).toContain('\"kind\":\"declaration\",\"stageId\":\"repair\"');
    expect(reviews[1]).toContain('\"stageId\":\"repair\"');
    expect(final.status).toBe('escalated');
  });

  it('completes when the gate accepts the blocked report as the outcome the brief allows', async () => {
    const { final, calls } = await run([{ pass: true, reason: 'The brief accepts a documented blocker' }]);
    expect(calls).toEqual(['implement', 'review']);
    expect(final.status).toBe('complete');
  });

  it('tells the gate about a blocked author it reviews through another author', async () => {
    const workflow = join(projectDir, 'chain.yaml');
    const direct = readFileSync(join(root, 'config', 'workflows', 'direct.yaml'), 'utf8');
    writeFileSync(workflow, direct.replace('  - id: implement\n', '  - id: inventory\n    role: coder\n    scope: ["docs/"]\n  - id: implement\n    depends_on: [inventory]\n'));
    const { final, calls, reviews } = await run([IRREPARABLE], { inventory: [BLOCKED] }, workflow);
    expect(calls).toEqual(['inventory', 'implement', 'review']);
    expect(reviews[0]).toContain('evidence-ledger.jsonl');
    expect(reviews[0]).toContain('\"stageId\":\"inventory\"');
    expect(final.status).toBe('escalated');
  });

  it('still fails a blocked result that no gate reviews', async () => {
    // Without brief criteria, admission lets a static workflow run an author that no gate follows.
    const workflow = join(projectDir, 'solo.yaml');
    writeFileSync(workflow, ['name: solo', 'stages:', '  - id: implement', '    role: coder', '    scope: ["docs/"]',
      '    artifact_contract: {version: 1, produces: [], reads: [], groups: []}', ''].join('\n'));
    const { final, calls } = await run([], undefined, workflow, '# Upgrade the parser\n');
    expect(calls).toEqual(['implement', 'implement']);
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('Blocked: The new parser rejects merge sequences longer than 100 entries.');
  });
});
