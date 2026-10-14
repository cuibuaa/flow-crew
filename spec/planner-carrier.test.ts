import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, stringify } from 'yaml';
import { execWithStdin, type Adapter, type AgentConfig } from '../src/adapters/base.js';
import { resetConfigCache } from '../src/config.js';
import { readRunEvents } from '../src/run-events.js';
import { loadWorkflow } from '../src/scheduler.js';
import { runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';

let root: string, project: string, store: string, previousStore: string;
const repository = resolve(import.meta.dirname, '..');
const tsx = createRequire(import.meta.url).resolve('tsx');
const delivered = JSON.stringify({ status: 'delivered', summary: 'Checked the plan.', checks: [], caveats: [] });
const proposal = { stages: [
  { id: 'review', role: 'qa', is_gate: true, scope: [], prompt_template: 'Review existing work.' },
  { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], prompt_template: 'Resolve review findings within the permitted scope.' },
] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'planner-carrier-'));
  project = join(root, 'project'); store = join(root, 'store');
  mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(store); resetConfigCache();
});
afterEach(() => { setFcGlobalDir(previousStore); resetConfigCache(); rmSync(root, { recursive: true, force: true }); });

async function launch(tamper = false) {
  const roles = new Map<string, AgentConfig>();
  for (const name of ['planner', 'qa', 'coder']) {
    const role = { name, description: 'Fixture role', model: 'default', reasoning_effort: 'low', tools: [],
      prompt: name === 'planner' ? 'Produce {run_dir}/dispatch.yaml, the execution plan.' : 'Review existing work.' };
    roles.set(name, role);
  }
  const workflowPath = join(project, 'workflow.yaml');
  writeFileSync(workflowPath, stringify({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true }] }));
  const { config, raw } = loadWorkflow(workflowPath);
  const created = prepareFixtureRun(project, config, raw);
  writeFileSync(join(created.runDirPath, 'task_brief.md'), '# Goal\nReview existing work.\n');
  const calls: string[] = [], checks: number[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') {
      // A real child writes twice around the real read-only CLI. No fixture
      // publication can advance the parent's expected carrier snapshot.
      const child = await execWithStdin(process.execPath, ['-e', `
        const fs = require('node:fs'), cp = require('node:child_process');
        const file = ${JSON.stringify(join(created.runDirPath, 'dispatch.yaml'))};
        const proposal = ${JSON.stringify(proposal)};
        fs.writeFileSync(file, JSON.stringify(proposal));
        function check() {
          const result = cp.spawnSync(process.execPath, ['--import', ${JSON.stringify(tsx)},
            ${JSON.stringify(join(repository, 'src/cli.ts'))}, 'plan-check', '--project', ${JSON.stringify(project)},
            '--run', ${JSON.stringify(created.runDirPath)}, file], { encoding: 'utf8' });
          if (result.status !== 0) throw new Error(result.stdout + result.stderr);
          if (!JSON.parse(result.stdout).pass) throw new Error('Plan check did not pass');
        }
        check();
        proposal.stages[0].prompt_template = 'Independently review existing work.';
        fs.writeFileSync(file, JSON.stringify(proposal));
        check();
        process.stdout.write(${JSON.stringify(delivered)});
      `], '', { cwd: project, timeout_ms: 15000, env: { ...process.env, FC_HOME: store } });
      checks.push(child.exitCode);
      return child;
    }
    if (opts.stageId === 'review') {
      if (tamper) writeFileSync(join(opts.runDir, 'dispatch.yaml'), '{"stages":[]}');
      return { output: JSON.stringify({ pass: true, reason: 'Reviewed existing work.', criteria: {}, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1 };
    }
    return { output: 'Fixture summary.', exitCode: 0, duration_ms: 1 };
  } };
  const state = await runWorkflow(config, raw, project, adapter, roles, undefined, undefined, created.runId);
  return { state, calls, checks, directory: created.runDirPath, plan: readStageStatus(project, created.runId, 'plan') };
}

it('accepts the planner writing and rewriting dispatch.yaml with passing plan-check CLI calls', async () => {
  const { state, calls, checks, directory, plan } = await launch();
  expect(checks).toEqual([0]);
  expect(plan.exitCode, plan.error).toBe(0);
  expect(plan.status).toBe('complete');
  expect(state.status, state.failureReason).toBe('complete');
  expect(calls).toContain('review');
  expect(parse(readFileSync(join(directory, 'dispatch.yaml'), 'utf8')).stages[0].prompt_template).toBe('Independently review existing work.');
});

it('still voids a non-plan stage changing the admitted dispatch carrier', async () => {
  const { state, plan } = await launch(true);
  expect(plan.exitCode, plan.error).toBe(0);
  const review = readStageStatus(project, state.runId, 'review');
  expect(review.exitCode).toBe(125);
  expect(review.error).toContain('ENGINE_STATE_TAMPERED');
  expect(state.status).toBe('failed');
  expect(readRunEvents(project, state.runId).filter(event => event.type === 'attempt_failed' && event.stageId === 'review')).toHaveLength(1);
});
