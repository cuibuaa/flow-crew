import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { parseDispatchedStageConfig, WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';
import { readRunState, runDir } from '../src/store.js';

const agentsDir = join(import.meta.dirname, '../config/agents');
const brief = '---\noutputs: [report.md]\n---\n# Deliver an answer\n\n## Acceptance criteria\n1. answer.txt contains the new answer and literal $&.\n2. report.md describes the answer.\n';
const refs = extractBriefCriteria(brief).criteria.map(criterion => criterion.id);
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-inputs-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(conditional?: 'active' | 'inactive', customPrompt: boolean | 'full-brief' = false, gateFact?: 'work' | 'prepare', gateStatus = 'complete') {
  const project = join(directory, 'project'); mkdirSync(project);
  mkdirSync(join(project, 'config'));
  setEngineDefaults({ stage_technical_retries: 0, gate_retry_loops: 0 });
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  isolatedProjectCommand('git', ['init', '-q'], project, directory);
  isolatedProjectCommand('git', ['add', '.'], project, directory);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input'], project, directory);
  const author = parseDispatchedStageConfig({ id: 'work', role: 'coder', depends_on: ['prepare'], scope: ['answer.txt'], race: true,
    prompt_template: customPrompt === 'full-brief' ? brief : customPrompt ? 'Implement the new answer.\n\n## Acceptance criteria\n2. Keep this stage-specific implementation duty.\n' : undefined,
    criterion_refs: [refs[0]], artifact_contract: { version: 1, produces: conditional ? [{ id: 'build', root: 'run', path: 'stages/work/build', kind: 'directory',
      when: { stage: 'prepare', field: 'exitCode', equals: conditional === 'active' ? 0 : 1 } }] : [], reads: conditional ? [{ id: 'prepared', root: 'run', path: 'stages/prepare/input.txt',
      source: { kind: 'stage', stage: 'prepare', artifact: 'input' }, when: { stage: 'prepare', field: 'exitCode', equals: conditional === 'active' ? 0 : 1 } }] : [], replays: [] } });
  const workflow = WorkflowConfigSchema.parse({ name: 'race_inputs', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
    parseDispatchedStageConfig({ id: 'prepare', role: 'coder', scope: ['input.txt'], artifact_contract: { version: 1, produces: [{ id: 'input', root: 'run', path: 'stages/prepare/input.txt' }], reads: [], replays: [] } }), author,
    parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: gateFact ? ['work', 'prepare'] : ['work'],
      condition: gateFact ? `${gateFact}.status == ${JSON.stringify(gateStatus)}` : undefined,
      is_gate: true, scope: [], criterion_refs: [refs[0]],
      ...(gateFact ? { artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }],
        reads: [{ id: 'prepared', root: 'run', path: 'stages/prepare/input.txt', source: { kind: 'stage', stage: 'prepare', artifact: 'input' } }] } } : {}),
    }),
    parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['answer.txt'] }),
    parseDispatchedStageConfig({ id: 'report', role: 'coder', depends_on: ['review'], scope: ['report.md'], criterion_refs: [refs[1]] }),
    parseDispatchedStageConfig({ id: 'final', role: 'qa', depends_on: ['report'], is_gate: true, scope: [], criterion_refs: [refs[1]] }),
    parseDispatchedStageConfig({ id: 'report_repair', role: 'coder', depends_on: ['final'], retry_to: ['final'], scope: ['report.md'] }),
  ] });
  let parentRunId = '';
  const authors: Array<{ prompt: string; options: RunOpts; contract: { produces: Array<{ when?: unknown }>; reads: Array<{ when?: unknown; source: { kind: string } }> } }> = [];
  const reviewInputs: string[] = [];
  const record = (summary: string) => JSON.stringify({ status: 'delivered', summary, checks: [], caveats: [] });
  const adapter: Adapter = { async run(prompt, role, opts) {
    if (opts.stageId === '_summary') return { output: 'Summary.', exitCode: 0, duration_ms: 0 };
    if (opts.stageId === 'prepare') {
      parentRunId = JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId;
      writeFileSync(join(opts.workDir, 'input.txt'), 'frozen predecessor input\n');
      writeFileSync(join(opts.runDir, 'stages/prepare/input.txt'), 'frozen predecessor input\n');
      return { output: record('Prepared input. '.repeat(1000)), exitCode: 0, duration_ms: 0, writes: ['input.txt', 'run:stages/prepare/input.txt'], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'work') {
      const contract = parse(readFileSync(join(opts.runDir, 'workflow.yaml'), 'utf8'));
      authors.push({ prompt, options: opts, contract: contract.stages.find((stage: { id: string }) => stage.id === 'work').artifact_contract });
      writeFileSync(join(opts.workDir, 'answer.txt'), 'new answer $&\n');
      const writes = ['answer.txt'];
      if (conditional === 'active') {
        mkdirSync(join(opts.runDir, 'stages/work/build'), { recursive: true });
        writeFileSync(join(opts.runDir, 'stages/work/build/result.txt'), 'new answer $&\n');
        writes.push('run:stages/work/build/result.txt');
      }
      return { output: record('Delivered answer.'), exitCode: 0, duration_ms: 0, writes, writeAttribution: 'structured' };
    }
    if (opts.stageId === 'report') {
      writeFileSync(join(opts.workDir, 'report.md'), 'The answer is new answer $&.\n');
      return { output: record('Reported answer.'), exitCode: 0, duration_ms: 0, writes: ['report.md'], writeAttribution: 'structured' };
    }
    const assigned = opts.stageId === 'review' ? refs[0] : refs[1];
    if (opts.stageId === 'review' && gateFact) {
      expect(prompt).toContain(join(opts.runDir, 'stages/prepare'));
      expect(readFileSync(join(opts.runDir, 'stages/prepare/output.md'), 'utf8')).toContain('Prepared input.');
      reviewInputs.push(readFileSync(join(opts.runDir, 'stages/prepare/input.txt'), 'utf8'));
    }
    const pass = readFileSync(join(opts.workDir, 'answer.txt'), 'utf8') === 'new answer $&\n';
    return { output: JSON.stringify({ pass, reason: 'Inspected the delivered answer.', criteria: { [assigned]: { status: pass ? 'pass' : 'fail', evidence: 'answer.txt contains exactly new answer $&.' } },
      audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 0 };
  } };
  const state = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, agentsDir, undefined, brief, false, undefined, false);
  const race = JSON.parse(readFileSync(join(runDir(project, state.runId), 'stages/work/race_1.json'), 'utf8'));
  const childFailures = race.candidates.map((candidate: { target: string; runId?: string }) => candidate.runId ? readRunState(candidate.target, candidate.runId).failureReason : candidate);
  return { state, authors, parentRunId, project, childFailures, reviewInputs };
}

describe('race stage input contracts', () => {
  it.each(['work', 'prepare'] as const)('projects settled ancestor inputs and evaluates a gate condition on %s', async gateFact => {
    const { state, reviewInputs } = await fixture(undefined, false, gateFact);
    expect(state.status, state.failureReason).toBe('complete');
    expect(reviewInputs).toHaveLength(1);
    expect(reviewInputs.every(input => input === 'frozen predecessor input\n')).toBe(true);
  });
  it('refuses candidate completion when its conditional independent gate does not execute', async () => {
    const { state, project } = await fixture(undefined, false, 'work', 'failed');
    expect(state.status).toBe('incomplete');
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('old answer\n');
  });
  it.each(['active', 'inactive'] as const)('settles %s artifact predicates from the completed parent predecessor', async activation => {
    const { state, authors, project, childFailures } = await fixture(activation);
    expect(state.status, JSON.stringify(childFailures)).toBe('complete');
    expect(authors).toHaveLength(1);
    for (const author of authors) {
      expect(author.contract.produces).toHaveLength(activation === 'active' ? 1 : 0);
      expect(author.contract.reads).toHaveLength(activation === 'active' ? 1 : 0);
      if (activation === 'active') {
        expect(author.contract.produces[0].when).toBeUndefined();
        expect(author.contract.reads[0]).toMatchObject({ source: { kind: 'input' } });
        expect(author.contract.reads[0].when).toBeUndefined();
        expect(readFileSync(join(author.options.runDir, 'stages/prepare/input.txt'), 'utf8')).toBe('frozen predecessor input\n');
      }
    }
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer $&\n');
  });
  it('compiles each child prompt once with its own identity and assigned duties', async () => {
    const { state, authors, parentRunId } = await fixture();
    expect(state.status, state.failureReason).toBe('complete');
    for (const { prompt, options } of authors) {
      expect(prompt).toContain('literal $&');
      expect(prompt).not.toContain('Declared outputs required by the brief');
      expect(prompt).not.toContain('report.md');
      expect(prompt).not.toContain(parentRunId);
      expect(prompt).toContain('Complete predecessor stage directory:');
      expect(prompt).toContain(join(options.runDir, 'stages/prepare'));
      expect(prompt.match(/# Stage result/g)).toHaveLength(1);
      expect(readFileSync(join(options.runDir, 'stages/prepare/output.md'), 'utf8')).toContain('Prepared input.');
    }
  });

  it('preserves custom stage duties whose local numbering differs from canonical criteria', async () => {
    const { state, authors } = await fixture(undefined, true);
    expect(state.status, state.failureReason).toBe('complete');
    for (const author of authors) expect(author.prompt).toContain('2. Keep this stage-specific implementation duty.');
  });
  it('scopes an exact full brief template including its frontmatter', async () => {
    const { state, authors } = await fixture(undefined, 'full-brief');
    expect(state.status, state.failureReason).toBe('complete');
    for (const author of authors) expect(author.prompt).not.toContain('report.md');
  });
});
