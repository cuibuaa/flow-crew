import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, setFcGlobalDir, runDir } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { renderRunSummary } from '../src/run-summary.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import * as contracts from '../src/scheduler/sched_policy/prompt-contracts.js';
import { inspectBrief, createBriefAdmission } from '../src/brief-preflight.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

let root: string, project: string, previous: string;
const brief = '# Update the greeting\n\nChoose a sensible greeting convention.\n\n## Acceptance criteria\n1. Produce the greeting and report any unavailable resource.\n';
const gap = 'Offline: the desired download from example.invalid is unavailable; completed the local greeting.';
const assumptions = ['Use the existing greeting convention for new content.'];
const choose = { successor: 'implement', reason: 'One coherent greeting change.', metric_search: false, assumptions, missing_author_facts: [] };
const delivered = { status: 'delivered', summary: gap, checks: [], caveats: [gap], remaining_work: [] };
const roles = join(import.meta.dirname, '../config/agents');
function verdict(opts: RunOpts): string {
  const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return JSON.stringify({ pass: true, reason: 'Independently checked the local greeting and resource gap.',
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: 'pass', evidence: 'Read the greeting and the explicit offline gap.' }])),
    audit_findings: { version: 1, findings: [] }, remaining_work: [] });
}
function adapter(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const implementation: Adapter = { async run(prompt, role, opts) {
    calls.push(opts.stageId); prompts.push(role.prompt + '\n' + prompt);
    let output: unknown = delivered;
    if (opts.stageId === 'choose') output = overrides.choose ?? choose;
    if (opts.stageId === 'implement') {
      writeFileSync(join(project, 'greeting.txt'), 'Hello.\n');
      const slot = join(opts.runDir, 'stages/implement/approval_request.json');
      mkdirSync(join(opts.runDir, 'stages/implement'), { recursive: true });
      // A stale adapter can still write its former transport slot. It has no execution meaning.
      writeFileSync(slot, JSON.stringify({ id: 'download', action: 'download', target: 'https://example.invalid/data', risk: 'external', category: 'downloads', host: 'example.invalid', title: gap }));
    }
    if (opts.stageId === 'assess') output = { successor: 'review', reason: 'Bounded greeting risk.', risk_areas: [] };
    if (opts.stageId === 'review') return { output: verdict(opts), exitCode: 0, duration_ms: 1 };
    return { output: typeof output === 'string' ? output : JSON.stringify(output), exitCode: 0, duration_ms: 1 };
  } };
  return { implementation, calls, prompts };
}
async function execute(implementation: Adapter, text = brief) {
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
  config.defaults.max_iterations = 1;
  config.defaults.max_retries = 1;
  return runWorkflow(config, raw, project, implementation, new Map(), undefined, roles, undefined, text, true);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'no-approvals-')); project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  setEngineDefaults({ gate_retry_loops: 1, plan_stage_retries: 1, max_iterations: 1 });
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

describe('nothing waits for a person after launch', () => {
  it('ignores an outward-effect request slot, completes both decision stages and gates, and reports the gap', async () => {
    const fixture = adapter();
    const state = await execute(fixture.implementation);
    expect(state.status, state.failureReason).toBe('complete');
    expect(fixture.calls).toEqual(['choose', 'implement', 'assess', 'review']);
    const directory = runDir(project, state.runId);
    expect(readRunEvents(project, state.runId).some(event => ['approval_parked', 'approval_attempt_suspended', 'approval_resolved', 'decision_questions'].includes(event.type))).toBe(false);
    expect(state.parked).toBeUndefined();
    expect(existsSync(join(directory, 'approvals.jsonl'))).toBe(false);
    expect(readFileSync(join(directory, 'stages/implement/output.md'), 'utf8')).toContain(gap);
    expect(renderRunSummary(project, directory, state)).toContain(gap);
    expect(fixture.prompts.join('\n')).not.toContain('write exactly one JSON request');
    expect(fixture.prompts.join('\n')).not.toContain('Current brief authorizations');
  });

  it('removes the execution approval prompt contract and authorization parser', () => {
    expect(contracts).not.toHaveProperty('appendApprovalRequestContract');
    const parsed = parseBriefFrontmatter('---\nauthorizations: {spend: {usd: 20}}\n---\nKeep the spending constraint in the task text.');
    expect(parsed).not.toHaveProperty('authorizations');
    expect(parsed).not.toHaveProperty('authorizationsError');
    expect(parsed.stripped).toContain('Keep the spending constraint');
  });

  it('chooses on an ambiguous brief and retains assumptions in the ledger, run record and report without a pause', async () => {
    const fixture = adapter(); const state = await execute(fixture.implementation);
    const directory = runDir(project, state.runId);
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.decisionGraph?.records[0]).toMatchObject({ stageId: 'choose', outcome: 'chosen', assumptions });
    expect(readRunState(project, state.runId).decisionGraph?.records[0].assumptions).toEqual(assumptions);
    expect(readEvidence(directory).find(fact => fact.kind === 'attempt' && fact.stageId === 'choose')).toMatchObject({ finalRecord: { assumptions } });
    expect(renderRunSummary(project, directory, state)).toContain(assumptions[0]);
    expect(readRunEvents(project, state.runId).some(e => e.type === 'decision_questions' || e.type === 'approval_parked')).toBe(false);
  });

  it('fails invalid chooser attempts and uses the existing retry without inventing a question or choice', async () => {
    const bad = new ScriptedAdapter({ choose: { output: '{}' } });
    const state = await execute(bad);
    expect(state.status).toBe('failed');
    expect(state.stages.choose.attempts?.length).toBeGreaterThan(1);
    expect(state.stages.choose.attempts?.every(attempt => attempt.status === 'failed' && attempt.exitCode === 1)).toBe(true);
    expect(state.stages).not.toHaveProperty('implement');
    expect(state.parked).toBeUndefined();
  });

  it('recovers from a malformed chooser reply on the next ordinary attempt', async () => {
    const fixture = adapter(); let turns = 0;
    const state = await execute({ async run(prompt, role, opts) {
      if (opts.stageId === 'choose' && ++turns === 1) return { output: '{', exitCode: 0, duration_ms: 1 };
      return fixture.implementation.run(prompt, role, opts);
    } });
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.choose.attempts?.map(attempt => attempt.status)).toEqual(['failed', 'complete']);
  });

  it.each([{ max_rounds: 2 }, { max_wall_hours: 1000 }])('keeps prelaunch research budget admission before the chooser: %j', async stop => {
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    config.defaults.max_iterations = 1;
    const text = `---\n${JSON.stringify({ research: { baseline: 0.5, policy: 'greedy_stack', stop } })}\n---\n${brief}`;
    const report = inspectBrief(text);
    const admission = createBriefAdmission(report, { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
    const fixture = adapter();
    const state = await runWorkflow(config, raw, project, fixture.implementation, new Map(), undefined, roles, undefined, text, true, undefined, true, admission);
    expect(state.status).toBe('failed');
    expect(state.failureReason).toContain('Research budget admission refused');
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    { ...choose, successor: 'plan', metric_search: true },
    { ...choose, missing_author_facts: ['The author must supply the baseline dataset.'] },
  ])('ends with a named missing author fact instead of guessing or waiting: %j', async output => {
    const fixture = adapter({ choose: output }); const state = await execute(fixture.implementation);
    expect(state.status).toBe('failed');
    expect(state.failureReason).toContain('Author must add missing facts before launch');
    expect(state.research).toBeUndefined();
    expect(state.parked).toBeUndefined();
    expect(fixture.calls).toEqual(['choose']);
    expect(state.decisionGraph?.records[0].outcome).toBe('refused');
    expect(renderRunSummary(project, runDir(project, state.runId), state)).toContain('Author must add missing facts');
  });
});
