import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { BriefAuthorizationsSchema, declaredAuthorization } from '../src/brief-authorizations.js';
import { readRunState, writeRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';
import { foldItems, resolveRequest } from '../src/inbox.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { ScriptedAdapter, scriptedRecord } from '../src/adapters/scripted.js';
import type { Adapter } from '../src/adapters/base.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { SessionPush, renderPushEvent } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'brief-authority-')); roots.push(root); return root; }
const brief = (authorizations?: unknown) => `---\n${stringify({ workflow: 'direct', ...(authorizations === undefined ? {} : { authorizations }) })}---\n# Authority probe\n## Acceptance criteria\n1. Perform the categorized effect only after a decision.\n`;
const declared = { provider_calls: true as const, downloads: { hosts: ['huggingface.co'] }, spend: { usd: 50 } };

async function inspect(request: Record<string, unknown>, declaration: unknown = declared) {
  const projectDir = project();
  const created = createRun(projectDir, 'probe', 'name: probe\nstages: []\n', ['work']);
  const state = readRunState(projectDir, created.runId);
  // Also exercise defense in depth against an invalid historical state, rather
  // than pretending an invalid declaration passed current admission.
  state.authorizations = declaration as typeof state.authorizations;
  writeRunState(projectDir, created.runId, state);
  const slot = join(created.runDirPath, 'stages/work'); mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, 'approval_request.json'), JSON.stringify({
    id: 'effect', action: 'perform', risk: 'external', title: 'Same title', target: 'Same target', ...request,
  }));
  const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
  const parked = await monitor.tryParkOnApprovalRequest(state, { projectDir, ...created, iteration: 1 });
  const item = foldItems(created.runId).get(typeof request.id === 'string' ? request.id : 'effect')!;
  retainRecords(created.runDirPath, `monitor/${created.runId}`, { run: created.runDirPath, runId: created.runId, parked: Boolean(parked), item });
  return { ...created, projectDir, parked, item };
}

function retainRecords(run: string, directory: string, result: unknown) {
  const files: Record<string, string> = { 'result.json': JSON.stringify(result, null, 2) };
  const paths = ['run.json', 'events.jsonl', 'approvals.jsonl', 'task_brief.md', 'brief_criteria.json', 'stages/work/status.json', 'stages/review/status.json'];
  if (existsSync(join(run, 'approvals'))) paths.push(...readdirSync(join(run, 'approvals')).map(name => `approvals/${name}`));
  for (const path of paths) if (existsSync(join(run, path))) files[`run/${path}`] = readFileSync(join(run, path), 'utf8');
  // Structured fixture evidence, not an external input or a test precondition.
  console.log(`PUSH_AUTH_RECORD ${JSON.stringify({ directory, files })}`);
}

describe('bounded brief authority uses only the stage category and declared bound', () => {
  it.each([
    [{ category: 'provider_calls' }, 'authorizations.provider_calls'],
    [{ category: 'spend', amountUsd: 0 }, 'authorizations.spend'],
    [{ category: 'spend', amountUsd: 50 }, 'authorizations.spend'],
    [{ category: 'downloads', host: 'huggingface.co' }, 'authorizations.downloads'],
  ])('answers %j in the declaration without parking', async (effect, field) => {
    const f = await inspect(effect);
    expect(f.parked).toBeNull();
    expect(f.item).toMatchObject({ state: 'approved', resolution: { source: 'scheduler', viaDeclaration: field } });
    const decision = JSON.parse(readFileSync(join(f.runDirPath, 'approvals/effect.decision.json'), 'utf8'));
    expect(decision).toMatchObject({ decision: 'approve', source: 'scheduler', viaDeclaration: field });
    expect(decision.reason).toContain('Authorized by brief');
    const lines = readFileSync(join(f.runDirPath, 'approvals.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.kind)).toEqual(['request', 'resolution']);
    expect(resolveRequest(f.projectDir, f.runId, 'effect', 'deny').won).toBe(false);
  });

  it.each([
    {}, { category: 'unknown' }, { category: 'spend', amountUsd: 50.01 },
    { category: 'spend' }, { category: 'spend', amountUsd: -1 }, { category: 'spend', amountUsd: '50' },
    { category: 'downloads', host: 'cdn.huggingface.co' }, { category: 'downloads', host: 'HUGGINGFACE.CO' },
    { category: 'downloads', host: 'https://huggingface.co/path' }, { category: 'downloads' },
    { category: 'provider_calls', amountUsd: 50 },
    ...['credentials', 'other_repositories', 'user_data_deletion', 'shared_devices', 'external_git_history'].map(category => ({ category })),
  ])('parks %j without reading its title or target as authority', async effect => {
    const f = await inspect({ title: 'Run configured provider under $50 on huggingface.co', target: 'provider_calls', ...effect });
    expect(f.parked?.status).toBe('parked');
    expect(f.item.state).toBe('pending');
  });

  it('keeps a category-less historical request readable and parked without a declaration', async () => {
    const f = await inspect({}, null);
    expect(f.parked?.status).toBe('parked');
    expect(f.item.category).toBeUndefined();
  });
  it('parks an external request whose category is not declared, even when its prose says configured provider', async () => {
    const f = await inspect({ category: 'provider_calls', title: 'Configured provider calls', target: 'configured provider' }, {});
    expect(f.parked?.status).toBe('parked');
    expect(f.item.state).toBe('pending');
  });

  it.each(['credentials', 'other_repositories', 'user_data_deletion', 'shared_devices', 'external_git_history'])('refuses admission of %s and cannot grant it from invalid historical state', async category => {
    const invalid = { ...declared, [category]: true };
    const parsed = parseBriefFrontmatter(brief(invalid));
    expect(parsed.authorizations).toBeUndefined();
    expect(parsed.authorizationsError).toContain('Invalid authorizations declaration');
    expect(inspectBrief(brief(invalid)).findings).toContainEqual(expect.objectContaining({ code: 'brief_authorizations', level: 'warn' }));
    const f = await inspect({ category }, invalid);
    expect(f.parked?.status).toBe('parked');
    expect(f.item.state).toBe('pending');
  });

  it.each([
    { provider_calls: false }, { spend: { usd: -1 } }, { spend: { usd: '50' } },
    { downloads: { hosts: [] } }, { downloads: { hosts: ['*.example.com'] } },
    { downloads: { hosts: ['example.com:443'] } }, { spend: { usd: 50, extra: true } },
  ])('refuses invalid declaration %j', declaration => {
    expect(BriefAuthorizationsSchema.safeParse(declaration).success).toBe(false);
    expect(parseBriefFrontmatter(brief(declaration)).authorizationsError).toBeTruthy();
  });

  it('does not change declaration-less brief semantics', () => {
    expect(parseBriefFrontmatter(brief()).authorizations).toBeUndefined();
    expect(parseBriefFrontmatter(brief()).authorizationsError).toBeUndefined();
    expect(declaredAuthorization(undefined, { category: 'provider_calls' })).toBeUndefined();
    expect(declaredAuthorization(declared, { category: 'spend', amountUsd: Infinity })).toBeUndefined();
    expect(declaredAuthorization(declared, { category: 'spend', amountUsd: NaN })).toBeUndefined();
  });
});

// An authored static stage runs through the real scheduler and ScriptedAdapter.
// No provider/network effect is performed. The request is the intended effect.
function authorityWorkflow(projectDir: string, taskBrief: string) {
  const criteria = extractBriefCriteria(taskBrief).criteria;
  const criterion_refs = criteria.map(item => item.id);
  const workflowFile = join(projectDir, 'workflow.yaml');
  writeFileSync(workflowFile, stringify({ name: 'authority_probe', defaults: { max_iterations: 1, max_retries: 0 },
    stages: [
      { id: 'work', role: 'coder', scope: [], criterion_refs, prompt_template: 'Perform the authority probe.', artifact_contract: fixtureArtifactContract('work') },
      { id: 'review', role: 'qa', scope: [], criterion_refs, is_gate: true, depends_on: ['work'], prompt_template: 'Review the authority probe.', artifact_contract: fixtureArtifactContract('review', true) },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], prompt_template: 'Repair the authority probe.', artifact_contract: fixtureArtifactContract('repair') },
    ] }));
  const { config, raw } = loadWorkflow(workflowFile);
  return { config, raw, criteria };
}

async function scripted(name: string, effect: Record<string, unknown> | undefined, declaration?: unknown) {
  const projectDir = project();
  const { config, raw, criteria } = authorityWorkflow(projectDir, brief(declaration));
  const adapter = new ScriptedAdapter({ work: { output: 'Completed the probe.', ...(effect ? { runFiles: {
    'stages/work/approval_request.json': JSON.stringify({ id: 'effect', risk: 'external', action: 'perform', title: 'Probe request', target: 'Probe target', ...effect }),
  } } : {}) }, review: { output: 'reviewed', runFiles: { 'verdict_review.json': JSON.stringify({ pass: true, reason: 'Synthetic authority effect checked.',
    criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'approvals.jsonl' }])) }) } },
  _summary: { output: 'Synthetic authority probe.' } });
  const state = await runWorkflow(config, raw, projectDir, adapter, new Map(), undefined,
    resolve('config/agents'), undefined, brief(declaration), true, undefined, false);
  const { runDir } = await import('../src/store.js');
  const run = runDir(projectDir, state.runId);
  const item = foldItems(state.runId).get('effect');
  const taskRegistry = new TaskRegistry({ baseDir: (await import('../src/store.js')).fcGlobalDir() });
  const task = taskRegistry.create({ name: 'Authority probe', projectDir, status: state.status === 'parked' ? 'parked' : 'completed', run_id: state.runId,
    launcher: { frontend: 'claude', sessionId: 'probe-session', cwd: projectDir, ledgerRoot: join(projectDir, 'ledger') } });
  const push = new SessionPush(taskRegistry);
  push.capture(task);
  const human = push.pending('probe-session').map(event => renderPushEvent(event, taskRegistry.baseDir).human);
  retainRecords(run, `scripted/${name}`, { state: state.status, run, runId: state.runId, item, human, calls: adapter.calls });
  return { state, adapter, item, human, config, raw, run };
}

describe('scripted scheduler authority and authored prompt', () => {
  it('loads the declaration and answers in-declaration spend without parking; authored prompt has provider authority and category contract', async () => {
    const f = await scripted('in-declaration', { category: 'spend', amountUsd: 50 }, { spend: { usd: 50 } });
    expect(f.state.status).toBe('complete');
    expect(f.item).toMatchObject({ state: 'approved', resolution: { viaDeclaration: 'authorizations.spend', source: 'scheduler' } });
    expect(f.adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(['work', 'review']);
    expect(f.adapter.calls[0].prompt).toContain("Calls to the run's configured provider are inside the run's authority and never require an approval request.");
    expect(f.adapter.calls[0].prompt).toContain('Current brief authorizations: {"spend":{"usd":50}}.');
    expect(f.adapter.calls[0].prompt).toContain('You own the category judgment: name exactly one of provider_calls, downloads, spend, credentials, other_repositories, user_data_deletion, shared_devices, external_git_history.');
  });
  it.each([
    ['out-of-declaration', { category: 'spend', amountUsd: 51 }],
    ['missing-category', {}], ['unknown-category', { category: 'not_a_category' }],
    ['never-declarable', { category: 'credentials' }],
  ])('parks scripted %s with the human approval line', async (name, request) => {
    const f = await scripted(name, request, { spend: { usd: 50 } });
    expect(f.state.status).toBe('parked');
    expect(f.item?.state).toBe('pending');
    expect(f.human.some(line => line.includes('Authority probe: needs approval. Request: Probe request. Target: Probe target.') && line.includes('flowcrew inbox approve'))).toBe(true);
  });
  it('does not admit a never-declarable frontmatter key, records the diagnostic, and parks its request', async () => {
    const f = await scripted('invalid-declaration', { category: 'credentials' }, { credentials: true });
    expect(f.state.status).toBe('parked');
    expect(f.state.authorizations).toBeUndefined();
    expect(f.item?.state).toBe('pending');
    expect(f.adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(['work']);
    const { readRunEvents } = await import('../src/run-events.js');
    expect(readRunEvents(f.state.projectDir, f.state.runId)).toContainEqual(expect.objectContaining({
      type: 'execution_notice', source: 'scheduler', detail: expect.stringContaining('Invalid authorizations declaration'),
    }));
  });
  it('runs a brief without the new declaration unchanged', async () => {
    const f = await scripted('legacy-brief', undefined);
    expect(f.state.status).toBe('complete');
    expect(f.state.authorizations).toBeUndefined();
    expect(f.adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(['work', 'review']);
  });

  it.each([
    ['removed', undefined],
    ['empty', {}],
    ['invalid', { credentials: true }],
  ])('clears %s authority on an explicitly admitted continuation, preserving prior decisions', async (name, declaration) => {
    const first = await scripted(`continuation-${name}-initial`, { category: 'credentials' }, { spend: { usd: 50 } });
    expect(first.state.status).toBe('parked');
    expect(first.state.authorizations).toEqual({ spend: { usd: 50 } });
    resolveRequest(first.state.projectDir, first.state.runId, 'effect', 'deny', { by: 'operator', source: 'operator' });
    const originalDecision = readFileSync(join(first.run, 'approvals/effect.decision.json'), 'utf8');
    const continuedBrief = brief(declaration);
    writeFileSync(join(first.run, 'task_brief.md'), continuedBrief);
    const admission = createBriefAdmission(inspectBrief(continuedBrief), {
      kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString(),
    });
    const adapter = new ScriptedAdapter({ work: { output: 'Await a new spend decision.', runFiles: {
      'stages/work/approval_request.json': JSON.stringify({ id: 'new-spend', risk: 'external', action: 'spend',
        category: 'spend', amountUsd: 50, title: 'Spend after declaration removed', target: 'Synthetic effect only' }),
    } }, _summary: { output: 'Pending authority.' } });
    const state = await runWorkflow(first.config, first.raw, first.state.projectDir, adapter, new Map(), undefined,
      resolve('config/agents'), first.state.runId, continuedBrief, true, undefined, false, admission);
    const item = foldItems(state.runId).get('new-spend');
    retainRecords(first.run, `continuation/${name}`, { state, item, calls: adapter.calls });
    expect(item).toMatchObject({ state: 'pending' });
    expect(state.status).toBe('parked');
    expect(state.authorizations).toEqual(declaration && name === 'empty' ? {} : undefined);
    expect(readRunState(state.projectDir, state.runId).authorizations).toEqual(state.authorizations);
    expect(item?.resolution).toBeUndefined();
    expect(existsSync(join(first.run, 'approvals/new-spend.decision.json'))).toBe(false);
    expect(readFileSync(join(first.run, 'approvals/effect.decision.json'), 'utf8')).toBe(originalDecision);
    expect(foldItems(state.runId).get('effect')).toMatchObject({ state: 'denied', resolution: { source: 'operator' } });
    expect(adapter.calls[0].prompt).toContain('Current brief authorizations: {}.');
  });

  it('renders the known normalized title after actual active-worker approval suspension', async () => {
    const projectDir = project();
    const taskBrief = brief();
    const { config, raw } = authorityWorkflow(projectDir, taskBrief);
    let aborted = false;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId !== 'work') return { output: scriptedRecord('Parked.', opts), exitCode: 0, duration_ms: 1 };
      writeFileSync(join(opts.runDir, 'stages/work/approval_request.json'), JSON.stringify({
        id: 'untitled', risk: 'external', action: 'download_checkpoint', target: 'one.example',
      }));
      await new Promise<void>(done => {
        const timer = setTimeout(done, 6000);
        const onAbort = () => { aborted = true; clearTimeout(timer); done(); };
        if (opts.abortSignal?.aborted) onAbort();
        else opts.abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
      return { output: scriptedRecord('Await approval.', opts), exitCode: 0, duration_ms: 1,
        writes: ['run:stages/work/approval_request.json'], writeAttribution: 'structured' };
    } };
    const state = await runWorkflow(config, raw, projectDir, adapter, new Map(), undefined,
      resolve('config/agents'), undefined, taskBrief, true, undefined, false);
    expect(aborted).toBe(true);
    expect(state.status).toBe('parked');
    const { fcGlobalDir, runDir } = await import('../src/store.js');
    const registry = new TaskRegistry({ baseDir: fcGlobalDir() });
    const task = registry.create({ name: 'Active worker task', projectDir, run_id: state.runId, status: 'parked',
      launcher: { frontend: 'claude', sessionId: 'suspension', cwd: projectDir, ledgerRoot: join(projectDir, 'ledger') } });
    const push = new SessionPush(registry);
    push.capture(task);
    const event = push.pending('suspension').find(event => event.kind === 'approval_attempt_suspended')!;
    expect(event).toBeDefined();
    const item = foldItems(state.runId).get('untitled')!;
    const rendered = renderPushEvent(event, registry.baseDir);
    retainRecords(runDir(projectDir, state.runId), 'suspension', { state, item, event, rendered });
    expect(event.occurredAt).not.toBe(state.parked?.pausedAt);
    expect(item.title).toBe('download_checkpoint → one.example');
    expect(event.requestTitle).toBe(item.title);
    expect(rendered.human).toContain('Active worker task: attempt suspended for approval. Request: download_checkpoint → one.example. Target: one.example.');
    expect(rendered.human).toContain("flowcrew inbox approve 'untitled'");
    expect(rendered.human).not.toContain(event.eventId);
    expect(rendered.agent).toContain(`flowcrew session-push ack --event ${event.eventId}`);
  });
});

describe('six historical request effects, with categories explicitly authored in fixtures', () => {
  const census: Array<Record<string, unknown>> = JSON.parse(readFileSync(new URL('./fixtures/approval-census.json', import.meta.url), 'utf8'));
  it.each([
    [{ provider_calls: true }, ['pending', 'pending', 'approved', 'approved', 'pending', 'approved']],
    [{ provider_calls: true, spend: { usd: 50 } }, ['pending', 'pending', 'approved', 'approved', 'approved', 'approved']],
  ])('replays against %j without a prose classifier', async (declaration, expected) => {
    expect(census).toHaveLength(6);
    const actual: string[] = [];
    for (const fixture of census) {
      const f = await inspect(fixture, declaration);
      const item = foldItems(f.runId).get(fixture.id as string)!;
      actual.push(item.state);
      expect(Boolean(f.parked)).toBe(item.state === 'pending');
    }
    expect(actual).toEqual(expected);
  });
  it('does not convert the original teacher credential component into spend authority', async () => {
    const f = await inspect({ category: 'credentials', title: census[4].title, target: 'Trusted environment credential injection' }, { provider_calls: true, spend: { usd: 50 } });
    expect(f.item.state).toBe('pending');
    expect(f.parked?.status).toBe('parked');
  });
});
