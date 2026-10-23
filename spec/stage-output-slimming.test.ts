import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_SCHEMA, parseStageRecord } from '../src/handoff.js';
import { renderPlanInterface } from '../src/plan-interface.js';
import { generationCompatibleSchema } from '../src/reality-gate/checks/json-schema-match.js';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { applyBasePrompt } from '../src/scheduler/sched_admission/dispatch.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

const agents = resolve(import.meta.dirname, '..', 'config', 'agents');
const base = readFileSync(join(agents, '_base.md'), 'utf8');
const loaded = (role: string): string => applyBasePrompt(parseAgent(parse(readFileSync(join(agents, `${role}.yaml`), 'utf8'))), base).prompt.replace(/\s+/g, ' ');

describe('author results and reports carry only what the brief and readers need', () => {
  it('keeps one not-examined disclosure, scoped to reviewers and their verdict reason', () => {
    expect(base).not.toContain('what you did not examine');
    expect(base).not.toContain('Include direct check exits');
    for (const role of ['coder', 'qa', 'planner']) {
      const text = loaded(role);
      expect(text.split('did not examine'), role).toHaveLength(2);
      expect(text, role).toContain('Reviewers say briefly in their reason what they did not examine and why');
      expect(text, role).toContain('Reviewers give every assigned criterion and every score');
    }
  });

  it('asks delivered authors only for status and summary while blocked results and repairs keep structured checks', () => {
    const coder = loaded('coder');
    expect(coder).toContain('Return delivered or blocked status and a short summary, including any material caveat');
    expect(coder).toContain('Blocked results and repairs list checks with literal commands, direct exit codes and evidence references, and caveats; other delivered results may leave both empty');
    expect(coder).toContain('If blocked, include the attempted approach, exact error/path, suspected cause and a different next approach');
    // Empty arrays already validate, so the schema keeps every key required and
    // closed: removing them from `required` would end constrained generation.
    expect(generationCompatibleSchema(HANDOFF_SCHEMA)).toBe(true);
    expect(parseStageRecord(JSON.stringify({ status: 'delivered', summary: 'Done.', checks: [], caveats: [], remaining_work: [] }), HANDOFF_SCHEMA))
      .toEqual({ status: 'delivered', summary: 'Done.', checks: [], caveats: [], remaining_work: [] });
  });

  it('asks authors for one citable final test log instead of raw evidence sets', () => {
    const coder = loaded('coder');
    expect(coder).toContain('Use engine records for properties they establish; one final test log at a declared run path that a gate can cite is enough');
    expect(coder).not.toContain('raw evidence');
  });
});

describe('a passing verdict is the record', () => {
  it('does not ask gates for documents beyond declared outputs while rejections keep findings', () => {
    const qa = loaded('qa');
    expect(qa).toContain('Return the scheduler\'s typed verdict with reproducible evidence references; beyond declared outputs, a passing verdict is the whole record');
    expect(qa).toContain('A rejection includes concrete repairable findings and whether repair is possible');
    expect(base.replace(/\s+/g, ' ')).toContain('any supporting documents at admitted evidence paths');
  });

  it('no longer nudges planners toward evidence or handoff documents', () => {
    const plan = renderPlanInterface();
    expect(plan).not.toContain('necessary evidence');
    expect(plan).not.toContain('handoff notes');
    expect(plan).not.toContain('authors report their direct check results');
  });
});

describe('engine-held facts and boundaries', () => {
  it('keeps reviewer write isolation without asking for a proof of it', () => {
    const qa = loaded('qa');
    expect(qa).toContain('must not durably modify the reviewed target or authoritative inputs');
    expect(qa).toContain('Target repairs belong to an author');
  });

  it('keeps other run directories closed and unwritable', () => {
    const coder = loaded('coder');
    expect(coder).toContain('By default, do not read, browse, or list other `.fc/runs/` directories.');
    expect(coder).toContain('Never write, move, delete, or otherwise modify any run directory other than this task\'s own run directory. This prohibition is absolute');
  });
});

describe('stage result contract', () => {
  let root: string, project: string, directory: string, runId: string, previousStore: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stage-output-slimming-'));
    project = join(root, 'project'); mkdirSync(project);
    previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
    ({ runId, runDirPath: directory } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
  });
  afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

  it('asks for declared deliverables, not additional evidence, while evidence references stay reproducible', async () => {
    let seen = '';
    await runStage({ async run(prompt) {
      seen = prompt;
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done.', checks: [], caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } }, {
      stageId: 'work', projectDir: project, runDir: directory, runId,
      role: { name: 'coder', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Deliver.' },
      dependsOn: [], promptTemplate: 'Deliver.', timeout_ms: 10000, retries: 0,  outputSchema: HANDOFF_SCHEMA,
      artifactContract: { version: 1, produces: [], reads: [], groups: [] },
    });
    expect(seen).toContain('Write declared human deliverables within admitted capabilities. Evidence references name reproducible files or commands.');
    expect(seen).not.toContain('necessary evidence');
  });
});
