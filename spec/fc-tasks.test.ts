import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FC_TASK_FIELDS,
  FC_TASK_STATUSES,
  FcTasksRefusal,
  RENDER_DEGRADATION_CODES,
  createEngineTaskRunResolver,
  createTaskEntry,
  readTaskLedger,
  renderFcTasks,
  resolveFcTaskRuns,
  updateTaskEntry,
  type FcTaskEntry,
  type RenderFcTasksResult,
} from '../src/fc-tasks.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-tasks-spec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function task(
  id: string,
  status: FcTaskEntry['status'] = 'pending',
  overrides: Partial<FcTaskEntry> = {},
): FcTaskEntry {
  return {
    id,
    subject: `subject ${id}`,
    description: `description ${id}`,
    activeForm: `working ${id}`,
    status,
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

function canonicalLaunchSentence(taskId: number | string): string {
  return `FlowCrew task ${taskId} is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.`;
}

function writeEntry(session: string, filename: string, value: unknown): string {
  const directory = join(root, session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, 'utf-8');
  return path;
}

function writeEngineTask(engineRoot: string, value: unknown): void {
  mkdirSync(engineRoot, { recursive: true });
  appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeEngineRun(engineRoot: string, runId: string, value: unknown): void {
  const directory = join(engineRoot, 'runs', runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify(value)}\n`, 'utf-8');
}

function render(session: string, overrides = {}): RenderFcTasksResult {
  return renderFcTasks({
    storeRoot: root,
    explicitSession: session,
    columns: 100,
    lines: 20,
    ...overrides,
  });
}

describe('fc_tasks legacy ledger rendering', () => {
  it('re-derives the seven legacy fields and three statuses', () => {
    expect(FC_TASK_FIELDS).toEqual([
      'id',
      'subject',
      'description',
      'activeForm',
      'status',
      'blocks',
      'blockedBy',
    ]);
    expect(FC_TASK_STATUSES).toEqual(['pending', 'in_progress', 'completed']);
  });

  it('renders old hand-written entries directly and sorts every open row by id', () => {
    writeEntry('legacy-session', 'later.json', task('b', 'in_progress', {
      subject: '第二项',
      activeForm: '正在处理第二项',
    }));
    writeEntry('legacy-session', 'earlier.json', task('a', 'pending', { subject: '第一项' }));
    writeEntry('legacy-session', 'done.json', task('c', 'completed'));

    const result = render('legacy-session');
    const rows = result.text.trimEnd().split('\n');

    expect(result.state).toBe('active');
    expect(rows[0]).toBe('fc_tasks: 1 running · 1 pending · 1 done');
    expect(rows[1]).toContain('[a] 第一项');
    expect(rows[2]).toContain('[b] 正在处理第二项');
  });

  it('distinguishes an existing idle ledger from a missing ledger', () => {
    mkdirSync(join(root, 'empty-session'));
    writeEntry('completed-session', 'done.json', task('done', 'completed'));

    expect(render('empty-session')).toMatchObject({ state: 'idle', issueCodes: [] });
    expect(render('empty-session').text).toBe('fc_tasks: idle · 0 done\n');
    expect(render('completed-session').text).toBe('fc_tasks: idle · 1 done\n');
    expect(render('missing-session')).toMatchObject({ state: 'no_ledger', issueCodes: [] });
    expect(render('missing-session').text).toContain('fc_tasks: no ledger');
  });

  it('clips every row by terminal columns at 40, 60, and 100 with CJK double width', () => {
    expect(stringWidth('中文')).toBe(4);
    writeEntry('wide-session', 'wide.json', task('wide', 'in_progress', {
      activeForm: '正在处理'.repeat(30),
    }));

    for (const columns of [40, 60, 100]) {
      const result = render('wide-session', { columns });
      const rows = result.text.trimEnd().split('\n');
      expect(rows).toHaveLength(2);
      expect(rows[1].endsWith('…')).toBe(true);
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it('bounds row count against LINES and emits a deterministic overflow row', () => {
    for (const id of ['e', 'c', 'a', 'd', 'b']) writeEntry('crowded-session', `${id}.json`, task(id));

    const rows = render('crowded-session', { lines: 4 }).text.trimEnd().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('[a]');
    expect(rows[2]).toContain('[b]');
    expect(rows[3]).toBe('… +3 rows not shown');

    const oneRow = render('crowded-session', { columns: 40, lines: 1 }).text.trimEnd().split('\n');
    expect(oneRow).toHaveLength(1);
    expect(oneRow[0]).toContain('+5 rows hidden');
    expect(stringWidth(oneRow[0])).toBeLessThanOrEqual(40);
  });

  it('neutralizes control characters instead of letting an entry create unbudgeted rows', () => {
    writeEntry('control-session', 'control.json', task('control', 'pending', {
      subject: 'first line\nsecond line\u001b[31m',
    }));

    const rows = render('control-session').text.trimEnd().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('first line second line [31m');
  });

  it('keeps valid counts visible when another entry is corrupt', () => {
    writeEntry('mixed-session', 'good.json', task('good', 'in_progress'));
    writeEntry('mixed-session', 'bad.json', '{not json');

    const result = render('mixed-session');
    expect(result.state).toBe('degraded');
    expect(result.issueCodes).toEqual(['entry_not_json']);
    expect(result.text).toContain('1 running');
    expect(result.text).toContain('⚠ entry_not_json: bad.json: invalid JSON');
    expect(result.text).toContain('[good]');

    const constrained = render('mixed-session', { columns: 40, lines: 1 });
    expect(constrained.text).toMatch(/^fc_tasks: degraded\[entry_not_json\]/u);
    expect(constrained.text).toContain('+2rows');
    expect(stringWidth(constrained.text.trimEnd())).toBeLessThanOrEqual(40);
  });

  it('keeps a type-damaged ledger legible and names the invalid entry and field', () => {
    writeEntry('damaged-session', 'damaged.json', {
      ...task('damaged', 'in_progress'),
      activeForm: null,
    });

    const result = render('damaged-session');

    expect(result.state).toBe('degraded');
    expect(result.issueCodes).toEqual(['entry_invalid']);
    expect(result.text).toContain('degraded[entry_invalid]');
    expect(result.text).toContain('damaged.json: activeForm must be a string');
    expect(result.text.trim()).not.toBe('');
  });

  it('resolves a linked entry through the latest engine task mapping without guessing from prose', () => {
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'target-reused-at-the-same-path');
    const digest = 'a'.repeat(64);
    writeEngineTask(engineRoot, {
      id: 42,
      status: 'running',
      projectDir,
      run_id: 'old-run',
      brief_admission: { digest },
    });
    writeEngineTask(engineRoot, {
      id: 7,
      status: 'done',
      projectDir,
      run_id: 'unrelated-run',
      brief_admission: { digest: 'b'.repeat(64) },
    });
    writeEngineTask(engineRoot, {
      id: 42,
      status: 'running',
      projectDir,
      run_id: 'current-run',
      brief_admission: { digest },
    });
    writeEngineRun(engineRoot, 'current-run', {
      runId: 'current-run',
      status: 'running',
      projectDir,
      briefAdmission: { digest },
    });
    writeEntry('linked-session', 'linked.json', {
      ...task('linked', 'in_progress', { description: 'contains no run id or target path' }),
      flowcrewTaskId: 42,
    });

    const result = render('linked-session', {
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });

    expect(result.state).toBe('active');
    expect(result.text).toContain('run:running [linked]');
    expect(result.text).not.toContain('old-run');
    expect(result.text).not.toContain('stale');
  });

  it('renders never-linked entries normally and marks stale mappings without degrading the ledger', () => {
    const engineRoot = join(root, 'engine');
    mkdirSync(engineRoot);
    writeEntry('link-states', 'legacy.json', task('a-legacy', 'pending'));
    writeEntry('link-states', 'stale.json', {
      ...task('b-stale', 'pending'),
      flowcrewTaskId: 999,
    });
    writeEntry('link-states', 'completed-stale.json', {
      ...task('c-completed-stale', 'completed'),
      flowcrewTaskId: 998,
    });

    const result = render('link-states', {
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });
    const rows = result.text.trimEnd().split('\n');

    expect(result).toMatchObject({ state: 'active', issueCodes: [] });
    expect(rows[0]).toContain('2 stale');
    expect(rows[1]).toBe('○ [a-legacy] subject a-legacy');
    expect(rows[2]).toContain('stale:#999 [b-stale]');

    const constrained = render('link-states', {
      columns: 40,
      lines: 1,
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });
    expect(constrained.text).toContain('2 stale');
    expect(constrained.text).toContain('+2 rows hidden');
    expect(stringWidth(constrained.text.trimEnd())).toBeLessThanOrEqual(40);
  });

  it('resolves a finished archived run directly and treats a missing known run as stale', () => {
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'target');
    writeEngineTask(engineRoot, {
      id: 10,
      status: 'done',
      projectDir,
      run_id: 'archived-run',
    });
    writeEngineTask(engineRoot, {
      id: 11,
      status: 'running',
      projectDir,
      run_id: 'missing-run',
    });
    writeEngineRun(engineRoot, 'archived-run', {
      runId: 'archived-run',
      status: 'complete',
      projectDir,
    });
    const resolver = createEngineTaskRunResolver({ engineRoot });

    expect(resolver.resolve({ ...task('finished', 'completed'), flowcrewTaskId: 10 }))
      .toMatchObject({ state: 'resolved', taskId: 10, runId: 'archived-run', runStatus: 'complete' });
    expect(resolver.resolve({ ...task('missing', 'in_progress'), flowcrewTaskId: 11 }))
      .toMatchObject({ state: 'stale', taskId: 11 });
    expect(resolver.resolve(task('legacy'))).toEqual({ state: 'never_linked' });
  });

  it('recovers a canonical legacy link and marks both terminal runs as wrap-up overdue', () => {
    const engineRoot = join(root, 'engine');
    const inferredProject = join(root, 'inferred-target');
    const explicitProject = join(root, 'explicit-target');
    writeEngineTask(engineRoot, {
      id: 12,
      status: 'stuck',
      projectDir: inferredProject,
      run_id: 'terminal-complete',
    });
    writeEngineTask(engineRoot, {
      id: 13,
      status: 'failed',
      projectDir: explicitProject,
      run_id: 'terminal-escalated',
    });
    writeEngineRun(engineRoot, 'terminal-complete', {
      runId: 'terminal-complete',
      status: 'complete',
      projectDir: inferredProject,
    });
    writeEngineRun(engineRoot, 'terminal-escalated', {
      runId: 'terminal-escalated',
      status: 'escalated',
      projectDir: explicitProject,
    });
    const inferredEntry = task('inferred', 'in_progress', {
      subject: 'Canonical legacy wrap-up',
      description: canonicalLaunchSentence(12),
      activeForm: 'Waiting on inferred FlowCrew task',
    });
    const explicitEntry = task('explicit', 'in_progress', {
      subject: 'Explicit-link wrap-up',
      description: canonicalLaunchSentence(13),
      activeForm: 'Waiting on explicitly linked FlowCrew task',
      flowcrewTaskId: 13,
    });
    const inferredPath = writeEntry('terminal-links', 'inferred.json', inferredEntry);
    writeEntry('terminal-links', 'explicit.json', explicitEntry);
    const inferredBytes = readFileSync(inferredPath);

    const resolutions = resolveFcTaskRuns(
      [inferredEntry, explicitEntry],
      createEngineTaskRunResolver({ engineRoot }),
    );
    expect(resolutions).toMatchObject([
      { state: 'resolved', taskId: 12, runStatus: 'complete' },
      { state: 'resolved', taskId: 13, runStatus: 'escalated' },
    ]);

    const result = render('terminal-links', {
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });
    const rows = result.text.trimEnd().split('\n');

    expect(rows[0]).toBe('fc_tasks: 2 wrap-up overdue · 2 running · 0 pending · 0 done');
    expect(rows[1]).toContain('wrap-up-overdue:run:escalated:#13 [explicit]');
    expect(rows[2]).toContain('wrap-up-overdue:run:complete:#12 [inferred]');
    expect(result.text).not.toContain('stale:#');
    expect(readFileSync(inferredPath)).toEqual(inferredBytes);
    expect(JSON.parse(inferredBytes.toString('utf-8'))).not.toHaveProperty('flowcrewTaskId');
  });

  it('infers only one exact canonical launch sentence and keeps an explicit link authoritative', () => {
    const engineRoot = join(root, 'engine');
    for (const id of [42, 77]) {
      writeEngineTask(engineRoot, {
        id,
        status: 'running',
        projectDir: join(root, `target-${id}`),
      });
    }
    const entries = [
      task('exact', 'in_progress', {
        description: `context\n${canonicalLaunchSentence(42)}\nmore context`,
      }),
      task('subject-only', 'in_progress', {
        subject: canonicalLaunchSentence(42),
        description: 'No task link in the description.',
      }),
      task('bare', 'in_progress', { description: 'Waiting for FlowCrew #42.' }),
      task('embedded', 'in_progress', {
        description: `prefix ${canonicalLaunchSentence(42)}`,
      }),
      task('unsafe', 'in_progress', {
        description: canonicalLaunchSentence('9007199254740992'),
      }),
      task('ambiguous', 'in_progress', {
        description: `${canonicalLaunchSentence(42)}\n${canonicalLaunchSentence(77)}`,
      }),
      task('unlinked', 'in_progress'),
      task('explicit', 'in_progress', {
        description: canonicalLaunchSentence(42),
        flowcrewTaskId: 77,
      }),
    ];

    const resolutions = resolveFcTaskRuns(
      entries,
      createEngineTaskRunResolver({ engineRoot }),
    );

    expect(resolutions.map(({ state }) => state)).toEqual([
      'resolved',
      'never_linked',
      'never_linked',
      'never_linked',
      'never_linked',
      'never_linked',
      'never_linked',
      'resolved',
    ]);
    expect(resolutions[0]).toMatchObject({ state: 'resolved', taskId: 42 });
    expect(resolutions[7]).toMatchObject({ state: 'resolved', taskId: 77 });
  });

  it('keeps a running link, an unlinked entry, and a completed terminal link free of overdue noise', () => {
    const engineRoot = join(root, 'engine');
    const liveProject = join(root, 'live-target');
    const doneProject = join(root, 'done-target');
    writeEngineTask(engineRoot, {
      id: 60,
      status: 'running',
      projectDir: liveProject,
      run_id: 'live-run',
    });
    writeEngineRun(engineRoot, 'live-run', {
      runId: 'live-run',
      status: 'running',
      projectDir: liveProject,
    });
    writeEngineTask(engineRoot, {
      id: 61,
      status: 'done',
      projectDir: doneProject,
      run_id: 'done-run',
    });
    writeEngineRun(engineRoot, 'done-run', {
      runId: 'done-run',
      status: 'complete',
      projectDir: doneProject,
    });
    writeEntry('quiet-links', 'live.json', {
      ...task('live', 'in_progress'),
      flowcrewTaskId: 60,
    });
    writeEntry('quiet-links', 'unlinked.json', task('unlinked', 'pending'));
    writeEntry('quiet-links', 'completed.json', {
      ...task('completed', 'completed'),
      flowcrewTaskId: 61,
    });

    const result = render('quiet-links', {
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });

    expect(result.text).toContain('run:running [live]');
    expect(result.text).toContain('○ [unlinked] subject unlinked');
    expect(result.text).not.toContain('wrap-up-overdue');
    expect(result.text).not.toContain('stale');
  });

  it('uses a known terminal task status only when no run status is materialized', () => {
    const engineRoot = join(root, 'engine');
    const runningProject = join(root, 'running-target');
    writeEngineTask(engineRoot, {
      id: 70,
      status: 'done',
      projectDir: join(root, 'done-without-run'),
    });
    writeEngineTask(engineRoot, {
      id: 71,
      status: 'future-status',
      projectDir: join(root, 'unknown-without-run'),
    });
    writeEngineTask(engineRoot, {
      id: 72,
      status: 'failed',
      projectDir: runningProject,
      run_id: 'still-running',
    });
    writeEngineRun(engineRoot, 'still-running', {
      runId: 'still-running',
      status: 'running',
      projectDir: runningProject,
    });
    for (const id of [70, 71, 72]) {
      writeEntry('lifecycle-source', `${id}.json`, {
        ...task(String(id), 'in_progress'),
        flowcrewTaskId: id,
      });
    }

    const result = render('lifecycle-source', {
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });

    expect(result.text).toContain('1 wrap-up overdue');
    expect(result.text).toContain('wrap-up-overdue:task:done:#70 [70]');
    expect(result.text).toContain('task:future-status [71]');
    expect(result.text).toContain('run:running [72]');
  });
});

describe('fc_tasks session adapters and degradation totality', () => {
  it('uses explicit session, then the configured payload key, then the observed environment selector', () => {
    for (const session of ['explicit-session', 'payload-session', 'environment-session']) {
      mkdirSync(join(root, session));
    }

    const explicit = renderFcTasks({
      storeRoot: root,
      explicitSession: 'explicit-session',
      payload: { provided: true, text: 'not json' },
      environmentSession: 'environment-session',
    });
    expect(explicit.session).toBe('explicit-session');

    const payload = renderFcTasks({
      storeRoot: root,
      payload: { provided: true, text: JSON.stringify({ 'thread-id': 'payload-session' }) },
      sessionKey: 'thread-id',
      environmentSession: 'environment-session',
    });
    expect(payload.session).toBe('payload-session');

    const environment = renderFcTasks({ storeRoot: root, environmentSession: 'environment-session' });
    expect(environment.session).toBe('environment-session');
  });

  it('does not fall through to an unrelated environment session after malformed or keyless payload', () => {
    mkdirSync(join(root, 'environment-session'));
    const malformed = renderFcTasks({
      storeRoot: root,
      payload: { provided: true, text: 'not json' },
      environmentSession: 'environment-session',
    });
    const keyless = renderFcTasks({
      storeRoot: root,
      payload: { provided: true, text: '{}' },
      environmentSession: 'environment-session',
    });

    expect(malformed).toMatchObject({ state: 'degraded', issueCodes: ['payload_not_json'] });
    expect(keyless).toMatchObject({ state: 'degraded', issueCodes: ['session_key_absent'] });
    expect(malformed.session).toBeUndefined();
    expect(keyless.session).toBeUndefined();
  });

  it('enumerates and emits a non-blank line for every degradation path', () => {
    writeFileSync(join(root, 'not-a-directory'), 'x', 'utf-8');
    writeEntry('too-many', 'one.json', task('one'));
    writeEntry('too-many', 'two.json', task('two'));
    writeEntry('bad-json', 'bad.json', '{bad');
    writeEntry('bad-entry', 'bad.json', { ...task('bad'), status: 'unknown' });
    writeEntry('duplicate', 'one.json', task('same'));
    writeEntry('duplicate', 'two.json', task('same'));
    writeEntry('bad-graph', 'bad.json', task('bad', 'pending', { blockedBy: ['missing'] }));
    writeEntry('resolver-failure', 'linked.json', {
      ...task('linked'),
      flowcrewTaskId: 1,
    });
    const corruptEngineRoot = join(root, 'corrupt-engine');
    mkdirSync(corruptEngineRoot);
    writeFileSync(join(corruptEngineRoot, 'tasks.jsonl'), '{bad\n', 'utf-8');

    const results = [
      renderFcTasks({ storeRoot: root, explicitSession: 'missing', columns: 0 }),
      renderFcTasks({ storeRoot: root, payload: { provided: true, text: '{bad' } }),
      renderFcTasks({
        storeRoot: root,
        payload: { provided: true, text: `{"session_id":"${'x'.repeat(1024 * 1024)}"}` },
      }),
      renderFcTasks({ storeRoot: root, payload: { provided: true, text: '[]' } }),
      renderFcTasks({ storeRoot: root }),
      renderFcTasks({ storeRoot: root, payload: { provided: true, text: '{}' } }),
      renderFcTasks({ storeRoot: root, explicitSession: '../unsafe' }),
      render('not-a-directory'),
      render('too-many', { maxEntries: 1 }),
      render('bad-json'),
      render('bad-entry'),
      render('duplicate'),
      render('bad-graph'),
      render('resolver-failure', {
        taskRunResolver: createEngineTaskRunResolver({ engineRoot: corruptEngineRoot }),
      }),
      renderFcTasks({
        storeRoot: root,
        explicitSession: 'internal',
        readLedger: () => { throw new Error('injected renderer failure'); },
      }),
    ];

    expect(results.flatMap(({ issueCodes }) => issueCodes)).toEqual(RENDER_DEGRADATION_CODES);
    for (const result of results) {
      expect(result.state).toBe('degraded');
      expect(result.text).toContain('degraded[');
      expect(result.text.endsWith('\n')).toBe(true);
      expect(result.text.trim()).not.toBe('');
    }
  });
});

describe('fc_tasks validating atomic writes', () => {
  it('creates a valid entry and then lists the same legacy shape', () => {
    const created = task('created');
    createTaskEntry({ storeRoot: root, session: 'write-session', entry: created });

    const ledger = readTaskLedger(root, 'write-session');
    expect(ledger.state).toBe('ready');
    if (ledger.state !== 'ready') throw new Error('expected ready ledger');
    expect(ledger.entries[0]).toMatchObject(created);
    expect(JSON.parse(readFileSync(join(root, 'write-session', 'created.json'), 'utf-8'))).toEqual(created);
  });

  it('populates and verifies an optional stable engine task link before publication', () => {
    const engineRoot = join(root, 'engine');
    writeEngineTask(engineRoot, {
      id: 73,
      status: 'pending',
      projectDir: join(root, 'target'),
    });
    const resolver = createEngineTaskRunResolver({ engineRoot });

    createTaskEntry({
      storeRoot: root,
      session: 'linked-write',
      entry: task('linked'),
      flowcrewTaskId: 73,
      taskRunResolver: resolver,
    });

    expect(JSON.parse(readFileSync(join(root, 'linked-write', 'linked.json'), 'utf-8')))
      .toEqual({ ...task('linked'), flowcrewTaskId: 73 });

    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'stale-write',
      entry: task('stale'),
      flowcrewTaskId: 999,
      taskRunResolver: resolver,
    })).toThrow(/stale FlowCrew task link/u);
    expect(readdirSync(root)).not.toContain('stale-write');
  });

  it('refuses an unverified link and preserves or explicitly clears a verified link on update', () => {
    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'unverified-write',
      entry: { ...task('linked'), flowcrewTaskId: 5 },
    })).toThrow(/cannot verify FlowCrew task link/u);
    expect(readdirSync(root)).not.toContain('unverified-write');

    const engineRoot = join(root, 'engine');
    writeEngineTask(engineRoot, {
      id: 5,
      status: 'pending',
      projectDir: join(root, 'target'),
    });
    const resolver = createEngineTaskRunResolver({ engineRoot });
    const path = writeEntry('linked-update', 'hand-written.json', {
      ...task('linked', 'in_progress'),
      flowcrewTaskId: 5,
    });

    updateTaskEntry({
      storeRoot: root,
      session: 'linked-update',
      id: 'linked',
      entry: { status: 'completed' },
      taskRunResolver: resolver,
    });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      id: 'linked',
      status: 'completed',
      flowcrewTaskId: 5,
    });

    updateTaskEntry({
      storeRoot: root,
      session: 'linked-update',
      id: 'linked',
      entry: {},
      clearFlowcrewTaskLink: true,
    });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('flowcrewTaskId');
  });

  it.each([
    ['unknown status', { ...task('bad'), status: 'unknown' }],
    ['missing field', { id: 'bad' }],
    ['unexpected field', { ...task('bad'), typo: true }],
    ['duplicate relationship', { ...task('bad'), blocks: ['target', 'target'] }],
    ['unsafe id', task('../bad')],
  ])('refuses %s before creating a session or entry', (_label, entry) => {
    expect(() => createTaskEntry({ storeRoot: root, session: 'invalid-session', entry }))
      .toThrow(FcTasksRefusal);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a duplicate id even when it is hidden under another filename', () => {
    const originalPath = writeEntry('duplicate-write', 'hand-written.json', task('same'));
    const original = readFileSync(originalPath);

    expect(() => createTaskEntry({ storeRoot: root, session: 'duplicate-write', entry: task('same') }))
      .toThrow(/duplicate id same/u);
    expect(readFileSync(originalPath)).toEqual(original);
    expect(readdirSync(join(root, 'duplicate-write'))).toEqual(['hand-written.json']);
  });

  it('refuses missing blockedBy and blocks targets without leaving a file', () => {
    for (const [session, entry] of [
      ['missing-blocker', task('candidate', 'pending', { blockedBy: ['absent'] })],
      ['missing-blocked', task('candidate', 'pending', { blocks: ['absent'] })],
    ] as const) {
      expect(() => createTaskEntry({ storeRoot: root, session, entry })).toThrow(/names missing entry absent/u);
      expect(readdirSync(join(root, session))).toEqual([]);
    }
  });

  it('updates exactly one existing entry in place and can close a running task', () => {
    const path = writeEntry('update-session', 'hand-written.json', task('work', 'in_progress'));
    const completed = task('work', 'completed');

    const updatedPath = updateTaskEntry({
      storeRoot: root,
      session: 'update-session',
      id: 'work',
      entry: completed,
    });

    expect(updatedPath).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(completed);
    expect(readdirSync(join(root, 'update-session'))).toEqual(['hand-written.json']);
    expect(render('update-session').text).toBe('fc_tasks: idle · 1 done\n');
  });

  it('replaces one supplied field while preserving every omitted field value byte-for-byte', () => {
    writeEntry('partial-update', 'target.json', task('target', 'completed'));
    const path = writeEntry('partial-update', 'hand-written.json', {
      ...task('work', 'in_progress', { blocks: ['target'] }),
      futureField: { nested: ['preserve', 17, null] },
    });
    const before = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const omittedFieldBytes = Object.fromEntries(
      Object.entries(before)
        .filter(([field]) => field !== 'status')
        .map(([field, value]) => [field, Buffer.from(JSON.stringify(value))]),
    );

    updateTaskEntry({
      storeRoot: root,
      session: 'partial-update',
      id: 'work',
      entry: { status: 'completed' },
    });

    const after = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(after.status).toBe('completed');
    for (const [field, bytes] of Object.entries(omittedFieldBytes)) {
      expect(Object.hasOwn(after, field), `partial update dropped ${field}`).toBe(true);
      expect(Buffer.from(JSON.stringify(after[field])), `partial update changed ${field}`)
        .toEqual(bytes);
    }
    expect(Object.keys(after)).toEqual(Object.keys(before));

    updateTaskEntry({
      storeRoot: root,
      session: 'partial-update',
      id: 'work',
      entry: { blocks: [] },
    });
    expect((JSON.parse(readFileSync(path, 'utf-8')) as FcTaskEntry).blocks).toEqual([]);
  });

  it('repairs its targeted invalid field only when the virtual ledger becomes fully valid', () => {
    const path = writeEntry('repair-session', 'hand-written.json', {
      ...task('repair-target', 'in_progress'),
      activeForm: null,
      futureField: { nested: ['preserved', 17, null] },
    });
    const damaged = readTaskLedger(root, 'repair-session');
    expect(damaged.state).toBe('ready');
    expect(damaged.issues).toEqual([{
      code: 'entry_invalid',
      detail: 'hand-written.json: activeForm must be a string',
    }]);

    const updatedPath = updateTaskEntry({
      storeRoot: root,
      session: 'repair-session',
      id: 'repair-target',
      entry: { activeForm: 'Repairing the ledger' },
    });

    expect(updatedPath).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      id: 'repair-target',
      activeForm: 'Repairing the ledger',
      futureField: { nested: ['preserved', 17, null] },
    });
    expect(readTaskLedger(root, 'repair-session')).toMatchObject({ state: 'ready', issues: [] });
  });

  it('refuses to update a healthy peer while a malformed entry would remain', () => {
    const damagedPath = writeEntry('peer-laundering', 'damaged.json', {
      ...task('damaged', 'in_progress'),
      activeForm: null,
    });
    const peerPath = writeEntry('peer-laundering', 'peer.json', task('peer', 'in_progress'));
    const damagedBefore = readFileSync(damagedPath);
    const peerBefore = readFileSync(peerPath);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'peer-laundering',
      id: 'peer',
      entry: { status: 'completed' },
    })).toThrow(/proposed update leaves ledger invalid: entry_invalid: damaged\.json: activeForm must be a string/u);

    expect(readFileSync(damagedPath)).toEqual(damagedBefore);
    expect(readFileSync(peerPath)).toEqual(peerBefore);
    expect(readdirSync(join(root, 'peer-laundering')).sort()).toEqual(['damaged.json', 'peer.json']);
  });

  it('refuses to claim a repair while the targeted malformed field remains', () => {
    const path = writeEntry('incomplete-repair', 'damaged.json', {
      ...task('damaged', 'in_progress'),
      activeForm: null,
    });
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'incomplete-repair',
      id: 'damaged',
      entry: { status: 'completed' },
    })).toThrow(/activeForm must be a string/u);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, 'incomplete-repair'))).toEqual(['damaged.json']);
  });

  it('still refuses a post-update blockedBy edge that names a missing entry', () => {
    const path = writeEntry('graph-refusal', 'work.json', task('work', 'in_progress'));
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'graph-refusal',
      id: 'work',
      entry: { blockedBy: ['missing'] },
    })).toThrow(/proposed update leaves ledger invalid: graph_invalid: work\.blockedBy names missing entry missing/u);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, 'graph-refusal'))).toEqual(['work.json']);
  });

  it('repairs a pre-existing graph fault only when its targeted edge is removed', () => {
    const path = writeEntry('graph-repair', 'work.json', task('work', 'in_progress', {
      blockedBy: ['missing'],
    }));
    expect(readTaskLedger(root, 'graph-repair').issues).toEqual([{
      code: 'graph_invalid',
      detail: 'work.blockedBy names missing entry missing',
    }]);

    updateTaskEntry({
      storeRoot: root,
      session: 'graph-repair',
      id: 'work',
      entry: { blockedBy: [] },
    });

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ blockedBy: [] });
    expect(readTaskLedger(root, 'graph-repair')).toMatchObject({ state: 'ready', issues: [] });
  });

  it('still refuses an update when multiple JSON entries claim the target id', () => {
    const firstPath = writeEntry('duplicate-update', 'one.json', task('repeated', 'in_progress'));
    const secondPath = writeEntry('duplicate-update', 'two.json', task('repeated', 'pending'));
    const firstBefore = readFileSync(firstPath);
    const secondBefore = readFileSync(secondPath);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'duplicate-update',
      id: 'repeated',
      entry: { activeForm: 'Cannot choose a source file' },
    })).toThrow(/existing ledger is invalid: duplicate_id: id repeated appears in one\.json and two\.json/u);

    expect(readFileSync(firstPath)).toEqual(firstBefore);
    expect(readFileSync(secondPath)).toEqual(secondBefore);
    expect(readdirSync(join(root, 'duplicate-update')).sort()).toEqual(['one.json', 'two.json']);
  });

  it.each([
    ['unknown field', { typo: true }, /entry has unexpected field typo/u],
    ['illegal status', { status: 'invented' }, /status must be one of pending, in_progress, completed/u],
    ['dangling blockedBy', { blockedBy: ['missing'] }, /work\.blockedBy names missing entry missing/u],
    ['explicit null', { description: null }, /description must be a string/u],
  ] as const)('refuses a partial update with %s without changing stored bytes', (_label, patch, refusal) => {
    const path = writeEntry('partial-refusal', 'existing.json', task('work', 'in_progress'));
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'partial-refusal',
      id: 'work',
      entry: patch,
    })).toThrow(refusal);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, 'partial-refusal'))).toEqual(['existing.json']);
  });

  it('keeps the positional id authoritative when a partial patch supplies an id', () => {
    const path = writeEntry('partial-id', 'existing.json', task('work', 'in_progress'));
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'partial-id',
      id: 'work',
      entry: { id: 'different' },
    })).toThrow(/entry id different does not match update id work/u);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, 'partial-id'))).toEqual(['existing.json']);
  });

  it('removes the temporary file and publishes nothing when atomic create fails after the flush', () => {
    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'failed-create',
      entry: task('candidate'),
      publication: { create: () => { throw new Error('injected publication failure'); } },
    })).toThrow(/atomic create refused/u);

    expect(readdirSync(join(root, 'failed-create'))).toEqual([]);
  });

  it('removes the temporary file and preserves the prior entry when atomic update fails', () => {
    const path = writeEntry('failed-update', 'existing.json', task('candidate', 'in_progress'));
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: root,
      session: 'failed-update',
      id: 'candidate',
      entry: { status: 'completed' },
      publication: { update: () => { throw new Error('injected publication failure'); } },
    })).toThrow(/atomic update refused/u);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, 'failed-update'))).toEqual(['existing.json']);
  });

  it('refuses to write through a malformed existing ledger', () => {
    writeEntry('malformed-existing', 'bad.json', '{bad');

    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'malformed-existing',
      entry: task('new'),
    })).toThrow(/existing ledger is invalid: entry_not_json/u);
    expect(readdirSync(join(root, 'malformed-existing'))).toEqual(['bad.json']);
  });
});
