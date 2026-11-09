import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { runProjectCommand } from '../src/project-validation.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { runDir } from '../src/store.js';
import { renderRunSummary } from '../src/run-summary.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('preserves the stage-measured environment when the engine replays a selected command through a data symlink', async () => {
  const root = mkdtempSync(join(tmpdir(), 'validation-data-')); roots.push(root);
  const project = join(root, 'project'), outside = join(root, 'outside'), isolated = join(root, 'isolated');
  for (const path of [project, outside, isolated]) mkdirSync(path);
  writeFileSync(join(outside, 'ledger'), 'original');
  symlinkSync(outside, join(project, 'data'), 'dir');
  const program = "require('fs').appendFileSync(require('path').join(process.env.PROJECT_STATE || 'data','ledger'),'measured')";
  let reviewInput = '';
  const adapter: Adapter = { async run(prompt, _role, opts) {
    const result = (record: unknown, writes: string[] = []) => ({ output: JSON.stringify(record), exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' as const });
    if (opts.stageId === 'review') {
      reviewInput = prompt;
      const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
      return result({ pass: true, reason: 'Independent fixture inspected the product and command facts',
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Read output and engine receipts' }])),
        audit_findings: { version: 1, findings: [] } });
    }
    const measured = await runProjectCommand({ role: 'test', command: process.execPath, args: ['-e', program],
      display: 'stage measured command', cwd: project, env: { PROJECT_STATE: isolated }, timeoutMs: 5000 });
    expect(measured.exitCode).toBe(0);
    mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/value.txt'), 'value');
    // The same deterministic adapter obeys the supplied contract on both trees.
    // The old schema could return argv only; its bare replay changes outside data.
    // With the environment contract it can retain the exact measured isolation.
    const allowsEnvironment = Boolean(opts.outputSchema?.properties?.validation?.properties?.commands?.properties?.test?.properties?.env);
    return result({ status: 'delivered', summary: 'Value complete', caveats: [], remaining_work: [], validation: {
      commands: { test: { command: process.execPath, args: ['-e', program], ...(allowsEnvironment ? { env: { PROJECT_STATE: isolated } } : {}) } },
      reason: 'Select the measured test with the exact environment supported by the command contract',
    } }, ['docs/value.txt']);
  } };
  const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
  const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, resolve('config/agents'), undefined,
    '---\noutputs: [docs/value.txt]\n---\n# Deliver value\n\n## Acceptance criteria\n1. Independently inspect the value and validation facts.\n', true);
  expect(readFileSync(join(outside, 'ledger'), 'utf8')).toBe('original');
  expect(readFileSync(join(isolated, 'ledger'), 'utf8')).toBe('measuredmeasured');
  expect(final.status).toBe('complete');
  const directory = runDir(project, final.runId);
  const fact = readEvidence(directory).find(entry => entry.kind === 'validation');
  expect(fact?.kind === 'validation' && fact.executions[0].commands[0]).toMatchObject({ exitCode: 0, env: { PROJECT_STATE: isolated } });
  expect(reviewInput).toContain(JSON.stringify({ PROJECT_STATE: isolated }));
  expect(renderRunSummary(project, directory, final)).toContain(JSON.stringify({ PROJECT_STATE: isolated }));
});
