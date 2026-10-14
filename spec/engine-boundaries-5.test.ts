import { fixtureResult, declaredDispatch } from './test-support/declared-dispatch.js';
import { gateArtifactContract, planArtifactContract } from './spec_presentation/declared-fixtures.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { appendGuidanceEnvelope, readGuidanceForStage } from '../src/guidance.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';

import { runDir } from '../src/store.js';

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
    const planner = parseYaml(readFileSync(join(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml'), 'utf8')).prompt;
    expect(planner).toContain('executable JSON schema');
    expect(planner).toContain('Deliver an admissible plan');
    expect(planner).toContain('stage contract declares the plan output');
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
          write(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringifyYaml({ stages: [
            {dynamic_dispatch: false,  id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['docs/work.md'],
              prompt_template: 'Write docs/work.md.', criterion_refs: refs,
              artifact_contract:{version:1,produces:[{id:'work',root:'project',path:'docs/work.md'}],reads:[],replays:[]} },
            {dynamic_dispatch: false,  id: 'gate', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Check the work.' },
              scope: [], is_gate: true, prompt_template: 'Check all criteria.', criterion_refs: refs },
            {dynamic_dispatch: false, id: 'repair', role: 'coder', depends_on: ['gate'], dependency_reasons: { gate: 'Correct rejected work.' },
              retry_to: ['gate'], scope: ['docs/work.md'], prompt_template: 'Correct docs/work.md using the gate rejection.', criterion_refs: [] },
          ] }), { gate: gateArtifactContract('gate') }));
          write(join(opts.runDir, 'reality_checks.md'), [
            '## Reality checks', '```yaml', 'checks:', '  - name: work artifact',
            '    reads: [{id: work, root: project, path: docs/work.md, source: {kind: stage, stage: work, artifact: work}}]',
            '    type: file-exists-nonempty', '    params: { paths: [docs/work.md] }', '```',
            'The check observes the produced work artifact.',
          ].join('\n'));
          return fixtureResult(ok('first proposal complete'), opts);
        }
        if (opts.stageId === 'work') {
          write(join(project, 'docs/work.md'), '# Work\n');
          return fixtureResult(ok('work complete'), opts);
        }
        if (opts.stageId === 'gate') {
          const criteria = extractBriefCriteria(brief).criteria;
          write(join(opts.runDir, 'fixture_verdict_gate.json'), JSON.stringify({ pass: true,
            criteria: Object.fromEntries(criteria.map((criterion) => [criterion.id,
              { status: 'pass', evidence: 'the work artifact exists' }])),
          }));
          return fixtureResult(ok('gate complete'), opts);
        }
        return fixtureResult(ok('summary complete'), opts);
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

