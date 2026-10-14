import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const repository = join(import.meta.dirname, '..');
const allowed = 'If the best measured speed-up is below 4x, end with measurements and a report of what bounds it.';
const conflicting = 'PASS only if the benchmark shows at least 4x. If speed-up is below 4x but the implementation reports bounds, reject because the headline outcome was not achieved.';
const brief = (fallback: boolean) => [
  '---', 'outputs: [docs/report.json]', '---', '# Improve the exact probe',
  'The preferred outcome is at least 4x faster with exact parity.', fallback ? allowed : 'At least 4x is required.',
  '## What the report must show',
  '1. Reference and candidate wall-clock times on the same device, load samples during both runs, the ratio, command and direct exit code.',
  '2. Exact parity after the last code change; measured bounds when below the target.', '',
].join('\n');
const measured = { reference: 406.210758, candidate: 440.260150, ratio: 406.210758 / 440.260150,
  device: 'fixture-device', loadSamples: { reference: [50, 51], candidate: [50, 51] },
  command: 'fixture paired benchmark', exitCode: 0 };
let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-brief-outcome-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

async function reproduce(options: { workflow?: 'planner' | 'direct'; status?: 'blocked' | 'delivered';
  missing?: 'measurement' | 'bounds' | 'criterion'; fallback?: boolean; repairMeasurement?: boolean } = {}) {
  const task = brief(options.fallback !== false);
  const criteria = extractBriefCriteria(task).criteria;
  const calls: string[] = [], gateInputs: string[] = [], plannerInputs: string[] = [];
  const plan = { stages: [
    { id: 'implement', role: 'coder', scope: ['docs/'] },
    { id: 'review', role: 'qa', depends_on: ['implement'], is_gate: true, scope: [], prompt_template: conflicting },
    { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['docs/'] },
  ] };
  const adapter: Adapter = { async run(prompt, role, opts) {
    if (opts.stageId === '_summary') return { output: 'Fixture summary', exitCode: 0, duration_ms: 1 };
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') {
      plannerInputs.push(role.prompt);
      writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify(plan));
      return { output: JSON.stringify({ status: 'delivered', summary: 'Authored the execution plan.', checks: [], caveats: [] }),
        exitCode: 0, duration_ms: 1, writes: ['run:dispatch.yaml'], writeAttribution: 'structured' };
    }
    if (opts.stageId !== 'review') {
      mkdirSync(join(project, 'docs'), { recursive: true });
      const missingMeasurement = options.missing === 'measurement' && !(opts.stageId === 'repair' && options.repairMeasurement);
      writeFileSync(join(project, 'docs/report.json'), JSON.stringify({
        measurement: missingMeasurement ? null : measured, parity: true,
        bounds: options.missing === 'bounds' ? null : { serialSeconds: 296.329, maximumSpeedUp: measured.reference / 296.329 },
      }));
      return { output: JSON.stringify({ status: options.status ?? 'blocked',
        summary: 'blocked_below_speed_threshold: measured 0.923x; serial work bounds the exact path.',
        files_modified: ['docs/report.json'], checks: [], caveats: [] }),
      exitCode: 0, duration_ms: 1, writes: ['docs/report.json'], writeAttribution: 'structured' };
    }
    gateInputs.push(prompt);
    // Deterministic substitute for gate judgement: obey the success-only stage
    // instruction unless the engine's result contract gives the full brief
    // authority. Check actual fixture evidence instead of replaying a canned pass.
    const resultContract = prompt.split('# Stage result\n')[1] ?? '';
    const briefGoverns = /Judge.*full brief/i.test(resultContract)
      && /Stage instructions.*cannot.*(?:narrow|replace).*outcomes/i.test(resultContract);
    const report = JSON.parse(readFileSync(join(project, 'docs/report.json'), 'utf8'));
    const measurement = report.measurement;
    const hasMeasurement = measurement?.reference > 0 && measurement?.candidate > 0
      && measurement?.device && measurement?.loadSamples.reference.length && measurement?.loadSamples.candidate.length
      && measurement?.command && measurement?.exitCode === 0
      && Math.abs(measurement.ratio - measurement.reference / measurement.candidate) < 1e-9;
    const acceptsBounds = briefGoverns && task.includes(allowed);
    const speedPass = Boolean(hasMeasurement && (measurement.ratio >= 4 || acceptsBounds));
    const boundsPass = Boolean(report.parity && (measurement?.ratio >= 4 || report.bounds?.maximumSpeedUp < 4));
    const pass = speedPass && boundsPass;
    const reason = !hasMeasurement ? 'Required paired measurement is missing.' : !speedPass
      ? 'Rejected below 4x despite measured bounds.' : !boundsPass ? 'Required measured bounds are missing.'
        : 'Accepted measured bounds; the preferred speed target was not reached.';
    const evidence = { [criteria[0].id]: { status: speedPass ? 'pass' : 'fail', evidence: reason },
      [criteria[1].id]: { status: boundsPass ? 'pass' : 'fail', evidence: 'docs/report.json: parity and serial bound' } };
    if (options.missing === 'criterion') delete evidence[criteria[0].id];
    return { output: JSON.stringify({ pass, reason, criteria: evidence,
      audit_findings: { version: 1, findings: pass ? [] : [{ id: 'required_evidence', paths: ['docs/report.json'], reason,
        criterion_ids: criteria.filter((_, i) => i === 0 ? !speedPass : !boundsPass).map(c => c.id),
        invalidates_plan: false, repair_role: 'repair' }] },
      ...(pass ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: reason } }) }),
    exitCode: 0, duration_ms: 1 };
  } };
  const workflow = join(project, 'workflow.yaml');
  writeFileSync(workflow, 'name: bounded-result\ndefaults: {max_iterations: 1, max_retries: 0}\nstages:\n  - id: plan\n    role: planner\n    dynamic_dispatch: true\n    artifact_contract: {version: 1, produces: [], reads: [], groups: [], replays: []}\n');
  const { config, raw } = loadWorkflow(options.workflow === 'direct' ? join(repository, 'config/workflows/direct.yaml') : workflow);
  const final = await runWorkflow(config, raw, project, adapter, new Map(), undefined, join(repository, 'config/agents'), undefined, task, true);
  return { final, calls, gateInputs, plannerInputs, directory: runDir(project, final.runId), criteria };
}

describe('gate acceptance follows the full brief outcome contract', () => {
  it.each(['blocked', 'delivered'] as const)('accepts an evidenced 0.923x bounds report labeled %s despite a stricter planner instruction', async status => {
    const { final, calls, gateInputs, plannerInputs, directory, criteria } = await reproduce({ status });
    expect(criteria[0].text).not.toContain('4x');
    expect(gateInputs[0]).toContain(conflicting);
    expect(final.status, final.failureReason).toBe('complete');
    expect(plannerInputs[0]).toMatch(/stage instructions.*cannot.*(?:narrow|replace).*outcomes/i);
    expect(calls).toEqual(['plan', 'implement', 'review']);
    expect(JSON.parse(readFileSync(join(directory, 'verdict_review.json'), 'utf8'))).toMatchObject({ pass: true });
  });

  it('uses the same outcome contract in the direct workflow', async () => {
    const { final, calls } = await reproduce({ workflow: 'direct' });
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['implement', 'review']);
  });

  it.each(['measurement', 'bounds', 'criterion'] as const)('rejects missing required %s even when a negative outcome is allowed', async missing => {
    const { final, directory } = await reproduce({ missing });
    expect(final.status).not.toBe('complete');
    if (missing !== 'criterion') expect(JSON.parse(readFileSync(join(directory, 'verdict_review.json'), 'utf8')).pass).toBe(false);
  });

  it('still rejects a below-target result when the brief requires success', async () => {
    const { final, directory } = await reproduce({ fallback: false });
    expect(final.status).not.toBe('complete');
    expect(JSON.parse(readFileSync(join(directory, 'verdict_review.json'), 'utf8')).pass).toBe(false);
  });

  it('accepts the allowed bounds outcome on reevaluation after repairing missing measurements', async () => {
    const { final, calls, gateInputs } = await reproduce({ missing: 'measurement', repairMeasurement: true });
    expect(final.status, final.failureReason).toBe('complete');
    expect(calls).toEqual(['plan', 'implement', 'review', 'repair', 'review']);
    expect(gateInputs).toHaveLength(2);
  });
});
