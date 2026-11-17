import {wireStatus} from './fixtures/rewrite-status.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stringify } from 'yaml';
import { parseBrief, pathSchema } from '../dist-rewrite/contract/brief.js';
import { parsePlan } from '../dist-rewrite/contract/plan.js';
import { answerSchema, type AnswerContext } from '../dist-rewrite/contract/answers.js';
import { parseLaunch, parseSetupRequest, parseSetupEvidence, parseRunRef, parseRunObservation, parseIntervention, parseControlIntent,
 parseOperation, parseRunStatusFile, parseRuntime } from '../dist-rewrite/contract/runtime.js';
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
      { id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Produce the deliverable.', skills: [] },
      { id: 'review', role: 'reviewer', purpose: 'gate', after: ['work'], instruction: 'Assess the declared criteria.', skills: [],
       commands: ['check'], repair: { stage: 'work', returnsTo: 'review' } },
    ] };
}
const gateContext: AnswerContext = {
  ...planContext, purpose: 'gate', criterionIds: ['c1'], resultIds: ['delivered'],
  allowBlocked: false, final: true, revision: 'revision_a',
};
function gate() {
  return { kind: 'gate', answer: {
      outcome: 'accepted', reason: 'The evidence satisfies the brief.',
      criteria: { c1: { status: 'pass', evidence: 'Observed independently.' } },
      findings: [], remainingWork: [], result: 'delivered',
    } };
}
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
    ['backslash', 'docs\\report.md'], ['glob', 'docs/*.md'], ['empty', ''],
  ])('refuses %s declaration paths', (_name, path) => {
    expect(parseBrief(brief({ ...declaration(), outputs: [{ ...declaration().outputs[0], path }] })).ok).toBe(false);
  });
  const forbidden = [...'\\:*?[]{}', ...Array.from({ length: 32 }, (_, index) => String.fromCodePoint(index)), '\u007f'];
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
  it.each(['a\u2028*.md', 'a\u2029b\\c'])('refuses reviewed path bypass %j', path => {
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
  const failed = { status: 'fail', evidence: 'A declared criterion remains unsatisfied.' };
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
     outcome: 'accepted_blocked', criteria: { c1: failed } } }, true],
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
    ['duplicate device declaration', { ...runtime, devices: ['/dev/null', '/dev/null'] }, false],
    ['invalid device path', { ...runtime, devices: ['/dev/../null'] }, false],
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
  it.each(['acknowledged', 'in_progress', 'unknown', 'refused', 'not_confirmed_closed'])('retains %s operation result', state => {
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
    ['setup path bypass', parseSetupEvidence, { ...setup, target: 'a\u2028*.md' }],
    ['setup command metadata', parseSetupEvidence, { ...setup, commands: [{ command: 'check' }] }],
    ['setup nested brief', parseSetupRequest, { project: 'source', target: 'project', runtime: ref, brief: { ...admitted, extra: true } }],
    ['setup native grant', parseSetupEvidence, { ...setup, nativeGrant: 'fallback' }],
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
    ['future status version', parseRunStatusFile, { ...status, version: 3 }],
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
  it('admits setup command receipts with complete, unfinished and not-started facts', () => {
    const receipt = { key: { tree: hash, declaration: hash, inputHashes: [], context: hash }, command: 'check',
      stdout: ref, stderr: ref, before: hash, after: hash, observed: { before: [], after: [] }, delta: ref, spent: { durationMs: 0 } };
    for (const execution of [{ state: 'complete', exit: 7 }, { state: 'unfinished', reason: 'closure_unknown' },
      { state: 'not_started', reason: 'preparation_failed' }]) {
      expect(parseSetupEvidence({ ...setup, commands: [{ ...receipt, execution }] }).ok).toBe(true);
      expect(parseSetupEvidence({ ...setup, commands: [{ ...receipt, execution: { ...execution, extra: true } }] }).ok).toBe(false);
    }
  });
  it('admits a launch plan through the same graph parser', () => {
    expect(parseLaunch({ ...launch, plan: { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Work.',
     skills: [] }] } }).ok).toBe(true);
  });

});
describe('opaque requester identity', () => {
  it('is carried verbatim and only format-checked', async () => {
    const { parseRunStatusFile } = await import('../dist-rewrite/contract/runtime.js');
    const base = wireStatus('r1','pending');
    expect(parseRunStatusFile(base).ok).toBe(true);
    const withRequester = parseRunStatusFile({ ...base, requester: 'claude:00000000-0000-4000-8000-000000000001', notification:{...base.notification,session:'bound'} });
    expect(withRequester.ok && withRequester.value.requester).toBe('claude:00000000-0000-4000-8000-000000000001');
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(201)])
      expect(parseRunStatusFile({ ...base, requester: bad }).ok).toBe(false);
  });
});
it('ships native CLI defaults without operational budgets', () => {
  const result = parseRuntime(JSON.parse(readFileSync(new URL('../config/runtime.json', import.meta.url), 'utf8')));
  expect(result).toMatchObject({ ok: true, value: {
      sharedCaches: [], devices: ['/dev/null'], providerHomes: { codex: ['.codex'], claude: ['.claude', '.claude.json'] },
    } });
  if (result.ok)
    expect(result.value.roles.map(role => [role.backend, role.model, role.effort])).toEqual(Array(3).fill(['codex', 'default', 'default']));
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
