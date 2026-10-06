import { declaredDispatch } from './test-support/declared-dispatch.js';
import { emptyArtifactContract, gateArtifactContract, planArtifactContract } from './spec_presentation/declared-fixtures.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { appendGuidanceEnvelope, readGuidanceForStage } from '../src/guidance.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import { inspectDispatchAdmission, parseDispatchedStageConfig, runWorkflow, validateVerdictAgainstMetricFile, type WorkflowConfig } from '../src/scheduler.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { runDir } from '../src/store.js';
import { plannerCriterionAssignmentContext } from '../src/worker.js';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-boundaries-5-'));
  roots.push(root);
  return root;
}
function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('planning and reality declaration admission', () => {
  it('admits the planner stage first proposal on a 12-criterion brief without retry or guidance', async () => {
    const project = temporaryRoot();
    const agentsDir = join(project, 'config', 'agents');
    for (const role of ['planner', 'coder', 'qa']) {
      write(join(agentsDir, `${role}.yaml`), [
        `name: ${role}`, 'description: admission fixture', 'model: default',
        'reasoning_effort: default', 'tools: []', 'prompt: fixture role',
      ].join('\n'));
    }
    const brief = ['---', 'outputs:', '  - docs/work.md', '---',
      '# Many-criterion admission', '## What the report must show',
      ...Array.from({ length: 12 }, (_, index) => `${index + 1}. Requirement ${index + 1} is implemented and checked.`),
    ].join('\n');
    const workflow: WorkflowConfig = {description: '', 
      name: 'first-proposal-admission', defaults: { max_iterations: 1 },
      stages: [{ id: 'plan', role: 'planner', depends_on: [], scope: [], prompt_template: 'Plan the work.',
        dynamic_dispatch: true, is_gate: false, skills: [], criterion_refs: [], artifact_contract: planArtifactContract() }],
    };
    let planAttempts = 0;
    const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });
    const adapter = {
      async run(_prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          planAttempts += 1;
          const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as ReturnType<typeof extractBriefCriteria>;
          expect(criteria.criteria).toHaveLength(12);
          const refs = criteria.criteria.map((criterion) => criterion.id);
          for (const ref of refs) expect(role.prompt).toContain(ref);
          expect(role.prompt).toContain('Do not set per-stage timeout fields.');
          write(join(opts.runDir, 'dispatch.yaml'), declaredDispatch(stringifyYaml({ stages: [
            {dynamic_dispatch: false,  id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['docs/work.md'],
              prompt_template: 'Write docs/work.md.', criterion_refs: refs,
              artifact_contract:{version:1,produces:[{id:'work',root:'project',path:'docs/work.md'}],reads:[],replays:[]} },
            {dynamic_dispatch: false,  id: 'gate', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Check the work.' },
              scope: [], is_gate: true, prompt_template: 'Check all criteria.', criterion_refs: refs },
          ] }), { gate: gateArtifactContract('gate') }));
          write(join(opts.runDir, 'reality_checks.md'), [
            '## Reality checks', '```yaml', 'checks:', '  - name: work artifact',
            '    reads: [{id: work, root: project, path: docs/work.md, source: {kind: stage, stage: work, artifact: work}}]',
            '    type: file-exists-nonempty', '    params: { paths: [docs/work.md] }', '```',
            'The check observes the produced work artifact.',
          ].join('\n'));
          return ok('first proposal complete');
        }
        if (opts.stageId === 'work') {
          write(join(project, 'docs/work.md'), '# Work\n');
          return ok('work complete');
        }
        if (opts.stageId === 'gate') {
          const criteria = extractBriefCriteria(brief).criteria;
          write(join(opts.runDir, 'verdict_gate.json'), JSON.stringify({ pass: true,
            criteria: Object.fromEntries(criteria.map((criterion) => [criterion.id,
              { status: 'pass', evidence: 'the work artifact exists' }])),
          }));
          return ok('gate complete');
        }
        return ok('summary complete');
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;
    const result = await runWorkflow(workflow, stringifyYaml(workflow), project, adapter,
      new Map(), undefined, agentsDir, undefined, brief, true);
    const runPath = runDir(project, result.runId);
    const admission = JSON.parse(readFileSync(join(runPath, 'dispatch_admission.json'), 'utf8')) as { pass: boolean; errors: string[] };
    const events = readFileSync(join(runPath, 'events.jsonl'), 'utf8');
    expect({ planAttempts, admitted: admission.pass, errors: admission.errors,
      retries: events.match(/"type":"plan_dispatch_retry"/g)?.length ?? 0,
      operatorGuidance: events.match(/"source":"operator","type":"guidance_written"/g)?.length ?? 0,
    }).toEqual({ planAttempts: 1, admitted: true, errors: [], retries: 0, operatorGuidance: 0 });
    expect(result.status).toBe('complete');
  }, 60_000);

  it('carries a many-criterion first proposal with explicit coverage through admission', () => {
    const prompt = (parseYaml(readFileSync(join(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml'), 'utf8')) as { prompt: string }).prompt;
    expect(prompt).toContain('Before the FIRST dispatch proposal, read {run_dir}/brief_criteria.json');
    expect(prompt).toContain('make a coverage table in tech_solution.md');
    const brief = ['# Task', '## Requirements', ...Array.from({ length: 12 }, (_, index) =>
      `${index + 1}. Requirement ${index + 1} must be implemented and checked.`)].join('\n');
    const criteria = extractBriefCriteria(brief);
    expect(criteria.criteria).toHaveLength(12);
    const refs = criteria.criteria.map((criterion) => criterion.id);
    const context = plannerCriterionAssignmentContext(brief);
    for (const ref of refs) expect(context).toContain(ref);
    expect(context).toContain('Do not set per-stage timeout fields.');
    const work = parseDispatchedStageConfig({dynamic_dispatch: false, 
      id: 'work', role: 'coder', scope: ['src/**'], depends_on: [], dependency_reasons: {},
      prompt_template: 'Implement the brief.', criterion_refs: refs,
      artifact_contract: emptyArtifactContract(),
    });
    const gate = parseDispatchedStageConfig({dynamic_dispatch: false, 
      id: 'gate', role: 'qa', scope: [], depends_on: ['work'],
      dependency_reasons: { work: 'The gate checks the work output.' },
      is_gate: true, prompt_template: 'Check all criteria.', criterion_refs: refs,
      artifact_contract: gateArtifactContract('gate'),
    });
    expect(inspectDispatchAdmission({ dispatched: [work, gate], baseStages: [], dispatchStageId: 'plan', criteria }).pass).toBe(true);
    expect(() => parseDispatchedStageConfig({ ...work, timeout_ms: 1000 })).toThrow();
    expect(inspectDispatchAdmission({
      dispatched: [{ ...work, criterion_refs: [] }, gate], baseStages: [], dispatchStageId: 'plan', criteria,
    }).errors).toEqual(expect.arrayContaining([expect.stringContaining('not assigned to a capable work/finalizer stage')]));
  });

  it('compares first-proposal admission before and after the planner context on one brief', () => {
    const brief = ['# Task', '## Requirements', ...Array.from({ length: 18 }, (_, index) =>
      `${index + 1}. Requirement ${index + 1} must be implemented and checked.`)].join('\n');
    const criteria = extractBriefCriteria(brief);
    expect(criteria.criteria).toHaveLength(18);
    const refs = criteria.criteria.map((criterion) => criterion.id);
    const currentPrompt = plannerCriterionAssignmentContext(brief);
    for (const ref of refs) expect(currentPrompt).toContain(ref);

    // The deterministic planner fixture follows the explicit first-proposal
    // context when present, or fixes the rejected proposal on feedback.
    const proposal = (prompt: string, retry: boolean) => {
      const covered = prompt.includes('# First-proposal criterion assignments') || retry;
      const stages = [
        {dynamic_dispatch: false,  id: 'work', role: 'coder', scope: ['docs/work.md'], depends_on: [],
          dependency_reasons: {}, prompt_template: 'Write docs/work.md.',
          artifact_contract: emptyArtifactContract(),
          criterion_refs: covered ? refs : [] },
        {dynamic_dispatch: false,  id: 'gate', role: 'qa', scope: [], depends_on: ['work'],
          dependency_reasons: { work: 'Check the work.' }, is_gate: true,
          artifact_contract: gateArtifactContract('gate'),
          prompt_template: 'Check all criteria.', criterion_refs: covered ? refs : [] },
      ];
      return covered ? stages : stages.map((stage) => ({ ...stage, timeout_ms: 60_000 }));
    };
    const admit = (prompt: string) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let dispatched;
        try {
          dispatched = proposal(prompt, attempt > 1).map(parseDispatchedStageConfig);
        } catch {
          continue;
        }
        const result = inspectDispatchAdmission({ dispatched, baseStages: [], dispatchStageId: 'plan', criteria });
        if (result.pass) return { attempts: attempt, admitted: true, operatorGuidanceNeeded: false };
      }
      return { attempts: 2, admitted: false, operatorGuidanceNeeded: false };
    };

    const prechangePrompt = 'Read brief_criteria.json before dispatching and assign criterion_refs.';
    expect(proposal(prechangePrompt, false).every((stage) => 'timeout_ms' in stage)).toBe(true);
    expect(() => proposal(prechangePrompt, false).map(parseDispatchedStageConfig)).toThrow();
    const missingCoverage = proposal(prechangePrompt, false).map((entry) => {
      const { timeout_ms: _timeout, ...stage } = { timeout_ms: undefined, ...entry };
      return parseDispatchedStageConfig(stage);
    });
    expect(inspectDispatchAdmission({ dispatched: missingCoverage, baseStages: [],
      dispatchStageId: 'plan', criteria }).errors).toHaveLength(18);
    expect(admit(prechangePrompt)).toEqual({ attempts: 2, admitted: true, operatorGuidanceNeeded: false });
    expect(admit(currentPrompt)).toEqual({ attempts: 1, admitted: true, operatorGuidanceNeeded: false });
  });

  it('parses a closed YAML fence followed by explanation and still rejects broken declarations', () => {
    const fenced = [
      '## Reality checks', '```yaml', 'checks:', '  - name: artifact',
      '    reads: [{id: artifact, root: project, path: artifact.txt, source: {kind: input}}]',
      '    type: file-exists-nonempty', '    params: { paths: [artifact.txt] }', '```',
      'The stage will cite this check in its report.',
    ].join('\n');
    expect(parseChecksFromMarkdown(fenced)).toEqual([
      { name: 'artifact', type: 'file-exists-nonempty', params: { paths: ['artifact.txt'] },
        reads: [{ id: 'artifact', root: 'project', path: 'artifact.txt', kind: 'file', source: { kind: 'input' } }] },
    ]);
    const invalid = ['## Reality checks', '```yaml', 'checks:', '  - name: broken', '     type: file-exists-nonempty'].join('\n');
    expect(parseChecksFromMarkdown(invalid)).toEqual([expect.objectContaining({ kind: 'invalid', diagnostic: expect.stringContaining('YAML parsing failed') })]);
  });
});

describe('attempt-scoped revision notice', () => {
  it('delivers the stop notice only to its owning attempt while ordinary guidance persists', () => {
    const runDir = temporaryRoot();
    appendGuidanceEnvelope({ runDir, target: 'work', source: 'scheduler', attemptIndex: 1,
      body: 'Scope revision one was accepted. This attempt stops at the control boundary.',
      knownStageIds: ['work'] });
    appendGuidanceEnvelope({ runDir, target: 'work', source: 'scheduler', attemptIndex: 2,
      body: 'Scope revision one was accepted for execution 1. Continue the stage work.',
      knownStageIds: ['work'] });
    appendGuidanceEnvelope({ runDir, target: 'work', source: 'operator',
      body: 'Keep the validation command bounded.', knownStageIds: ['work'] });
    expect(readGuidanceForStage(runDir, 'work', 1).map((entry) => entry.source)).toEqual(['scheduler', 'operator']);
    const second = readGuidanceForStage(runDir, 'work', 2);
    expect(second.map((entry) => entry.source)).toEqual(['scheduler', 'operator']);
    expect(second.map((entry) => entry.body).join('\n')).not.toContain('This attempt stops');
    expect(readGuidanceForStage(runDir, 'work').map((entry) => entry.source)).toEqual(['operator']);
  });
});

describe('gate metric authority', () => {
  it('keeps a threshold-free domain observation from overruling a zero-failure report gate', () => {
    const verdict = { pass: true, metric: 'failing_checks', score: 0, threshold: 0 };
    const metric = { pass: false, metric: 'fitted_latency', value: 274.4, threshold: null,
      notes: 'Exploratory latency. The report gate evaluates evidence accuracy.' };
    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
    expect(validateVerdictAgainstMetricFile(verdict, { ...metric, metric: 'failing_checks', threshold: 0 }))
      .toBe('verdict/metric.json mismatch: metric says fail, verdict says pass');
    expect(validateVerdictAgainstMetricFile(verdict, { ...metric, threshold: 200 }))
      .toBe('verdict/metric.json mismatch: metric says fail, verdict says pass');
    expect(validateVerdictAgainstMetricFile(verdict, { ...metric, notes: 'Failed required outcome.' }))
      .toBe('verdict/metric.json mismatch: metric says fail, verdict says pass');
  });
});

describe('bounded Makefile pytest replay', () => {
  const previousPythonUserBase = process.env.PYTHONUSERBASE;
  beforeAll(() => { process.env.PYTHONUSERBASE ??= join(userInfo().homedir, '.local'); });
  afterAll(() => {
    if (previousPythonUserBase === undefined) delete process.env.PYTHONUSERBASE;
    else process.env.PYTHONUSERBASE = previousPythonUserBase;
  });
  function audit(projectDir: string, argv: string[]) {
    const artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [],
      reads: [{ id: 'target', root: 'project', path: 'tests/test_ok.py', source: { kind: 'input' } }],
      replays: [{ id: 'evidence', runner: 'pytest', targets: ['target'], argv,
        expected: { exit_code: 0, failures: [] } }],
    });
    return verifyStageArtifactContract({ stageId: 'work', template: 'Verify the declared test.', projectDir,
      runDir: temporaryRoot(), artifactContract }, { remainingMs: () => 30_000 });
  }

  it('verifies the exact declared target through a statically configured Makefile runner', async () => {
    const project = temporaryRoot();
    write(join(project, 'Makefile'), 'PY ?= python3\n\n.PHONY: test\ntest:\n\tPYTHONPATH=. PYTEST_ADDOPTS=-p\\ no:cacheprovider $(PY) -m pytest tests/ -q\n');
    write(join(project, 'tests/test_ok.py'), 'def test_ok():\n    assert True\n');
    const bare = await audit(project, ['-q']);
    expect(bare.replayExecutions[0], JSON.stringify(bare.violations)).toMatchObject({ runner: 'pytest', status: 'passed', exitCode: 0, collectedTests: 1, executedTests: 1 });
    const module = await audit(project, ['-q', '-p', 'no:cacheprovider']);
    expect(module.replayExecutions[0]).toMatchObject({ runner: 'pytest', status: 'passed', exitCode: 0, executedTests: 1 });
    write(join(project, 'Makefile'), 'test:\n\tPYTHONPATH=.. python3 -m pytest tests/ -q\n\tpython3 -m pytest tests/ -q\n');
    const untrusted = await audit(project, ['-q']);
    expect(untrusted.replayExecutions[0]).toMatchObject({ runner: 'pytest', status: 'not_run' });
    expect(untrusted.violations[0].reason).toContain('DECLARED_REPLAY_REFUSED');
  });
});
