import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { runDir } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';

const root = join(import.meta.dirname, '..');
const agentsDir = join(root, 'config', 'agents');
let projectDir: string;

beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-direct-')); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

function brief(frontmatter: string): string {
  return ['---', frontmatter, '---', '# Add a greeting', '', '## What the report must show',
    '1. The greeting added.', '2. The test command and its direct exit code.', ''].join('\n');
}

/** Records every adapter call; the gate rejects its first review when asked to. */
function adapter(calls: string[], rejectFirstReview: boolean): Adapter {
  let reviews = 0;
  return {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        const pass = !(rejectFirstReview && ++reviews === 1);
        const { criteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as { criteria: Array<{ id: string }> };
        writeFileSync(join(opts.runDir, 'verdict_review.json'), JSON.stringify({
          pass, reason: pass ? 'accepted' : 'the greeting is missing',
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'docs/report.md' }])),
        }));
        return fixtureResult({ output: 'reviewed', exitCode: 0, duration_ms: 1 }, opts);
      }
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'report.md'), `# Report written by ${opts.stageId}\n`);
      return fixtureResult({ output: `${opts.stageId} done`, exitCode: 0, duration_ms: 1, writes: ['docs/report.md'], writeAttribution: 'structured' }, opts);
    },
  };
}

async function runDirect(task: string, calls: string[], rejectFirstReview = false) {
  const { config, raw } = loadWorkflow(join(root, 'config', 'workflows', 'direct.yaml'));
  return runWorkflow(config, raw, projectDir, adapter(calls, rejectFirstReview), new Map(), undefined, agentsDir, undefined, task, true);
}

describe('direct workflow', () => {
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
    writeFileSync(join(projectDir, 'notes.md'), 'evidence\n');
    const refusals: Array<[string, string]> = [
      ['inputs:\n  - notes.md', 'overlaps declared read-only input notes.md'],
      ['terminal_states:\n  complete:\n    paths: [docs/report.md]', 'terminal_states path docs/report.md: expected exactly one scoped owner'],
    ];
    for (const [frontmatter, reason] of refusals) {
      const calls: string[] = [];
      const final = await runDirect(brief(frontmatter), calls);
      expect(final.status).toBe('failed');
      expect(final.failureReason).toContain(reason);
      expect(calls).toEqual([]);
    }
  });
});
