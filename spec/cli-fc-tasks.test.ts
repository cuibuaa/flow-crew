import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import type { FcTaskEntry } from '../src/fc-tasks.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-tasks-cli-spec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function task(id: string, status: FcTaskEntry['status'] = 'pending'): FcTaskEntry {
  return {
    id,
    subject: `主题 ${id}`,
    description: `full description ${id}`,
    activeForm: `正在处理 ${id}`,
    status,
    blocks: [],
    blockedBy: [],
  };
}

function canonicalLaunchSentence(taskId: number): string {
  return `FlowCrew task ${taskId} is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.`;
}

function seed(session: string, entry: FcTaskEntry): void {
  seedValue(session, `${entry.id}.json`, entry);
}

function seedValue(session: string, filename: string, value: unknown): string {
  const directory = join(root, session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
  return path;
}

function seedEngineTask(engineRoot: string, value: unknown): void {
  mkdirSync(engineRoot, { recursive: true });
  appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify(value)}\n`, 'utf-8');
}

function seedEngineRun(engineRoot: string, runId: string, value: unknown): void {
  const directory = join(engineRoot, 'runs', runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify(value)}\n`, 'utf-8');
}

class Capture {
  output = '';
  error = '';
  readonly stdout = { write: (chunk: string) => { this.output += chunk; } };
  readonly stderr = { write: (chunk: string) => { this.error += chunk; } };
}

function dependencies(capture: Capture, stdin = '', env: NodeJS.ProcessEnv = {}) {
  return {
    stdin,
    stdout: capture.stdout,
    stderr: capture.stderr,
    env: { FC_HOME: join(root, 'engine-sandbox'), ...env },
    cwd: root,
  };
}

describe('fc_tasks CLI front-end adapters', () => {
  it('renders Claude Code JSON from stdin and honors COLUMNS and LINES', () => {
    for (const id of ['c', 'a', 'b']) seed('claude-session', task(id));
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'render',
      '--store-root',
      root,
    ], dependencies(
      capture,
      JSON.stringify({
        session_id: 'claude-session',
        cwd: root,
        workspace: { current_dir: root },
        model: { id: 'fixture-model' },
        context_window: { used_percentage: 25 },
      }),
      { COLUMNS: '40', LINES: '3' },
    ));

    expect(code).toBe(0);
    const rows = capture.output.trimEnd().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('[a]');
    expect(rows[2]).toContain('+2 rows not shown');
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(40);
    expect(capture.error).toBe('');
  });

  it('adapts Codex notification JSON through an explicit argv payload and thread-id key', () => {
    mkdirSync(join(root, 'codex-thread'));
    const capture = new Capture();
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': 'codex-thread',
      'turn-id': 'fixture-turn',
      cwd: root,
    });

    const code = cmdFcTasks([
      'fc_tasks',
      'render',
      '--payload-arg',
      payload,
      '--session-key',
      'thread-id',
      '--store-root',
      root,
    ], dependencies(capture));

    expect(code).toBe(0);
    expect(capture.output).toBe('fc_tasks: idle · 0 done\n');
  });

  it('uses the observed Codex environment selector only when no payload was supplied', () => {
    mkdirSync(join(root, 'environment-thread'));
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'render',
      '--store-root',
      root,
    ], dependencies(capture, '', { CODEX_THREAD_ID: 'environment-thread' }));

    expect(code).toBe(0);
    expect(capture.output).toContain('fc_tasks: idle');
  });

  it('keeps renderer failures on stdout and returns zero so a status surface never blanks', () => {
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'render',
      '--store-root',
      root,
    ], dependencies(capture, 'not json', { CODEX_THREAD_ID: 'wrong-fallback' }));

    expect(code).toBe(0);
    expect(capture.output).toContain('degraded[payload_not_json]');
    expect(capture.output.trim()).not.toBe('');
    expect(capture.error).toBe('');
  });

  it('prints non-blank usage diagnostics and help without touching a store', () => {
    const invalid = new Capture();
    expect(cmdFcTasks(
      ['fc_tasks', 'render', '--unknown'],
      dependencies(invalid),
    )).toBe(2);
    expect(invalid.output).toContain('fc_tasks: usage error');

    const help = new Capture();
    expect(cmdFcTasks(['fc_tasks', '--help'], dependencies(help))).toBe(0);
    expect(help.output).toContain('flowcrew fc_tasks render');
    expect(help.output).toContain('flowcrew fc_tasks create');
  });
});

describe('fc_tasks CLI detail and write paths', () => {
  it('lists the complete validated entry as JSON for details omitted by the status rows', () => {
    const entry = task('detail', 'in_progress');
    seed('detail-session', entry);
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'list',
      '--json',
      '--session',
      'detail-session',
      '--store-root',
      root,
    ], dependencies(capture));

    expect(code).toBe(0);
    const listed = JSON.parse(capture.output) as {
      entries: FcTaskEntry[];
      runLinks: Array<{ entryId: string; state: string }>;
    };
    expect(listed.entries).toEqual([entry]);
    expect(listed.runLinks).toEqual([{ entryId: 'detail', state: 'never_linked' }]);
    expect(Object.keys(listed.entries[0]).sort()).toEqual([
      'activeForm',
      'blockedBy',
      'blocks',
      'description',
      'id',
      'status',
      'subject',
    ]);
  });

  it('creates and closes an entry through validated commands', () => {
    const capture = new Capture();
    const pending = task('work');
    const createCode = cmdFcTasks([
      'fc_tasks',
      'create',
      '--session',
      'write-session',
      '--store-root',
      root,
    ], dependencies(capture, JSON.stringify(pending)));

    expect(createCode).toBe(0);
    expect(capture.output).toContain('fc_tasks: created write-session/work');

    const completed = { ...pending, status: 'completed' as const };
    const updateCode = cmdFcTasks([
      'fc_tasks',
      'update',
      'work',
      '--session',
      'write-session',
      '--store-root',
      root,
      '--entry',
      JSON.stringify(completed),
    ], dependencies(capture));

    expect(updateCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'write-session', 'work.json'), 'utf-8')))
      .toEqual(completed);
  });

  it('repairs an activeForm null entry through a targeted partial update', () => {
    const path = seedValue('repair-session', 'hand-written.json', {
      ...task('repair-target', 'in_progress'),
      activeForm: null,
    });
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'update',
      'repair-target',
      '--session',
      'repair-session',
      '--store-root',
      root,
      '--entry',
      JSON.stringify({ activeForm: 'Repairing the ledger' }),
    ], dependencies(capture));

    expect(code).toBe(0);
    expect(capture.output).toBe('fc_tasks: updated repair-session/repair-target\n');
    expect(capture.error).toBe('');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      id: 'repair-target',
      activeForm: 'Repairing the ledger',
    });
  });

  it('refuses a peer update while the malformed entry remains and still renders its cause', () => {
    const damagedPath = seedValue('damaged-session', 'damaged.json', {
      ...task('damaged', 'in_progress'),
      activeForm: null,
    });
    seed('damaged-session', task('peer', 'in_progress'));
    const peerPath = join(root, 'damaged-session', 'peer.json');
    const damagedBefore = readFileSync(damagedPath);
    const peerBefore = readFileSync(peerPath);
    const updateCapture = new Capture();

    const updateCode = cmdFcTasks([
      'fc_tasks',
      'update',
      'peer',
      '--session',
      'damaged-session',
      '--store-root',
      root,
      '--entry',
      JSON.stringify({ status: 'completed' }),
    ], dependencies(updateCapture));

    expect(updateCode).toBe(1);
    expect(updateCapture.output).toBe('');
    expect(updateCapture.error).toContain(
      'proposed update leaves ledger invalid: entry_invalid: damaged.json: activeForm must be a string',
    );
    expect(readFileSync(damagedPath)).toEqual(damagedBefore);
    expect(readFileSync(peerPath)).toEqual(peerBefore);

    const renderCapture = new Capture();
    const renderCode = cmdFcTasks([
      'fc_tasks',
      'render',
      '--session',
      'damaged-session',
      '--store-root',
      root,
    ], dependencies(renderCapture));

    expect(renderCode).toBe(0);
    expect(renderCapture.output).toContain('degraded[entry_invalid]');
    expect(renderCapture.output).toContain('damaged.json: activeForm must be a string');
    expect(renderCapture.output.trim()).not.toBe('');
    expect(renderCapture.error).toBe('');
  });

  it('changes one field and reports each partial-update refusal on its own merits', () => {
    const session = 'partial-write-session';
    const path = join(root, session, 'work.json');
    seed(session, task('work', 'in_progress'));
    const before = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const omitted = Object.fromEntries(Object.entries(before)
      .filter(([field]) => field !== 'status')
      .map(([field, value]) => [field, JSON.stringify(value)]));
    const invoke = (entry: unknown, capture: Capture) => cmdFcTasks([
      'fc_tasks',
      'update',
      'work',
      '--session',
      session,
      '--store-root',
      root,
      '--entry',
      JSON.stringify(entry),
    ], dependencies(capture));

    const changed = new Capture();
    expect(invoke({ status: 'completed' }, changed)).toBe(0);
    expect(changed.output).toContain('fc_tasks: updated partial-write-session/work');
    const after = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(after.status).toBe('completed');
    for (const [field, bytes] of Object.entries(omitted)) {
      expect(JSON.stringify(after[field]), `partial update changed ${field}`).toBe(bytes);
    }

    for (const [entry, message] of [
      [{ typo: true }, 'entry has unexpected field typo'],
      [{ status: 'invented' }, 'status must be one of pending, in_progress, completed'],
      [{ blockedBy: ['missing'] }, 'work.blockedBy names missing entry missing'],
    ] as const) {
      const stored = readFileSync(path);
      const refusal = new Capture();
      expect(invoke(entry, refusal)).toBe(1);
      expect(refusal.error).toContain(message);
      expect(readFileSync(path)).toEqual(stored);
    }
  });

  it('populates a verified FlowCrew task link and renders its exact current run state', () => {
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'target');
    seedEngineTask(engineRoot, {
      id: 12,
      status: 'pending',
      projectDir,
    });
    const createCapture = new Capture();
    const createCode = cmdFcTasks([
      'fc_tasks',
      'create',
      '--session',
      'linked-session',
      '--store-root',
      root,
      '--engine-root',
      engineRoot,
      '--flowcrew-task-id',
      '12',
    ], dependencies(createCapture, JSON.stringify(task('linked', 'in_progress'))));

    expect(createCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'linked-session', 'linked.json'), 'utf-8')))
      .toMatchObject({ id: 'linked', flowcrewTaskId: 12 });

    seedEngineTask(engineRoot, {
      id: 12,
      status: 'running',
      projectDir,
      run_id: 'exact-run',
    });
    seedEngineRun(engineRoot, 'exact-run', {
      runId: 'exact-run',
      status: 'running',
      projectDir,
    });
    const renderCapture = new Capture();
    const renderCode = cmdFcTasks([
      'fc_tasks',
      'render',
      '--session',
      'linked-session',
      '--store-root',
      root,
      '--engine-root',
      engineRoot,
    ], dependencies(renderCapture));

    expect(renderCode).toBe(0);
    expect(renderCapture.output).toContain('run:running [linked]');
  });

  it('surfaces a canonical legacy link whose terminal run now requires human wrap-up', () => {
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'target');
    const entry = {
      ...task('legacy-link', 'in_progress'),
      description: canonicalLaunchSentence(12),
      activeForm: 'Waiting on the linked FlowCrew run',
    };
    seed('legacy-cli', entry);
    seedEngineTask(engineRoot, {
      id: 12,
      status: 'stuck',
      projectDir,
      run_id: 'terminal-run',
    });
    seedEngineRun(engineRoot, 'terminal-run', {
      runId: 'terminal-run',
      status: 'complete',
      projectDir,
    });

    const renderCapture = new Capture();
    const renderCode = cmdFcTasks([
      'fc_tasks',
      'render',
      '--session',
      'legacy-cli',
      '--store-root',
      root,
      '--engine-root',
      engineRoot,
    ], dependencies(renderCapture));

    expect(renderCode).toBe(0);
    expect(renderCapture.output).toContain('1 wrap-up overdue');
    expect(renderCapture.output).toContain('wrap-up-overdue:run:complete:#12 [legacy-link]');

    const listCapture = new Capture();
    const listCode = cmdFcTasks([
      'fc_tasks',
      'list',
      '--json',
      '--session',
      'legacy-cli',
      '--store-root',
      root,
      '--engine-root',
      engineRoot,
    ], dependencies(listCapture));
    const listed = JSON.parse(listCapture.output) as {
      entries: FcTaskEntry[];
      runLinks: Array<{ entryId: string; state: string; taskId?: number; runStatus?: string }>;
    };

    expect(listCode).toBe(0);
    expect(listed.runLinks).toMatchObject([
      { entryId: 'legacy-link', state: 'resolved', taskId: 12, runStatus: 'complete' },
    ]);
    expect(listed.entries[0]).not.toHaveProperty('flowcrewTaskId');
    expect(JSON.parse(readFileSync(join(root, 'legacy-cli', 'legacy-link.json'), 'utf-8')))
      .not.toHaveProperty('flowcrewTaskId');
  });

  it('refuses an engine task id that the explicit resolver root cannot verify', () => {
    const engineRoot = join(root, 'empty-engine');
    mkdirSync(engineRoot);
    const capture = new Capture();

    const code = cmdFcTasks([
      'fc_tasks',
      'create',
      '--session',
      'stale-link',
      '--store-root',
      root,
      '--engine-root',
      engineRoot,
      '--flowcrew-task-id',
      '404',
    ], dependencies(capture, JSON.stringify(task('linked'))));

    expect(code).toBe(1);
    expect(capture.error).toContain('stale FlowCrew task link');
    expect(existsSync(join(root, 'stale-link'))).toBe(false);
  });

  it('fails loudly and persists nothing for malformed input or a duplicate id', () => {
    const malformed = new Capture();
    const malformedCode = cmdFcTasks([
      'fc_tasks',
      'create',
      '--session',
      'malformed-session',
      '--store-root',
      root,
    ], dependencies(malformed, JSON.stringify({ ...task('bad'), status: 'not-a-status' })));

    expect(malformedCode).toBe(1);
    expect(malformed.error).toContain('refused create');
    expect(malformed.error).toContain('status must be one of');
    expect(existsSync(join(root, 'malformed-session'))).toBe(false);

    seed('duplicate-session', task('same'));
    const duplicate = new Capture();
    const duplicateCode = cmdFcTasks([
      'fc_tasks',
      'create',
      '--session',
      'duplicate-session',
      '--store-root',
      root,
      '--entry',
      JSON.stringify(task('same')),
    ], dependencies(duplicate));

    expect(duplicateCode).toBe(1);
    expect(duplicate.error).toContain('duplicate id same');
  });

  it('routes the top-level command under fc_tasks rather than a native Task name', () => {
    const dispatcher = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf-8');
    expect(dispatcher).toContain("bootstrapArgs[0] === 'fc_tasks'");
    expect(dispatcher).toContain("import('./cli-fc-tasks.js')");
  });
});
