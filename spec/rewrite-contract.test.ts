import {displayedStageState,currentStatus} from '../rewrite-src/contract/status.mjs';
import {wireStatus} from './fixtures/rewrite-status.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { stringify } from 'yaml';
import { parseBrief, pathSchema } from '../dist-rewrite/contract/brief.js';
import { parsePlan } from '../dist-rewrite/contract/plan.js';
import { answerSchema, type AnswerContext } from '../dist-rewrite/contract/answers.js';
import { parseLaunch, parseSetupRequest, parseSetupEvidence, parseRunRef, parseRunObservation, parseIntervention, parseControlIntent,
 parseOperation, parsePublicRunStatus, parseRunStatusFile, parseRuntime } from '../dist-rewrite/contract/runtime.js';
function declaration() {
  return {
    criteria: [{ id: 'c1', text: 'Deliver independently reviewed evidence.' }],
    inputs: [{ id: 'data', path: 'data/input.txt', kind: 'file', frozen: true, sha256: 'a'.repeat(64) }],
    outputs: [{ path: 'report.md', kind: 'file', existing: 'create' }],
    commands: [{ id: 'check', argv: ['node', 'check.js'], env: {}, inputs: ['data'], required: true }],
    results: [{ id: 'delivered', text: 'The declared deliverable is complete.' }],
    allowBlocked: false,
  };
}
function brief(value: unknown = declaration(), body = '# Goal\nKeep this exact text.\n') {
  return new TextEncoder().encode(`---\n${JSON.stringify(value)}\n---\n${body}`);
}
const planContext = { commandIds: ['check'], checkpointIds: ['safe'], roleIds: ['author', 'reviewer', 'planner'] };
function plan() {
  return { stages: [
      { id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Produce the deliverable.', },
      { id: 'review', role: 'reviewer', purpose: 'gate', after: ['work'], commands: ['check'], repair: { stage: 'work', returnsTo: 'review' } },
    ] };
}
const gateContext: AnswerContext = {
  ...planContext, purpose: 'gate', criterionIds: ['c1'], resultIds: ['delivered'],
  allowBlocked: false, final: true, revision: 'revision_a', briefTexts: ['Deliver independently reviewed evidence.'],
};
function gate() {
  return { kind: 'gate', answer: {
      outcome: 'accepted', reason: 'The evidence satisfies the brief.',
      criteria: { c1: { status: 'pass', evidence: 'Observed independently.' } },
      findings: [], remainingWork: [], result: 'delivered',
    } };
}
it.each([
  [undefined,true], [['src/file.ts','data','tests/'],true],
  [[],false], [[''],false], [['/absolute'],false], [['../escape'],false], [['a/../b'],false],
  [['./file'],false], [['a//b'],false], [['a//'],false], [['a\\b'],false], [['a\nfile'],false],
] as const)('command dependsOn admission: %j', (dependsOn, accepted) => {
  const value = declaration();
  if (dependsOn !== undefined) Object.assign(value.commands[0],{dependsOn});
  const parsed = parseBrief(brief(value));
  expect(parsed.ok).toBe(accepted);
  if (parsed.ok) expect(parsed.value.commands[0].dependsOn).toEqual(dependsOn === undefined ? undefined : ['src/file.ts','data','tests']);
});

it('literal paths: glob characters and colon are ordinary characters in every declared position', () => {
  const paths = ['app/[id]/page.tsx', 'docs/2026-11-21T10:00.md', 'a?b*c/{d}/e', '/abs/[x]/y'];
  for (const path of paths) {
    const value = declaration();
    Object.assign(value, { inputs: [{ ...value.inputs[0], path }], outputs: [{ ...value.outputs[0], path }] });
    expect(parseBrief(brief(value)), path).toMatchObject({ ok: true, value: { inputs: [{ path }], outputs: [{ path }] } });
  }
  const value = declaration();
  Object.assign(value.commands[0], { dependsOn: ['app/[id]', 'src/*'] });
  expect(parseBrief(brief(value)).ok).toBe(true);
});
it('a BOM or CRLF line endings change nothing about the declaration or the body bytes', () => {
  const lf = parseBrief(brief());
  expect(lf.ok).toBe(true);
  const text = new TextDecoder().decode(brief());
  const crlf = new TextEncoder().encode(text.replaceAll('\n', '\r\n'));
  const bom = (bytes: Uint8Array) => Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
  for (const bytes of [crlf, bom(brief()), bom(crlf)]) {
    const parsed = parseBrief(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && lf.ok) expect({ ...parsed.value, body: '' }).toEqual({ ...lf.value, body: '' });
  }
  expect(parseBrief(crlf)).toMatchObject({ ok: true, value: { body: '# Goal\r\nKeep this exact text.\r\n' } });
  // YAML frontmatter on its last line before the delimiter is the case a bare carriage return used to break.
  const yaml = '---\r\ncriteria:\r\n  - {id: c1, text: x}\r\ninputs: []\r\noutputs: []\r\ncommands: []\r\nresults: []\r\nallowBlocked: false\r\n---\r\nbody';
  expect(parseBrief(new TextEncoder().encode(yaml)).ok).toBe(true);
  expect(parseBrief(bom(new TextEncoder().encode(yaml))).ok).toBe(true);
});

describe('rewrite contract: exact brief declaration', () => {
  it('preserves body bytes as text without interpreting prose', () => {
    const body = '\nRejected repairable is a quoted phrase.\r\nDo not derive an outcome from it.\n';
    const parsed = parseBrief(brief(declaration(), body));
    expect(parsed).toMatchObject({ ok: true, value: { ...declaration(), body } });
  });
  it.each([
    ['missing metadata', new TextEncoder().encode('# Goal\nOnly prose.')],
    ['unclosed metadata', new TextEncoder().encode('---\ncriteria: []\n')],
    ['invalid UTF-8', new Uint8Array([0xff])],
    ['duplicate YAML key', new TextEncoder().encode(`---\n${stringify(declaration())}allowBlocked: true\n---\n`)],
    ['duplicate JSON key', new TextEncoder().encode(`---\n${JSON.stringify(declaration()).replace('"allowBlocked":false',
     '"allowBlocked":false,"allowBlocked":true')}\n---\n`)],
    ['duplicate nested key', new TextEncoder().encode(`---\n${JSON.stringify(declaration()).replace('"frozen":true',
     '"frozen":true,"frozen":false')}\n---\n`)],
  ])('refuses %s', (_name, bytes) => {
    expect(parseBrief(bytes).ok).toBe(false);
  });
  it.each([
    ['unknown metadata', { ...declaration(), surprise: true }],
    ['unknown nested criterion field', { ...declaration(), criteria: [{ id: 'c1', text: 'Evidence', optional: true }] }],
    ['duplicate criterion identity', { ...declaration(), criteria: [...declaration().criteria, ...declaration().criteria] }],
    ['duplicate input identity', { ...declaration(), inputs: [...declaration().inputs, ...declaration().inputs] }],
    ['duplicate command identity', { ...declaration(), commands: [...declaration().commands, ...declaration().commands] }],
    ['duplicate result identity', { ...declaration(), results: [...declaration().results, ...declaration().results] }],
    ['undeclared command input', { ...declaration(), commands: [{ ...declaration().commands[0], inputs: ['missing'] }] }],
    ['missing required flag', { ...declaration(), commands: [{ id: 'check', argv: ['node'], env: {}, inputs: [] }] }],
    ['empty command argv', { ...declaration(), commands: [{ ...declaration().commands[0], argv: [] }] }],
    ['invalid hash', { ...declaration(), inputs: [{ ...declaration().inputs[0], sha256: 'not-a-hash' }] }],
    ['empty criteria', { ...declaration(), criteria: [] }],
  ])('refuses %s', (_name, value) => {
    expect(parseBrief(brief(value)).ok).toBe(false);
  });
  it.each([
    ['parent traversal', '../escape'], ['absolute traversal', '/external/../escape'],
    ['dot component', 'docs/./report.md'], ['empty component', 'docs//report.md'],
    ['backslash', 'docs\\report.md'], ['empty', ''],
  ])('refuses %s declaration paths', (_name, path) => {
    expect(parseBrief(brief({ ...declaration(), outputs: [{ ...declaration().outputs[0], path }] })).ok).toBe(false);
  });
  const forbidden = ['\\', ...Array.from({ length: 32 }, (_, index) => String.fromCodePoint(index)), '\u007f'];
  it.each(forbidden.map(character => [character.codePointAt(0)!,
   character] as const))('refuses forbidden code point %i in every path position, including after line separators', (_point, character) => {
    for (const path of [character + 'ab', 'a' + character + 'b', 'ab' + character,
      'a\u2028' + character + 'b', 'a\u2029b' + character]) {
      expect(pathSchema.safeParse(path).success, JSON.stringify(path)).toBe(false);
      for (const declared of [path, '/root/' + path]) {
        expect(parseBrief(brief({ ...declaration(), inputs: [{ ...declaration().inputs[0], path: declared }] })).ok).toBe(false);
        expect(parseBrief(brief({ ...declaration(), outputs: [{ ...declaration().outputs[0], path: declared }] })).ok).toBe(false);
      }
    }
  });
  it.each(['a\u2028\\.md', 'a\u2029b\\c'])('refuses reviewed path bypass %j', path => {
    expect(parseBrief(brief({ ...declaration(), outputs: [{ ...declaration().outputs[0], path }] })).ok).toBe(false);
    expect(answerSchema(gateContext).parse({ ...gate(), answer: { ...gate().answer,
        findings: [{ id: 'f1', paths: [path], reason: 'Evidence.', criterionIds: ['c1'], class: 'advisory' }],
      } }).ok).toBe(false);
  });
  it.each(['a\u2028b.md', 'a\u2029b', '文档/😀.md'])('admits literal Unicode components %j', path => {
    expect(pathSchema.safeParse(path).success).toBe(true);
  });
  it('refuses malformed finding paths; absolute declared products remain admissible', () => {
    for (const path of ['docs//file', 'docs/../file']) {
      expect(answerSchema(gateContext).parse({ ...gate(), answer: { ...gate().answer,
          findings: [{ id: 'f1', paths: [path], reason: 'Evidence.', criterionIds: ['c1'], class: 'advisory' }],
        } }).ok).toBe(false);
    }
  });
  it('admits explicitly declared external inputs and outputs without granting physical access', () => {
    const value = { ...declaration(),
      inputs: [{ ...declaration().inputs[0], path: '/inputs/data.txt' }],
      outputs: [{ ...declaration().outputs[0], path: '/outputs/report.md' }],
    };
    expect(parseBrief(brief(value)).ok).toBe(true);
  });

});
describe('rewrite contract: the planner schema lists the admissible ids', () => {
  /** Every `role`, `commands` item and `baseCheckpoint` property of every stage variant in the rendered JSON schema. */
  const rendered = () => {
    const found: { role: any; commands: any[]; baseCheckpoint: any[] } = { role: [], commands: [], baseCheckpoint: [] };
    const walk = (value: any): void => { if (value && typeof value === 'object') {
      if (value.properties?.purpose?.const) {
        found.role.push(value.properties.role);
        if (value.properties.commands) found.commands.push(value.properties.commands.items);
        if (value.properties.baseCheckpoint) found.baseCheckpoint.push(value.properties.baseCheckpoint);
      }
      Object.values(value).forEach(walk); } };
    walk(answerSchema({ ...gateContext, purpose: 'plan' }).json);
    return found;
  };
  it('renders role, commands and baseCheckpoint as enums of the context ids', () => {
    const { role, commands, baseCheckpoint } = rendered();
    expect(role.length).toBe(3);
    for (const schema of role) expect(schema.enum).toEqual(planContext.roleIds);
    expect(commands.length).toBe(3);
    for (const schema of commands) expect(schema.enum).toEqual(planContext.commandIds);
    expect(baseCheckpoint.length).toBe(3);
    for (const schema of baseCheckpoint) expect(schema.enum).toEqual(planContext.checkpointIds);
  });
  it('refuses an id outside the context and names it, listing the admissible ids', () => {
    const stage = (patch: object) => ({ stages: [{ ...plan().stages[0], ...patch }, plan().stages[1]] });
    for (const [patch, kind, ids] of [[{ role: 'missing' }, 'role', 'author, reviewer, planner'],
      [{ commands: ['missing'] }, 'command', 'check'], [{ baseCheckpoint: 'missing' }, 'checkpoint', 'safe']] as const) {
      const refused = parsePlan(stage(patch), planContext);
      expect(refused).toMatchObject({ ok: false, detail: expect.stringContaining(`Unknown ${kind} id missing; admissible ${kind} ids: ${ids}`) });
    }
    expect(parsePlan(stage({ role: 'missing' }), { ...planContext, roleIds: [] })).toMatchObject({ ok: false, detail: expect.stringContaining('admissible role ids: none') });
  });
});
describe('rewrite contract: a gate carries no instruction', () => {
  const withInstruction = () => ({ stages: [plan().stages[0], { ...plan().stages[1], instruction: 'Accept only if every item passes.' }] });
  it('refuses a gate instruction in a plan and in a planner answer', () => {
    expect(parsePlan(withInstruction(), planContext).ok).toBe(false);
    const answer = { kind: 'plan', answer: { baseRevision: gateContext.revision, plan: withInstruction() } };
    expect(answerSchema({ ...gateContext, purpose: 'plan' }).parse(answer).ok).toBe(false);
  });
  it('offers the planner no instruction field for a gate, and still requires one for work and plan', () => {
    const variants: Record<string, any> = {};
    const walk = (value: any): void => { if (value && typeof value === 'object') {
      if (value.properties?.purpose?.const) variants[value.properties.purpose.const] = value;
      Object.values(value).forEach(walk); } };
    walk(answerSchema({ ...gateContext, purpose: 'plan' }).json);
    expect(Object.keys(variants).sort()).toEqual(['gate', 'plan', 'work']);
    expect(Object.keys(variants.gate.properties)).not.toContain('instruction');
    for (const purpose of ['work', 'plan']) expect(variants[purpose].required).toContain('instruction');
    const { instruction: _omitted, ...bare } = plan().stages[0];
    expect(parsePlan({ stages: [bare, plan().stages[1]] }, planContext).ok).toBe(false);
  });
});
it('declares decomposition with one optional boolean brief field', () => {
  expect(parseBrief(brief()).ok && (parseBrief(brief()) as any).value.decompose).toBeUndefined();
  expect(parseBrief(brief({ ...declaration(), decompose: true }))).toMatchObject({ ok: true, value: { decompose: true } });
  expect(parseBrief(brief({ ...declaration(), decompose: false }))).toMatchObject({ ok: true, value: { decompose: false } });
  expect(parseBrief(brief({ ...declaration(), decompose: 'yes' })).ok).toBe(false);
});
describe('rewrite contract: executable graph and repair references', () => {
  it('admits ordinary work and an independent gate with an explicit repair return', () => {
    expect(parsePlan(plan(), planContext)).toMatchObject({ ok: true, value: plan() });
  });
  const badPlans: [
    string,
    unknown
  ][] = [
    ['duplicate stage identity', { stages: [plan().stages[0], plan().stages[0]] }],
    ['missing dependency', { stages: [{ ...plan().stages[0], after: ['missing'] }] }],
    ['duplicate dependency', { stages: [plan().stages[0], { ...plan().stages[1], after: ['work', 'work'] }] }],
    ['dependency cycle', { stages: [{ ...plan().stages[0], after: ['review'] }, plan().stages[1]] }],
    ['unknown role', { stages: [{ ...plan().stages[0], role: 'undeclared' }] }],
    ['unknown command', { stages: [plan().stages[0], { ...plan().stages[1], commands: ['undeclared'] }] }],
    ['duplicate command', { stages: [plan().stages[0], { ...plan().stages[1], commands: ['check', 'check'] }] }],
    ['unknown checkpoint base', { stages: [{ ...plan().stages[0], baseCheckpoint: 'undeclared' }] }],
    ['missing repair target', { stages: [plan().stages[0], { ...plan().stages[1], repair: { stage: 'missing', returnsTo: 'review' } }] }],
    ['gate repair target', { stages: [plan().stages[0], { ...plan().stages[1], repair: { stage: 'review', returnsTo: 'review' } }] }],
    ['wrong repair return', { stages: [plan().stages[0], { ...plan().stages[1], repair: { stage: 'work', returnsTo: 'work' } }] }],
    ['repair depends on rejecting gate', { stages: [plan().stages[0], { ...plan().stages[1], repair: { stage: 'repair',
     returnsTo: 'review' } }, { ...plan().stages[0], id: 'repair', after: ['review'] }] }],
    ['retired purpose', { stages: [{ ...plan().stages[0], purpose: 'choose' }] }],
    ['planner artifact grammar', { stages: [{ ...plan().stages[0], products: [] }] }],
    ['unknown plan field', { ...plan(), products: [] }],
  ];
  it.each(badPlans)('refuses %s', (_name, value) => {
    expect(parsePlan(value, planContext).ok).toBe(false);
  });
  it('admits a declared checkpoint and planner as a repair target', () => {
    const value = plan();
    const proposed = { stages: [
        { ...value.stages[0], purpose: 'plan', role: 'planner', baseCheckpoint: 'safe' },
        value.stages[1],
      ] };
    expect(parsePlan(proposed, planContext).ok).toBe(true);
  });
  it.each([
    ['declared settled predecessor', ['completed'], 'next', ['completed'], true],
    ['undeclared predecessor', [], 'next', ['completed'], false],
    ['settled identity redefinition', ['completed'], 'completed', [], false],
  ])('pending suffix: %s', (_name, settledStageIds, id, after, admitted) => {
    const value = { kind: 'plan', answer: { baseRevision: 'revision_a', plan: {
          stages: [{ ...plan().stages[0], id, after }],
        } } };
    const context = { ...gateContext, purpose: 'plan' as const, settledStageIds };
    expect(answerSchema(context).parse(value).ok).toBe(admitted);
  });
});
describe('rewrite contract: one typed answer owner', () => {
  const pending = { status: 'not_assessed', reason: 'pending_work', evidence: 'The declared later work has not run.' };
  const failed = { status: 'fail', evidence: 'A declared criterion remains unsatisfied.', briefQuote: 'Deliver independently reviewed evidence.' };
  const gateCases: [
    string,
    AnswerContext,
    unknown,
    boolean
  ][] = [
    ['final accepted', gateContext, gate(), true],
    ['missing criterion', gateContext, { ...gate(), answer: { ...gate().answer, criteria: {} } }, false],
    ['extra criterion', gateContext, { ...gate(), answer: { ...gate().answer, criteria: { ...gate().answer.criteria,
     extra: gate().answer.criteria.c1 } } }, false],
    ['pending intermediate', { ...gateContext, final: false }, { ...gate(), answer: { ...gate().answer, criteria: { c1: pending },
     result: undefined } }, true],
    ['pending final', gateContext, { ...gate(), answer: { ...gate().answer, criteria: { c1: pending } } }, false],
    ['failed full acceptance', gateContext, { ...gate(), answer: { ...gate().answer, criteria: { c1: failed } } }, false],
    ['unpermitted blocked acceptance', gateContext, { ...gate(), answer: { ...gate().answer, outcome: 'accepted_blocked', criteria: {
     c1: failed } } }, false],
    ['permitted blocked acceptance', { ...gateContext, allowBlocked: true }, { ...gate(), answer: { ...gate().answer,
     outcome: 'accepted_blocked' } }, true],
    ['unknown result label', gateContext, { ...gate(), answer: { ...gate().answer, result: 'undeclared' } }, false],
    ['required final result', gateContext, { ...gate(), answer: { ...gate().answer, result: undefined } }, false],
    ['intermediate result label', { ...gateContext, final: false }, gate(), false],
    ['rejected result label', gateContext, { ...gate(), answer: { ...gate().answer, outcome: 'rejected_repairable', criteria: {
     c1: failed } } }, true],
    ['unknown outcome', gateContext, { ...gate(), answer: { ...gate().answer, outcome: 'maybe' } }, false],
    ['unknown nested answer field', gateContext, { ...gate(), answer: { ...gate().answer, effectivePass: true } }, false],
    ['unknown criterion field', gateContext, { ...gate(), answer: { ...gate().answer, criteria: { c1: { ...gate().answer.criteria.c1,
     score: 1 } } } }, false],
    ['wrong purpose envelope', { ...gateContext, purpose: 'work' }, gate(), false],
  ];
  it.each(gateCases)('%s', (_name, context, value, admitted) => {
    expect(answerSchema(context).parse(value).ok).toBe(admitted);
  });
  const labelCases = [
    [true, ['delivered'], 'accepted', 'delivered', true],
    [true, ['delivered'], 'accepted', undefined, false],
    [true, ['delivered'], 'accepted_blocked', 'delivered', true],
    [true, ['delivered'], 'accepted_blocked', undefined, false],
    [true, ['delivered'], 'rejected_repairable', undefined, true],
    [true, ['delivered'], 'rejected_repairable', 'delivered', true],
    [true, ['delivered'], 'rejected_irreparable', undefined, true],
    [true, ['delivered'], 'rejected_irreparable', 'delivered', true],
    [false, ['delivered'], 'accepted', undefined, true],
    [false, ['delivered'], 'accepted', 'delivered', false],
    [true, [], 'accepted', undefined, true],
    [true, [], 'accepted', 'delivered', false],
    [true, ['delivered'], 'accepted', 'unknown', false],
    [true, ['delivered'], 'accepted', ['delivered'], false],
  ] as const;
  it.each(labelCases)('result grammar final=%s labels=%j outcome=%s result=%j', (final, resultIds, outcome, result, expected) => {
    const schema = answerSchema({ ...gateContext, final, resultIds: [...resultIds], allowBlocked: true });
    const value = { ...gate(), answer: { ...gate().answer, outcome, result } };
    expect(schema.parse(value).ok).toBe(expected);
    expect(z.fromJSONSchema(schema.json).safeParse(value).success).toBe(expected);
  });
  it.each([
    ['current revision', 'revision_a', 'safe', true],
    ['stale revision', 'revision_old', 'safe', false],
    ['unknown checkpoint', 'revision_a', 'missing', false],
  ])('plan answer: %s', (_name, baseRevision, baseCheckpoint, admitted) => {
    const proposal = plan();
    const value = { kind: 'plan', answer: { baseRevision, plan: { stages: [{ ...proposal.stages[0], baseCheckpoint }, proposal.stages[1]] } } };
    expect(answerSchema({ ...gateContext, purpose: 'plan' }).parse(value).ok).toBe(admitted);
  });
  it('author evidence is admitted without treating its prose as an engine outcome', () => {
    const value = { kind: 'work', answer: { status: 'environment_gap', summary: 'accepted', caveats: [],
     remainingWork: ['Criterion needs another environment.'], blocks: { criterionIds: ['c1'], paths: ['data/input.txt'] } } };
    expect(answerSchema({ ...gateContext, purpose: 'work' }).parse(value)).toMatchObject({ ok: true, value });
  });
  it.each([
    ['duplicate criteria', { ...gateContext, criterionIds: ['c1', 'c1'] }],
    ['invalid criterion identity', { ...gateContext, criterionIds: ['criterion.with.dot'] }],
    ['duplicate command context', { ...gateContext, commandIds: ['check', 'check'] }],
  ])('refuses schema generation with %s', (_name, context) => {
    expect(() => answerSchema(context)).toThrow();
  });
});
describe('rewrite contract: strict runtime configuration', () => {
  const runtime = { roles: [{ id: 'author', description: 'Writes the deliverable.',
   prompt: 'Follow the brief.', backend: 'codex', model: 'declared-model', effort: 'declared-effort' }], sharedCaches: [], devices: ['/dev/null'], providerHomes: { codex: [], claude: [] } };
  it.each([
    ['declared runtime', runtime, true],
    ['retired duplicate device declaration', { ...runtime, devices: ['/dev/null', '/dev/null'] }, true],
    ['retired device value ignored', { ...runtime, devices: ['/dev/../null'] }, true],
    ['unknown runtime key', { ...runtime, daemon: true }, false],
    ['duplicate role identity', { ...runtime, roles: [...runtime.roles, ...runtime.roles] }, false],
    ['unknown role key', { ...runtime, roles: [{ ...runtime.roles[0], retry: 1 }] }, false],
    ['unknown backend', { ...runtime, roles: [{ ...runtime.roles[0], backend: 'other' }] }, false],
  ])('%s', (_name, value, admitted) => {
    expect(parseRuntime(value).ok).toBe(admitted);
  });
});
describe('rewrite contract: one pinned unit per run and addressed journal commands', () => {
  const hash = 'a'.repeat(64);
  const ref = { path: 'runtime/.pin', sha256: hash };
  const admitted = { bytes: { ...ref, path: 'brief.md' }, declaration: { ...declaration(), body: 'Goal.' },
    digest: hash };
  const role = { id: 'author', description: 'Author.', prompt: 'Follow the brief.', backend: 'codex', model: 'model', effort: 'effort' };
  const unit = { run: 'run_a', authority: 'synthetic-run', runtime: ref };
  const observation = { unit, state: 'unknown', owner: null, evidence: [], detail: 'Not observable.' };
  const setup = { project: 'source', target: 'project', brief: hash, inputs: [], outputs: [], nativeGrant: 'applied', commands: [] };
  const launch = { run: 'run_a', project: 'project', brief: admitted, roles: [role], runtime: ref, setup, unit };
  const intervention = { address: { run: 'run_a', stage: 'work', attempt: 'attempt_a', invocation: 1 }, kind: 'guide', content: ref };
  const intent = { id: 'intent_a', run: 'run_a', unit, expectedCursor: 0, kind: 'start' };
  const operation = { intent, state: 'acknowledged', cursor: 1, observation, evidence: [], detail: 'Appended.' };
  const status = {...wireStatus('run_a'),journalCursor:1,statusSince:0,gates:[{scope:'delivery' as const,stage:'review',attempt:'attempt_a',outcome:'rejected_repairable' as const,answer:ref,cursor:1}]};
  const parsers = [
    ['Launch', parseLaunch, launch], ['SetupRequest', parseSetupRequest, { project: 'source', target: 'project', brief: admitted, runtime: ref }],
    ['SetupEvidence', parseSetupEvidence, setup], ['RunRef', parseRunRef, unit],
    ['UnitObservation', parseRunObservation, observation], ['Intervention', parseIntervention, intervention],
    ['ControlIntent', parseControlIntent, intent], ['Operation', parseOperation, operation],
  ] as const;
  it.each(['codex', 'claude'] as const)('applies one launch backend %s to every role and retains configuration when absent', backend => {
    expect(parseLaunch({ ...launch, backend, roles: [role, { ...role, id: 'gate', backend: 'claude' }] })).toMatchObject({ ok: true,
     value: { backend, roles: [{ ...role, backend }, { ...role, id: 'gate', backend }] } });
    expect(parseLaunch(launch)).toMatchObject({ ok: true, value: { roles: [role] } });
    expect(parseLaunch({ ...launch, backend: 'other' }).ok).toBe(false);
  });
  it.each(parsers)('%s has a strict parser and refuses unknown keys', (_name, parse, value) => {
    expect(parse(value).ok).toBe(true);
    expect(parse({ ...value, surprise: true }).ok).toBe(false);
    expect(parse(null).ok).toBe(false);
  });
  it('projects current status fields from persisted metadata and refuses malformed current fields', () => {
    expect(parseRunStatusFile({ ...status, surprise: true })).toEqual({ ok: true, value: status });
    expect(parseRunStatusFile(null).ok).toBe(false);
  });
  it.each(['start', 'cancel', 'resume', 'guide', 'status'])('admits addressed %s intent', kind => {
    expect(parseControlIntent({ ...intent, kind, ...(kind === 'guide' ? { intervention } : {}) }).ok).toBe(true);
  });
  it.each(['hold'])('refuses removed %s control', kind => {
    expect(parseControlIntent({ ...intent, kind }).ok).toBe(false);
  });
  it.each(['active', 'inactive', 'failed', 'unknown'])('retains %s unit observation without inferring run acceptance', state => {
    expect(parseRunObservation({ ...observation, state })).toMatchObject({ ok: true, value: { state } });
  });
  it.each(['acknowledged', 'unknown', 'refused', 'not_confirmed_closed'])('retains %s operation result', state => {
    expect(parseOperation({ ...operation, state, cursor: state === 'acknowledged' ? 1 : null }).ok).toBe(true);
  });
  const refusals: [
    string,
    (value: unknown) => {
      ok: boolean;
    },
    unknown
  ][] = [
    ['unit runtime hash', parseRunRef, { ...unit, runtime: { ...ref, sha256: 'bad' } }],
    ['unit manager', parseRunRef, { ...unit, manager: 'daemon' }],
    ['empty authority', parseRunRef, { ...unit, authority: '' }],
    ['unknown observation', parseRunObservation, { ...observation, state: 'probably_active' }],
    ['unknown owner metadata', parseRunObservation, { ...observation, owner: { pid: 1, start: 'birth', boot: 'boot', extra: true } }],
    ['unsafe owner pid', parseRunObservation, { ...observation, owner: { pid: 0, start: 'birth', boot: 'boot' } }],
    ['setup path bypass', parseSetupEvidence, { ...setup, target: 'a\u2028\\.md' }],
    ['setup command metadata', parseSetupEvidence, { ...setup, commands: [{ command: 'check' }] }],
    ['setup nested brief', parseSetupRequest, { project: 'source', target: 'project', runtime: ref, brief: { ...admitted, extra: true } }],
    ['launch unit run', parseLaunch, { ...launch, unit: { ...unit, run: 'other' } }],
    ['launch runtime pin', parseLaunch, { ...launch, runtime: { ...ref, sha256: 'b'.repeat(64) } }],
    ['launch setup target', parseLaunch, { ...launch, setup: { ...setup, target: 'other' } }],
    ['launch setup digest', parseLaunch, { ...launch, setup: { ...setup, brief: 'b'.repeat(64) } }],
    ['launch duplicate role', parseLaunch, { ...launch, roles: [role, role] }],
    ['launch plan role', parseLaunch, { ...launch, plan: plan() }],
    ['intervention invocation', parseIntervention, { ...intervention, address: { ...intervention.address, invocation: 0 } }],
    ['intervention authority', parseIntervention, { ...intervention, command: 'undeclared' }],
    ['intent run identity', parseControlIntent, { ...intent, run: 'other' }],
    ['guide run identity', parseControlIntent, { ...intent, kind: 'guide', intervention: { ...intervention, address: {
     ...intervention.address, run: 'other' } } }],
    ['missing guide payload', parseControlIntent, { ...intent, kind: 'guide' }],
    ['payload on cancel', parseControlIntent, { ...intent, kind: 'cancel', intervention }],
    ['negative intent cursor', parseControlIntent, { ...intent, expectedCursor: -1 }],
    ['acknowledgement without cursor', parseOperation, { ...operation, cursor: null }],
    ['negative operation cursor', parseOperation, { ...operation, cursor: -1 }],
    ['operation wrong unit', parseOperation, { ...operation, observation: { ...observation, unit: { ...unit, authority: 'other' } } }],
    ['unknown operation state', parseOperation, { ...operation, state: 'complete' }],
    ['missing status version', parseRunStatusFile, { ...status, version: undefined }],
    ['future status version', parseRunStatusFile, { ...status, version: 5 }],
    ['unknown run status', parseRunStatusFile, { ...status, status: 'maybe' }],
    ['removed stop reason', parseRunStatusFile, { ...status, stopReason: 'held' }],
    ['future gate cursor', parseRunStatusFile, { ...status, journalCursor: 0 }],
    ['duplicate gate attempt', parseRunStatusFile, { ...status, gates: [...status.gates, ...status.gates] }],
    ['gate metadata', parseRunStatusFile, { ...status, gates: [{ ...status.gates[0], score: 1 }] }],
    ['unknown gate outcome', parseRunStatusFile, { ...status, gates: [{ ...status.gates[0], outcome: 'pass' }] }],
    ['negative journal cursor', parseRunStatusFile, { ...status, journalCursor: -1 }],
    ['status entered beyond cursor', parseRunStatusFile, { ...status, statusSince: 2 }],
  ];
  it.each(refusals)('refuses %s', (_name, parse, value) => { expect(parse(value).ok).toBe(false); });
  it.each(['interrupted','unknown'])('accepts declared correction focus on %s with a valid journal lifecycle',state=>{
    const value={...status,status:state,journalStatus:'running',stopReason:null,currentStage:null,
      ...(state==='interrupted'?{interruption:{detail:'interrupted',resume:'flowcrew resume run_a'}}:{}),
      attention:{reason:'recovery_unknown',detail:'Controller unavailable',condition:null},
      host:{...status.host,activation:{state:'unknown',owner:null,checkedAt:null}}};
    expect(parseRunStatusFile(value).ok).toBe(true);
    const {readiness,...host}=value.host;
    expect(parseRunStatusFile({...value,version:4,host}).ok).toBe(false);
    expect(parsePublicRunStatus(value).ok).toBe(true);
    expect(parsePublicRunStatus({...value,focus:'Work'}).ok).toBe(true);
    expect(parsePublicRunStatus({...value,focus:'invalid/id'}).ok).toBe(false);
    expect(parsePublicRunStatus({...value,currentStage:'Work'}).ok).toBe(false);
  });
  it('admits setup command receipts with complete, unfinished and not-started facts', () => {
    const receipt = { key: { tree: hash, declaration: hash, inputHashes: [], context: hash }, command: 'check',
      stdout: ref, stderr: ref, before: hash, after: hash, delta: ref, spent: { durationMs: 0 } };
    for (const execution of [{ state: 'complete', exit: 7 }, { state: 'unfinished', reason: 'closure_unknown' },
      { state: 'not_started', reason: 'preparation_failed' }]) {
      expect(parseSetupEvidence({ ...setup, commands: [{ ...receipt, execution }] }).ok).toBe(true);
      expect(parseSetupEvidence({ ...setup, commands: [{ ...receipt, execution: { ...execution, extra: true } }] }).ok).toBe(false);
    }
  });
  it.each(['opaque identity with spaces', '', 'a/b', 'x'.repeat(201), 'claude:session', 42, null])(
    'launch and status share the opaque requester rule: %j', requester => {
      const accepted = typeof requester === 'string';
      expect(parseLaunch({ ...launch, requester }).ok).toBe(accepted);
      const base = wireStatus('r1', 'pending');
      const snapshot = { ...base, requester, notification: { ...base.notification, session: 'bound' } };
      expect(parseRunStatusFile(snapshot).ok).toBe(accepted);
      expect(parsePublicRunStatus(snapshot).ok).toBe(accepted);
    });
  it('admits a launch plan through the same graph parser', () => {
    expect(parseLaunch({ ...launch, plan: { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Work.',
     }] } }).ok).toBe(true);
  });

});
it('ships native CLI defaults without operational budgets', () => {
  const result = parseRuntime(JSON.parse(readFileSync(new URL('../config/runtime.json', import.meta.url), 'utf8')));
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(Object.keys(result.value)).toEqual(['roles']);
  if (result.ok)
    expect(result.value.roles.map(role => [role.backend, role.model, role.effort])).toEqual(Array(3).fill(['codex', 'default', 'default']));
});
it('ships roles with no prompt of their own, and a role without one adds no text', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config/runtime.json', import.meta.url), 'utf8'));
  expect(shipped.roles.every((role: Record<string, unknown>) => !('prompt' in role))).toBe(true);
  const result = parseRuntime(shipped);
  expect(result.ok && result.value.roles.map(role => role.prompt)).toEqual(['', '', '']);
  expect(parseRuntime({ roles: [{ ...shipped.roles[0], prompt: 'declared' }] })).toMatchObject({ ok: true, value: { roles: [{ prompt: 'declared' }] } });
});
// Independent synthetic transcriptions replace private acceptance declarations.
// The private rehearsal is external and never discovered by Vitest.
describe('public acceptance declaration space', () => {
  const root = new URL('./fixtures/rewrite-acceptance/', import.meta.url);
  const cases = JSON.parse(readFileSync(new URL('expected.json', root), 'utf8'));
  it.each(cases)('$id retains every declaration field and the complete opaque body', item => {
    const bytes = readFileSync(new URL(item.id + '.md', root));
    expect(parseBrief(bytes)).toEqual({ ok: true, value: { ...item.declaration, body: item.body } });
  });
});
it('admits an independent command duration', () => {
  const authored = declaration();
  expect(parseBrief(brief({ ...authored, commands: [{ ...authored.commands[0], durationMs: 60001 }] })).ok).toBe(true);
});

it('records absent human invocation context honestly before the first attempt', () => {
  expect(parseIntervention({ kind: 'guide', address: null, content: { path: 'git/objects/context', sha256: 'a'.repeat(64) } }).ok).toBe(true);
});


it('retires nested command keys identically in public parsing, admission and recorded DTO decoding', async () => {
  const { briefSchema, admittedBriefSchema } = await import('../dist-rewrite/contract/brief.js');
  const command = declaration().commands[0];
  for (const value of [true, false, 'true', null, 1, { ignored: true }]) {
    const metadata = { ...declaration(), commands: [{ ...command, unconfined: value }] }, warnings: string[] = [];
    const parsed = parseBrief(brief(metadata), line => warnings.push(line));
    expect(parsed).toMatchObject({ ok: true, value: { commands: [command] } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('commands[0].unconfined: retired and ignored');
    expect(warnings[0]).toContain('all authors/providers/commands run with host-account rights');
    expect(warnings[0]).toContain('these keys constrain nothing');
    const recorded = { ...metadata, body: 'Goal.' };
    expect(briefSchema.parse(recorded).commands).toEqual([command]);
    const ref = { path: 'brief.md', sha256: 'a'.repeat(64) };
    expect(admittedBriefSchema.parse({ bytes: ref, digest: ref.sha256, declaration: recorded }).declaration.commands).toEqual([command]);
  }
  expect(parseBrief(brief({ ...declaration(), commands: [{ ...command, surprise: true }] })).ok).toBe(false);
  const original = plan();
  expect(parsePlan(original, planContext).ok).toBe(true);
  expect(parsePlan({ stages: [original.stages[0], { ...original.stages[1], unconfined: true }] }, planContext).ok).toBe(false);
});
it('retires runtime sandbox keys together with one visible advisory and still rejects unrelated keys', () => {
  const roles = [{ id: 'role', backend: 'codex', model: 'fixture', effort: 'low', prompt: 'synthetic', description: '' }];
  const warnings: string[] = [];
  expect(parseRuntime({ roles, sharedCaches: ['missing'], devices: null, providerHomes: false }, line => warnings.push(line))).toEqual({ ok: true, value: { roles } });
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('these keys constrain nothing');
  expect(parseRuntime({ roles, another: true }).ok).toBe(false);
});
it('one status decoder reads journal v4 and historical v2/v3 without fabricating readiness on v3', () => {
  const v2 = wireStatus(), { readiness: _old, ...host } = v2.host;
  expect(parseRunStatusFile(v2)).toEqual({ ok: true, value: v2 });
  const v3 = { ...v2, version: 3, host };
  expect(parseRunStatusFile(v3)).toEqual({ ok: true, value: v3 });
  expect(parseRunStatusFile({...v3,version:4})).toEqual({ok:true,value:{...v3,version:4}});
  // heldBytes is optional on v4 (files written before it exist still decode) and must be a count of bytes.
  expect(parseRunStatusFile({...v3,version:4,heldBytes:12})).toEqual({ok:true,value:{...v3,version:4,heldBytes:12}});
  for(const heldBytes of [-1,1.5,'12'])expect(parseRunStatusFile({...v3,version:4,heldBytes}).ok).toBe(false);
  expect(parseRunStatusFile({ ...v3, host: v2.host }).ok).toBe(false);
  expect(parseRunStatusFile({ ...v3, unconfinedCommands: [] }).ok).toBe(false);
  expect(parseRunStatusFile({ ...v2, host }).ok).toBe(false);
});

it('decodes historical authority/setup DTOs and omits sandbox fields from new semantic writes', async () => {
  const { runAuthoritySchema } = await import('../dist-rewrite/contract/runtime.js');
  const grant = { writableRoots: ['/synthetic/project'], protectedRoots: ['/synthetic/records'] };
  const table = { project: '/synthetic/project', interpretation: ['historical v2 interpretation'], preferences: [], parents: [], resources: [],
    outputs: [{ path: 'out', absolute: '/synthetic/project/out', kind: 'file', admission: 'either', original: 'absent', write: 'project',
      provision: false, mutation: 'tree', baseline: 'original-manifest', delivery: { original: 'either', append: false, nonempty: false } }],
    commands: [{ id: 'Verify', scratch: '/synthetic/scratch', env: {}, grant }],
    purposes: { plan: grant, work: grant, gate: grant, command: grant }, providers: { codex: [], claude: [] }, aliases: [] };
  const oldStatus = { ...wireStatus(), authority: table };
  expect(parseRunStatusFile(oldStatus)).toEqual({ ok: true, value: oldStatus });
  const current = runAuthoritySchema.parse(table);
  expect(current).not.toHaveProperty('purposes'); expect(current).not.toHaveProperty('providers'); expect(current).not.toHaveProperty('aliases');
  expect(current.commands[0]).not.toHaveProperty('grant'); expect(current.outputs[0]).not.toHaveProperty('mutation');
  expect(current.outputs[0]).not.toHaveProperty('provision');
  const setup = { project: '/synthetic/source', target: '/synthetic/project', brief: 'a'.repeat(64), inputs: [], outputs: [], commands: [], nativeGrant: 'applied' };
  const parsed = parseSetupEvidence(setup);
  expect(parsed.ok).toBe(true); if (parsed.ok) expect(parsed.value).not.toHaveProperty('nativeGrant');
});

it('retires historical relation fields without exposing them to new authors',()=>{
  const legacy={...plan(),observations:{arbitrary:'retired data'}};
  expect(parsePlan(legacy,planContext)).toEqual({ok:true,value:plan()});
  const work={kind:'work',answer:{status:'delivered',summary:'Historical work',caveats:[],remainingWork:[],blocks:null}};
  const schema=answerSchema({...gateContext,purpose:'work'});
  expect(JSON.stringify(schema.json)).not.toContain('observations');
  expect(schema.parse({...work,answer:{...work.answer,observations:'ignored'}})).toEqual({ok:true,value:work});
  expect(schema.parse({...work,answer:{...work.answer,surprise:true}}).ok).toBe(false);
  expect(JSON.stringify(answerSchema({...gateContext,purpose:'plan'}).json)).not.toContain('observations');
});

it('decodes historical stage skills while omitting them from the live generation grammar', () => {
  const current = plan();
  const historical = { ...current, stages: current.stages.map(stage => ({ ...stage, skills: ['RetiredSkill'] })) };
  expect(parsePlan(historical, planContext)).toEqual({ ok: true, value: current });
  const schema = answerSchema({ ...gateContext, purpose: 'plan' });
  expect(JSON.stringify(schema.json)).not.toContain('"skills"');
  expect(schema.parse({ kind: 'plan', answer: { baseRevision: gateContext.revision, plan: historical } }))
    .toEqual({ ok: true, value: { kind: 'plan', answer: { baseRevision: gateContext.revision, plan: current } } });
});


it('keeps unknown plan and stage object keys as strict-schema refusal Results after retirement', () => {
  for (const key of ['constructor', 'toString']) {
    const proposal = plan();
    for (const value of [{ ...proposal, [key]: { unexpected: true } },
      { ...proposal, stages: [{ ...proposal.stages[0], [key]: { unexpected: true } }, ...proposal.stages.slice(1)] }]) {
      expect(parsePlan(value, planContext)).toMatchObject({ ok: false, kind: 'invalid', detail: expect.stringContaining(key) });
    }
  }
});

// Literal expected rows are independent of the production predicates.
describe('journal disposition to displayed state',()=>{
  const row={id:'Work',purpose:'gate' as const,role:'author',after:[],goal:'Goal',commands:[],revision:'Revision',
    attempts:1,lastEnding:null,verdict:null,startedAt:null,settledAt:null};
  it.each(['parked','needs-correction','interrupted','unknown'])('rejects displayed %s in the journal status file',state=>{
    const {readiness,...host}=wireStatus().host;
    const output={...wireStatus(),version:4,host,stages:[{...row,state}]};
    expect(parseRunStatusFile(output).ok).toBe(false);
    expect(parsePublicRunStatus(output).ok).toBe(true);
  });
  it.each(['pending','dormant','running','settled','skipped'])('decodes journal %s without displaying it twice',state=>{
    const {readiness,...host}=wireStatus().host;
    const file={...wireStatus(),version:4,host,stages:[{...row,state}]};
    expect(parseRunStatusFile(file).ok).toBe(true);
    expect(parsePublicRunStatus(file).ok).toBe(state!=='dormant');
  });
  it('uses the historical current pointer when file focus is absent while public output declares it',()=>{
    const {focus,...value}=wireStatus();
    expect(parseRunStatusFile(value)).toEqual({ok:true,value:{...value,focus:value.currentStage}});
    expect(parsePublicRunStatus(value).ok).toBe(false);
    expect(parsePublicRunStatus({...value,focus:null}).ok).toBe(true);
    expect(focus).toBe('WorkStage');
  });
  it.each([2,3] as const)('reads v%s displayed values without a second stage overlay',version=>{
    const base=wireStatus(),{readiness,...host}=base.host;
    const file={...base,version,status:'parked' as const,currentStage:'Work',focus:'Other',stopReason:'attempt_failed' as const,
      host:version===2?base.host:host,attention:{reason:'attempt_failed' as const,detail:'Historical stop',condition:null},
      stages:[{...row,id:'Work',state:'parked' as const},{...row,id:'Other',state:'needs-correction' as const}]};
    const decoded=parseRunStatusFile(file);expect(decoded).toEqual({ok:true,value:file});
    if(decoded.ok)expect(currentStatus(decoded.value).stages).toEqual(file.stages);
    for(const status of ['interrupted','unknown'] as const){
      const displayed={...file,status,journalStatus:'running',currentStage:null,stopReason:null,
        attention:{reason:'recovery_unknown',detail:'Controller unavailable',condition:null},
        host:{...file.host,activation:{owner:null,state:'unknown',checkedAt:null}},
        ...(status==='interrupted'?{interruption:{detail:'interrupted',resume:'flowcrew resume RunOne'}}:{})};
      expect(parseRunStatusFile(displayed).ok).toBe(true);
      expect(parseRunStatusFile({...displayed,version:4,host}).ok).toBe(false);
    }
  });
  const statuses=['pending','running','parked','interrupted','unknown','complete','accepted_blocked','incomplete','failed','escalated','cancelled'] as const;
  const cases=[
    ['pending',null,null,false,['pending','pending','pending','pending','pending','pending','pending','pending','pending','pending','pending']],
    ['dormant',null,'Work',false,['pending','pending','parked','pending','pending','pending','pending','pending','pending','pending','pending']],
    ['running',null,'Work',false,['pending','running','parked','interrupted','unknown','pending','pending','pending','pending','pending','pending']],
    ['running','invalid_answer','Work',false,['needs-correction','running','parked','interrupted','unknown','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction']],
    ['pending','delivered','Work',false,['pending','pending','parked','pending','pending','pending','pending','pending','pending','pending','pending']],
    ['running',null,null,false,['pending','running','pending','interrupted','unknown','pending','pending','pending','pending','pending','pending']],
    ['pending','invalid_answer','Work',false,['needs-correction','needs-correction','parked','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction']],
    ['pending','invalid_answer',null,false,['needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction']],
    ['settled','invalid_answer','Work',false,['settled','settled','settled','settled','settled','settled','settled','settled','settled','settled','settled']],
    ['skipped','cancelled','Work',false,['skipped','skipped','skipped','skipped','skipped','skipped','skipped','skipped','skipped','skipped','skipped']],
    ['running',null,'Work',true,['pending','pending','pending','pending','pending','pending','pending','pending','pending','pending','pending']],
    ['pending','invalid_answer','Work',true,['needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction','needs-correction']],
  ] as const;
  it.each(cases.flatMap(([state,lastEnding,focus,replaced,expected])=>statuses.map((status,i)=>({state,lastEnding,focus,replaced,status,expected:expected[i]}))))(
    '$state / $lastEnding / focus=$focus / replaced=$replaced / $status -> $expected',({state,lastEnding,focus,replaced,status,expected})=>{
      expect(displayedStageState({...row,state,lastEnding,...(replaced?{replacedBy:'Next'}:{})},{...wireStatus(),status,focus})).toBe(expected);
    });
  it.each(['interrupted','unknown'] as const)('keeps a parked journal row through %s availability',status=>{
    expect(displayedStageState({...row,state:'pending',lastEnding:'invalid_answer'},{...wireStatus(),journalStatus:'parked',status,focus:'Work'})).toBe('parked');
  });
  it.each(['running','parked','interrupted','unknown','complete'] as const)('command progress follows the displayed running decision for %s',status=>{
    const snapshot=currentStatus({...wireStatus(),version:4,focus:'Work',status,journalStatus:status==='interrupted'||status==='unknown'?'running':status,
      ...(status==='interrupted'?{interruption:{detail:'interrupted',resume:'flowcrew resume RunOne'}}:{}),
      host:{interpretation:[],activation:{owner:null,state:status==='running'?'active':'unknown',checkedAt:null}},
      stages:[{...row,state:'running',commandProgress:[{command:'Check',state:'running'}]}]});
    expect(snapshot.stages![0].commandProgress).toEqual(status==='running'?[{command:'Check',state:'running'}]:undefined);
  });
});


it('preserves an optional declared brief title without extracting prose', () => {
  expect(parseBrief(brief({...declaration(),title:'Operator title'},'# Other heading\n')))
    .toMatchObject({ok:true,value:{title:'Operator title',body:'# Other heading\n'}});
  expect(parseBrief(brief({...declaration(),title:42})).ok).toBe(false);
});
// A command past its time limit is the one attention a running run carries without an obligation; it is valid nowhere else.
it('a running run carries a command-limit attention through display, and only a running run with no stop reason may', async () => {
  const {wireStatus}=await import('./fixtures/rewrite-status.js');
  const {currentStatus,commandLimit,validStatus}=await import('../dist-rewrite/contract/status.mjs');
  const attention={reason:'command_limit' as const,cursor:9,condition:null,detail:'command Long passed its time limit'};
  const running={...wireStatus(),version:4,status:'running',journalStatus:'running',stopReason:null,attention,journalCursor:9,statusSince:1,
    host:{interpretation:[],activation:{owner:null,state:'active',checkedAt:null}}};
  expect(validStatus(running)).toBe(true);
  expect(currentStatus(running).attention).toEqual(attention);
  expect(commandLimit(currentStatus(running))).toEqual(attention);
  expect(commandLimit({...running,attention:null})).toBeNull();
  for(const refused of [{...running,status:'parked',journalStatus:'parked',stopReason:'backstop'},{...running,attention:{...attention,condition:'gate'}},
    {...running,stopReason:'cancelled'},{...running,attention:{...attention,reason:'unheard'}}])expect(validStatus(refused)).toBe(false);
});
it.each([2,3] as const)('decodes v%s aggregate times and applies its availability contract without a second stage overlay', async version => {
  const {wireStatus}=await import('./fixtures/rewrite-status.js');
  const {currentStatus,withCurrentBoot}=await import('../dist-rewrite/contract/status.mjs');
  const {observeStatus}=await import('../dist-rewrite/host/identity.mjs');
  const base=wireStatus('Historical'),{readiness,...host}=base.host;
  const row={purpose:'work',role:'author',after:[],goal:'Declared',instruction:'Declared',commands:[],revision:'Revision',attempts:1,lastEnding:null,verdict:null,settledAt:null};
  const value={...base,version,...(version===3?{host}:{}),stages:[
    {...row,id:'Before',state:'settled',startedAt:'2026-11-18T10:00:00Z',settledAt:'2026-11-18T10:02:00Z',lastEnding:'delivered'},
    {...row,id:base.currentStage,state:'running',startedAt:null}],step:{startedAt:'2026-11-18T10:02:00Z',elapsedMs:60000}};
  const {focus,...file}=value;
  const decoded=parseRunStatusFile(file);expect(decoded.ok).toBe(true);if(!decoded.ok)throw Error(decoded.detail);
  expect(decoded.value.focus).toBe(base.currentStage);
  expect(decoded.value.stages?.map(s=>s.segments)).toEqual([
    [{kind:'attempt',startedAt:'2026-11-18T10:00:00Z',endedAt:'2026-11-18T10:02:00Z',ending:'delivered'}],
    [{kind:'attempt',startedAt:'2026-11-18T10:02:00Z',endedAt:null,elapsedMs:60000}]]);
  const owner={pid:42,group:42,start:'birth',boot:'boot',authority:'synthetic'};
  const snapshot={...decoded.value,host:{...decoded.value.host,boot:'boot',activation:{state:'active' as const,owner,checkedAt:null}}};
  expect(currentStatus(snapshot)).toMatchObject({status:'running',stages:decoded.value.stages});
  expect(withCurrentBoot(snapshot,'different-boot')).toMatchObject({status:version===2?'running':'interrupted',interruption:{detail:'interrupted by restart'},stages:decoded.value.stages});
  for(const [state,expected] of [['active','running'],['inactive','interrupted'],['unknown','unknown']] as const){
    const probe=vi.fn(async()=>{if(state!=='active')throw Object.assign(Error('Synthetic native observation'),{code:state==='inactive'?'ESRCH':'EACCES'});return owner;});
    const observed=await observeStatus(snapshot,'boot',probe);
    expect(observed).toMatchObject({status:version===2?'running':expected,stages:decoded.value.stages});
    if(version===2)expect(probe).not.toHaveBeenCalled();
    else expect(probe).toHaveBeenCalledWith(owner.pid);
    expect(observed.stages).toBe(decoded.value.stages);
  }
  expect(parsePublicRunStatus(decoded.value)).toEqual(decoded);
});

it('validates bounded checkpoint, attention cause and recorded backstop time metadata',async()=>{
  const {wireStatus}=await import('./fixtures/rewrite-status.js');
  const base=wireStatus('Facts','parked'),{readiness,...host}=base.host;
  const s={...base,version:4 as const,host};
  const value={...s,checkpoints:{count:4,latestAt:'2026-11-18T14:22:19Z'},
    attention:{...s.attention!,cause:'resume_refused'},backstop:{...s.backstop,pausedAt:'2026-11-18T14:22:19Z'}};
  expect(parseRunStatusFile(value)).toEqual({ok:true,value});
  for(const patch of [{checkpoints:{count:-1,latestAt:null}},{checkpoints:{count:4,latestAt:'unknown'}},
    {attention:{...value.attention,cause:'free prose'}},{backstop:{...value.backstop,pausedAt:'unknown'}}]){
    expect(parseRunStatusFile({...value,...patch}).ok).toBe(false);
  }
});

it.each([2,3] as const)('rejects current-only wire fields in historical v%s files and output',version=>{
  const base=wireStatus('Historical','parked'),{readiness,...host}=base.host;
  const value={...base,version,host:version===2?base.host:host};
  const row={id:'Work',purpose:'work',role:'author',after:[],goal:'Declared',instruction:'Declared',commands:[],revision:'Revision',state:'settled',attempts:1,lastEnding:'delivered',verdict:null,startedAt:null,settledAt:null};
  for(const patch of [{title:'Current title'},{heldBytes:1},{checkpoints:{count:1,latestAt:null}},
    {attention:{...value.attention,cause:'resume_refused'}},{backstop:{...value.backstop,pausedAt:'2026-11-18T14:22:19Z'}}]){
    expect(parseRunStatusFile({...value,...patch}).ok).toBe(false);
    expect(parsePublicRunStatus({...value,...patch}).ok).toBe(false);
  }
  expect(parseRunStatusFile({...value,stages:[{...row,segments:[{kind:'attempt',startedAt:null,endedAt:null,elapsedMs:100}]}]}).ok).toBe(false);
});
describe('rewrite contract: answer fields carry their own meaning', () => {
  type Node = { not?: unknown; properties?: Record<string, Node & { description?: string }>; items?: Node; anyOf?: Node[]; oneOf?: Node[] };
  // Every field the model fills in is described in the schema it is natively constrained by; prose roles do not repeat the format.
  function undescribed(schema: Node, path = ''): string[] {
    const found: string[] = [];
    for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) found.push(...undescribed(branch, path));
    if (schema.items) found.push(...undescribed(schema.items, path + '[]'));
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      const here = `${path}.${key}`;
      if (!['kind', 'answer', 'outcome'].includes(key) && !path.endsWith('.criteria') && !path.includes('.criteria.') && !path.includes('.commandEvidence') && !value.not && !value.description)
        found.push(here);
      found.push(...undescribed(value, here));
    }
    return found;
  }
  it.each([
    ['work', { ...gateContext, purpose: 'work' }],
    ['gate with results and blocking allowed', { ...gateContext, allowBlocked: true }],
    ['progress gate', { ...gateContext, final: false }],
    ['plan', { ...gateContext, purpose: 'plan' }],
  ] as const)('describes every %s field', (_name, context) => {
    expect(undescribed(answerSchema(context as AnswerContext).json as Node)).toEqual([]);
  });
});
