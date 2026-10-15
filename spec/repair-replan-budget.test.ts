import { execFileSync } from 'node:child_process';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { readRunEvents } from '../src/run-events.js';
import { pendingScopePlanningInputs } from '../src/scheduler/sched_scope/scope-planning.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { runDir } from '../src/store.js';
import { declaredDispatch, fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-repair-budget-'));
  setEngineDefaults({ gate_retry_loops: 3, plan_stage_retries: 0 });
  writeFileSync(join(projectDir, 'input.txt'), 'frozen evidence\n');
  // Existing Git content restores a forbidden input write without eager backup.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    for (const args of [['init', '-q'], ['add', 'input.txt'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', args);
    }
  `], { cwd: projectDir, env: { ...process.env, HOME: projectDir, FC_HOME: projectDir } });
});
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

async function scenario(options: { negotiation?: boolean; includeRepair?: boolean; alwaysReject?: boolean; maxIterations?: number } = {}) {
  const workflow = WorkflowConfigSchema.parse({
    name: 'repair-budget', defaults: { max_iterations: options.maxIterations ?? 5, max_retries: 0 },
    stages: [{ id: 'plan', role: 'planner', scope: [], dynamic_dispatch: true,
      artifact_contract: fixtureArtifactContract('plan') }],
  });
  const agentsDir = join(projectDir, 'config/agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'coder', 'qa']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), `name: ${role}\ndescription: fixture\nmodel: test\nreasoning_effort: low\ntools: []\nprompt: fixture\n`);
  }
  let plans = 0, repairs = 0, reviews = 0;
  let attemptedInput = false;
  let pendingDigest = '';
  let firstAuthorAudit: Record<string, unknown> | undefined;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
    if (opts.stageId === 'plan') {
      plans++;
      const pending = pendingScopePlanningInputs(opts.runDir);
      const includeRepair = options.includeRepair !== false;
      writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringify({
        ...(pending.length ? { scope_negotiation: { defer: pending.map(entry => entry.digest) } } : {}),
        stages: [
          { id: 'author', role: 'coder', depends_on: ['plan'], dependency_reasons: { plan: 'Produce the planned report.' }, scope: ['report.md'] },
          { id: 'review', role: 'qa', depends_on: ['author'], dependency_reasons: { author: 'Review the report.' }, scope: [], is_gate: true },
          ...(includeRepair ? [{ id: 'repair', role: 'coder', depends_on: ['review'],
            dependency_reasons: { review: 'Correct the rejected report.' }, scope: ['report.md'], retry_to: ['review'] }] : []),
        ],
      })));
    } else if (opts.stageId === 'author') {
      writeFileSync(join(projectDir, 'report.md'), 'Report needs cleanup.\n');
      if (options.negotiation && plans === 1 && !attemptedInput) {
        attemptedInput = true;
        writeFileSync(join(projectDir, 'input.txt'), 'unauthorized edit\n');
        // Wait for the real live guard to restore the declared input preimage.
        await waitForPathEvent(projectDir, () => readFileSync(join(projectDir, 'input.txt'), 'utf8') === 'frozen evidence\n' ? true : undefined);
        const stageDir = join(opts.runDir, 'stages/author');
        const { runId } = JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8'));
        writeFileSync(join(stageDir, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'readonly-input', runId,
          stageId: opts.stageId, attemptIndex: opts.attemptIndex, requestedPaths: ['input.txt'],
        }));
        const decision = await waitForPathEvent(stageDir, () => {
          const file = readdirSync(stageDir).find(name => name.startsWith('scope_revision_decision_') && name.endsWith('.json'));
          return file ? JSON.parse(readFileSync(join(stageDir, file), 'utf8')) : undefined;
        });
        expect(decision).toMatchObject({ accepted: false });
        return fixtureResult({ output: 'Report produced; input write restored.', exitCode: 0, duration_ms: 1,
          writes: ['report.md', 'input.txt'], writeAttribution: 'structured' }, opts);
      }
    } else if (opts.stageId === 'review') {
      reviews++;
      if (options.negotiation && plans === 1) {
        const pending = pendingScopePlanningInputs(opts.runDir);
        expect(pending).toHaveLength(1);
        pendingDigest = pending[0].digest;
        expect(pending[0]).toMatchObject({ stageId: 'author', requestedPaths: ['input.txt'] });
        const status = JSON.parse(readFileSync(join(opts.runDir, 'stages/author/status.json'), 'utf8'));
        expect(status.attempts.at(-1)).toMatchObject({ status: 'complete', disposition: 'repaired' });
        firstAuthorAudit = JSON.parse(readFileSync(join(opts.runDir, status.constraintAudit.path), 'utf8'));
      }
      const pass = !options.alwaysReject && repairs > 0;
      writeFileSync(join(opts.runDir, 'fixture_verdict_review.json'), JSON.stringify({ pass, reason: pass ? 'Cleanup verified.' : 'Report needs cleanup.',
        ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Correct report.md and review it again.' } } : {}) }));
    } else if (opts.stageId === 'repair') {
      repairs++;
      writeFileSync(join(projectDir, 'report.md'), 'Report corrected.\n');
    } else throw new Error(`Unexpected stage ${opts.stageId}`);
    return fixtureResult({ output: `${opts.stageId} settled`, exitCode: 0, duration_ms: 1 }, opts);
  } };
  const state = await runWorkflow(workflow, stringify(workflow), projectDir, adapter, new Map(), undefined, agentsDir,
    undefined, '---\ninputs: [input.txt]\n---\n# Clean up the report\n', true, undefined, false);
  const directory = runDir(projectDir, state.runId);
  return { state, plans, repairs, reviews, pendingDigest, firstAuthorAudit, directory,
    events: readRunEvents(projectDir, state.runId), log: existsSync(join(directory, 'iteration_log.md')) ? readFileSync(join(directory, 'iteration_log.md'), 'utf8') : '' };
}

describe('admitted repair routes and budgets', () => {
  it('rejects an author/gate plan lacking a repair route before any work executes', async () => {
    const result = await scenario({ negotiation: true, includeRepair: false });
    expect(result.state.status, result.state.failureReason).toBe('failed');
    expect(result.state.currentIteration).toBe(1);
    expect([result.plans, result.repairs, result.reviews]).toEqual([1, 0, 0]);
    expect(result.state.failureReason).toContain('review: missing repair route');
    expect(result.state.failureReason).toContain('retry_to: [review]');
    expect(result.state.failureReason).toContain('depends_on: [review]');
    expect(result.state.stages).not.toHaveProperty('author');
    expect(readFileSync(join(projectDir, 'input.txt'), 'utf8')).toBe('frozen evidence\n');
  });

  it('repairs a repairable rejection directly when the plan already admits repair', async () => {
    const result = await scenario();
    expect(result.state.status, result.state.failureReason).toBe('complete');
    expect(result.state.currentIteration).toBe(1);
    expect([result.plans, result.repairs, result.reviews]).toEqual([1, 1, 2]);
  });

  it('retains denied input-write evidence while using the admitted repair route', async () => {
    const result = await scenario({ negotiation: true });
    expect(result.state.status, result.state.failureReason).toBe('complete');
    expect([result.plans, result.repairs, result.reviews]).toEqual([1, 1, 2]);
    expect(result.firstAuthorAudit).toMatchObject({ rolledBackWrites: ['input.txt'], rollbackFailures: [], planningDigests: [result.pendingDigest] });
    expect(pendingScopePlanningInputs(result.directory).map(entry => entry.digest)).toEqual([result.pendingDigest]);
    expect(readFileSync(join(projectDir, 'input.txt'), 'utf8')).toBe('frozen evidence\n');
  });

  it.each([1, 2])('stops a repairable rejection after the repair budget is spent (max iterations=%s)', async maxIterations => {
    const result = await scenario({ alwaysReject: true, maxIterations });
    expect(result.state.status, result.state.failureReason).toBe('incomplete');
    expect(result.state.currentIteration).toBe(1);
    expect([result.plans, result.repairs, result.reviews]).toEqual([1, 3, 4]);
    expect(result.log.match(/Gate re-evaluations used: 3\/3/g)).toHaveLength(1);
    expect(result.state.failureReason).toContain(maxIterations === 1 ? 'Workflow iteration budget exhausted' : 'gate re-evaluations used: 3/3');
    expect(result.state.failureReason).toContain(`iteration 1/${maxIterations}`);
    if (maxIterations > 1) expect(result.state.failureReason).not.toContain('iteration budget exhausted');
    expect(result.events.filter(event => event.type === 'run_completed')).toEqual([
      expect.objectContaining({ iteration: 1, detail: 'incomplete' }),
    ]);
  });
});
