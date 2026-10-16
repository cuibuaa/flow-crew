import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_SCHEMA, parseStageRecord } from '../src/handoff.js';
import { renderPlanInterface } from '../src/plan-interface.js';
import { generationCompatibleSchema } from '../src/reality-gate/checks/json-schema-match.js';
import { parseDispatchedStageConfig } from '../src/scheduler.js';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { applyBasePrompt } from '../src/scheduler/sched_admission/dispatch.js';
import { appendRaceCandidateEvidenceContext } from '../src/scheduler/sched_policy/prompt-contracts.js';
import { createRun, fcGlobalDir, setFcGlobalDir, type StoreState } from '../src/store.js';
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
    expect(parseStageRecord(JSON.stringify({ status: 'delivered', summary: 'Done.', checks: [], caveats: [] }), HANDOFF_SCHEMA))
      .toEqual({ status: 'delivered', summary: 'Done.', checks: [], caveats: [] });
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

  it('no longer nudges planners toward evidence or handoff documents and tells them gates receive the receipt', () => {
    const plan = renderPlanInterface();
    expect(plan).not.toContain('necessary evidence');
    expect(plan).not.toContain('handoff notes');
    expect(plan).not.toContain('authors report their direct check results');
    expect(plan).toContain('The engine settles configured validation before each gate review, gives the gate its receipt and sends measured regressions to repair. Gates judge the work independently.');
    expect(plan).toContain('create declared terminal documents within admitted write capabilities');
  });
});

describe('engine-held facts and boundaries', () => {
  it('keeps reviewer write isolation without asking for a proof of it', () => {
    const qa = loaded('qa');
    expect(qa).toContain('must not durably modify the reviewed target or authoritative inputs (the engine guards reviewer writes, so this needs no reviewer proof)');
    expect(qa).toContain('Target repairs belong to an author');
  });

  it('opens only engine-named race candidate runs for reading and keeps every other run closed and unwritable', () => {
    const coder = loaded('coder');
    expect(coder).toContain('By default, do not read, browse, or list other `.fc/runs/` directories, except a race candidate run the engine names in your input as read-only evidence.');
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
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done.', checks: [], caveats: [] }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } }, {
      stageId: 'work', projectDir: project, runDir: directory, runId,
      role: { name: 'coder', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Deliver.' },
      dependsOn: [], promptTemplate: 'Deliver.', timeout_ms: 10000, retries: 0, projectWriteScope: [], outputSchema: HANDOFF_SCHEMA,
      artifactContract: { version: 1, produces: [], reads: [], groups: [] },
    });
    expect(seen).toContain('Write declared human deliverables within admitted capabilities. Evidence references name reproducible files or commands.');
    expect(seen).not.toContain('necessary evidence');
  });
});

describe('race candidate evidence for a parent gate', () => {
  let runs: string;
  beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'race-candidate-evidence-')); });
  afterEach(() => rmSync(runs, { recursive: true, force: true }));

  const stages = (race: boolean) => [
    parseDispatchedStageConfig({ id: 'implement', role: 'coder', scope: ['src/**'], race }),
    parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, scope: [], depends_on: ['implement'] }),
    parseDispatchedStageConfig({ id: 'repair', role: 'coder', scope: ['src/**'], depends_on: ['review'], retry_to: ['review'] }),
  ];
  const state = { stages: { implement: { status: 'complete', retries: 0, attempts: [{ index: 2, startedAt: '2026-01-01T00:00:00.000Z', status: 'complete' }] } } } as unknown as StoreState;
  const parent = (record?: unknown) => {
    const runDirPath = join(runs, 'parent');
    mkdirSync(join(runDirPath, 'stages', 'implement'), { recursive: true });
    if (record) writeFileSync(join(runDirPath, 'stages', 'implement', 'race_2.json'), JSON.stringify(record));
    return runDirPath;
  };
  const record = (runId: string) => ({ version: 3, decision: { choice: 'B', basis: 'gated-fallback' },
    candidates: [{ label: 'A', runId: 'candidate-a' }, { label: 'B', runId }] });

  it('names the winning candidate run of the latest raced attempt beside the parent run', () => {
    const runDirPath = parent(record('candidate-b'));
    const [gate] = stages(true).filter(stage => stage.is_gate);
    const prompt = appendRaceCandidateEvidenceContext('Review.', gate, stages(true), state, runDirPath);
    expect(prompt).toContain(`- implement: candidate B, run directory ${join(dirname(runDirPath), 'candidate-b')}`);
    expect(prompt).not.toContain('candidate-a');
  });

  it('adds nothing for authors, unraced stages, races without a winner or a run id that is not a sibling name', () => {
    const all = stages(true);
    const [gate] = all.filter(stage => stage.is_gate);
    expect(appendRaceCandidateEvidenceContext('Author.', all[0], all, state, parent(record('candidate-b')))).toBe('Author.');
    expect(appendRaceCandidateEvidenceContext('Review.', stages(false)[1], stages(false), state, parent(record('candidate-b')))).toBe('Review.');
    expect(appendRaceCandidateEvidenceContext('Review.', gate, all, state, parent({ version: 3, decision: { basis: 'none-passed' }, candidates: [{ label: 'A', runId: 'candidate-a' }] }))).toBe('Review.');
    expect(appendRaceCandidateEvidenceContext('Review.', gate, all, state, parent(record('../escape')))).toBe('Review.');
  });
});
