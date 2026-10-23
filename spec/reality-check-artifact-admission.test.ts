import { concludeRun } from '../src/scheduler/sched_policy/run-completion.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChecksFromMarkdown, readRealityGateReport, runAllChecks } from '../src/reality-gate/index.js';
import { admitPlannerDispatches } from '../src/scheduler/sched_loop/planner-dispatch.js';
import { parseDispatchedStageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';

let root: string;
let project: string;
let priorHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reality-hard-check-'));
  project = join(root, 'project');
  mkdirSync(project);
  priorHome = fcGlobalDir();
  setFcGlobalDir(join(root, 'fc'));
});
afterEach(() => { setFcGlobalDir(priorHome); rmSync(root, { recursive: true, force: true }); });

describe('authored reality checks remain hard', () => {
  it.each([false, true])('enforces an output declared with a path object (present=%s)', async (present) => {
    const plan = parseDispatchedStageConfig({ id: 'plan', role: 'planner', dynamic_dispatch: true });
    const workflow = stringify({ name: 'fixture', stages: [plan] });
    const { runId } = createRun(project, 'fixture', workflow, ['plan']);
    const directory = runDir(project, runId);
    // Historical output-object shape. A directory producer makes the member a
    // reachable read without restating the brief's exact required file in its contract.
    const brief = '---\noutputs:\n  - path: deliverables/report.json\n---\n# Deliver the verified result\n\nUse the evidence to finish the report.\n';
    writeFileSync(join(directory, 'task_brief.md'), brief);
    writeFileSync(join(directory, 'dispatch.yaml'), stringify({ stages: [
      { id: 'work', role: 'coder', scope: ['deliverables/'], artifact_contract: {
        version: 1, produces: [{ id: 'bundle', root: 'project', path: 'deliverables', kind: 'directory' }], reads: [],
      } },
      { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'] },
      { id: 'repair', role: 'coder', scope: ['deliverables/'], depends_on: ['review'], retry_to: ['review'] },
    ] }));
    const markdown = '## Reality checks\n' + stringify({ checks: [{
      name: 'required report', type: 'file-exists-nonempty',
      reads: [{ id: 'report', root: 'project', path: 'deliverables/report.json', source: { kind: 'stage', stage: 'work', artifact: 'bundle' } }],
      params: { paths: ['deliverables/report.json'] },
    }] });
    writeFileSync(join(directory, 'reality_checks.md'), markdown);
    const state = readRunState(project, runId);
    state.stages.plan.status = 'complete';
    const roles = new Map(['planner', 'coder', 'qa'].map(name => [name, { name, description: name }]));
    const admitted = admitPlannerDispatches([plan], state, project, runId, directory, roles, new Set(), new Map());
    expect(admitted.kind).toBe('continue');
    expect(JSON.parse(readFileSync(join(directory, 'dispatch_admission.json'), 'utf8'))).toMatchObject({ pass: true, errors: [] });
    const checks = readFileSync(join(directory, 'reality_checks.md'), 'utf8');
    expect(parseChecksFromMarkdown(checks)[0]).not.toMatchObject({ advisory: true });
    expect(checks).toBe(markdown);
    if (present) {
      mkdirSync(join(project, 'deliverables'));
      writeFileSync(join(project, 'deliverables/report.json'), '{"verified":true}\n');
    }
    const terminalState = readRunState(project, runId);
    terminalState.status = 'complete';
    terminalState.stages.work.status = 'complete';
    writeRunState(project, runId, terminalState);
    const gate = await concludeRun(terminalState, { status: 'complete', reasonCode: 'workflow_complete' });
    const gateReport = readRealityGateReport(join(runDir(project, runId), '.reality-gate.json'));
    expect(gate.status, JSON.stringify(gateReport)).toBe(present ? 'complete' : 'reality_gate_failed');
    expect(gateReport).toMatchObject({ pass: present, checksRun: 1, results: [{ name: 'required report', pass: present }] });
    expect(gateReport.results[0].advisory).not.toBe(true);
    if (!present) {
      expect(gateReport.results[0].details).toContain('ARTIFACT_READ_ABSENT');
      expect(readRunState(project, runId).status).toBe('reality_gate_failed');
    }
  });

  it('keeps incompatible versioned JSON shapes as hard execution failures', async () => {
    mkdirSync(join(root, 'task'));
    writeFileSync(join(project, 'result.json'), '{"artifact":"generic.summary.v2","records":[]}\n');
    const report = await runAllChecks([{
      name: 'required JSON fields', type: 'exec-script-exit-zero',
      reads: [{ id: 'result', root: 'project', path: 'result.json', kind: 'file', source: { kind: 'input' } }],
      params: { script: ["node <<'NODE'", "const data = require('./result.json');",
        "function fail(message) { console.error(message); process.exit(1); }",
        "if (!data.expected_one) fail('first shape is absent');",
        "if (!data.expected_two || !Array.isArray(data.expected_two.rows)) fail('second shape is absent');", 'NODE'].join('\n') },
    }], { projectDir: project, taskDir: join(root, 'task') });
    expect(report, JSON.stringify(report)).toMatchObject({ pass: false, results: [{ pass: false, evidence: { exit: { code: 1 }, stderr: expect.stringContaining('first shape is absent') } }] });
    expect(report.results[0].advisory).not.toBe(true);
  });
});
