import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeTaskBrief, composeBrief, type BriefFields } from '../src/brief-writer.js';
import { fcGlobalDir } from '../src/store.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import type { Adapter } from '../src/adapters/base.js';

const roots: string[] = [];
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-')); roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']);
  return root;
};
const git = (dir: string, args: string[]) => isolatedProjectCommand('git', args, dir, dir);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fields: BriefFields = { criteria: ['The greeting is available.'], constraints: [], inputs: [],
  assumptions: ['The existing greeting convention applies.'], blocking_questions: [] };
function replies(outputs: unknown[]) {
  const run = vi.fn<Adapter['run']>(async (_prompt, _role, opts) => {
    const value = outputs[Math.min(run.mock.calls.length - 1, outputs.length - 1)];
    opts.onInvocationInput?.({ systemPrompt: _role.prompt, userPrompt: _prompt });
    return { output: typeof value === 'string' ? value : JSON.stringify(value), exitCode: 0,
      duration_ms: 12, tokens_in: 20, tokens_out: 10 };
  });
  return { run };
}
const options = (projectDir: string, adapterInstance: Adapter) => ({ projectDir, adapter: 'mock', adapterInstance });

it('skips the model entirely when structural criteria exist', async () => {
  const adapter = replies([fields]);
  const original = '# Goal\r\n\r\n## Acceptance criteria\r\n1. The bytes survive.\r\n';
  const written = await writeTaskBrief(original, options(project(), adapter));
  expect(written.brief).toBe(original);
  expect(written.evidenceDir).toBeUndefined();
  expect(adapter.run).not.toHaveBeenCalled();
});

it.each(['plain task', '\uFEFF中文 task\r\n\n', 'task with ``` and $ bytes\t\n', 'task\n```ts\nunfinished', 'task\n~~~\nunfinished\r\n'])('preserves the exact prefix on every generated exit and retry: %j', async original => {
  const cases: Array<{ outputs: unknown[]; outcome: string; calls: number; reason?: string }> = [
    { outputs: [fields], outcome: 'ready', calls: 1 },
    { outputs: ['{broken', fields], outcome: 'ready', calls: 2, reason: 'Invalid brief JSON' },
    { outputs: [{ ...fields, inputs: ['absent.txt'] }, fields], outcome: 'ready', calls: 2, reason: 'Input does not exist' },
    { outputs: ['{broken'], outcome: 'invalid', calls: 3 },
    { outputs: ['provider unavailable'], outcome: 'provider_error', calls: 1 },
    { outputs: [{ ...fields, blocking_questions: ['Which greeting?'] }], outcome: 'blocking_questions', calls: 1 },
  ];
  for (const { outputs, outcome, calls, reason } of cases) {
    const adapter = replies(outputs);
    if (outcome === 'provider_error') adapter.run.mockResolvedValueOnce({ output: '', exitCode: 1, duration_ms: 1 });
    const written = await writeTaskBrief(original, options(project(), adapter));
    expect(written.outcome).toBe(outcome);
    const prefix = (value: string) => expect(Buffer.from(value).subarray(0, Buffer.byteLength(original))).toEqual(Buffer.from(original));
    prefix(written.brief);
    if (outcome === 'ready') expect(extractBriefCriteria(written.brief).criteria).toHaveLength(1);
    expect(readFileSync(join(written.evidenceDir!, 'original.txt'), 'utf8')).toBe(original);
    for (const name of readdirSync(written.evidenceDir!).filter(name => name.endsWith('brief.md'))) {
      const composed = readFileSync(join(written.evidenceDir!, name), 'utf8');
      prefix(composed);
      expect(extractBriefCriteria(composed).criteria).toHaveLength(1);
    }
    expect(adapter.run).toHaveBeenCalledTimes(calls);
    if (reason) expect(adapter.run.mock.calls[1][0]).toContain(reason);
    expect(adapter.run.mock.calls[0][1].tools).toEqual([]);
    expect(adapter.run.mock.calls[0][2].includeExtensions).toBe(false);
    expect(adapter.run.mock.calls[0][2].outputSchema?.required).toEqual(Object.keys(fields));
  }
});

it('invalid JSON retries twice, keeps each reply and validation, then stops', async () => {
  const adapter = replies(['{', 'null', { ...fields, workflow: 'direct' }]);
  const written = await writeTaskBrief('write a greeting', options(project(), adapter));
  expect(written.outcome).toBe('invalid');
  expect(written.brief).toBe('write a greeting');
  expect(adapter.run).toHaveBeenCalledTimes(3);
  const files = readdirSync(written.evidenceDir!);
  for (const suffix of ['reply.json', 'validation.json', 'invocation.json']) {
    expect(files.filter(f => f.endsWith(suffix))).toHaveLength(3);
  }
  expect(written.reasons.join()).toContain('workflow');
});

it('nonexistent input uses the same correction path', async () => {
  const adapter = replies([{ ...fields, inputs: ['absent.txt'] }, fields]);
  const written = await writeTaskBrief('use the source to greet', options(project(), adapter));
  expect(written.outcome).toBe('ready');
  expect(adapter.run.mock.calls[1][0]).toContain('Input does not exist in the target Git tree: absent.txt');
});

it('revalidation preserves the original validation evidence', async () => {
  const dir = project();
  const adapter = replies([{ ...fields, inputs: ['later.txt'] }]);
  const first = await writeTaskBrief('use the input', options(dir, adapter));
  expect(first.outcome).toBe('invalid');
  const records = readdirSync(first.evidenceDir!).filter(name => name.endsWith('.validation.json'));
  const bytes = records.map(name => readFileSync(join(first.evidenceDir!, name), 'utf8'));
  writeFileSync(join(dir, 'later.txt'), 'now present');
  git(dir, ['add', 'later.txt']);
  git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'input']);
  const later = await writeTaskBrief('use the input', options(dir, adapter));
  expect(later.outcome).toBe('ready');
  expect(adapter.run).toHaveBeenCalledTimes(4);
  expect(records.map(name => readFileSync(join(first.evidenceDir!, name), 'utf8'))).toEqual(bytes);
  expect(readdirSync(first.evidenceDir!).filter(name => name.endsWith('.reply.json'))).toHaveLength(4);
});

it('existing admission and rehearsal failures use the same correction path', async () => {
  const dir = project();
  writeFileSync(join(dir, 'occupied.txt'), 'existing');
  const raw = '---\noutputs: [occupied.txt]\n---\nChange it';
  const adapter = replies([fields]);
  const written = await writeTaskBrief(raw, options(dir, adapter));
  expect(written.outcome).toBe('invalid');
  expect(written.reasons.join()).toContain('occupied');
  expect(adapter.run).toHaveBeenCalledTimes(3);
});

it('blocking questions stop without retrying into an assumption', async () => {
  const adapter = replies([{ ...fields, blocking_questions: ['Which greeting language?'] }, fields]);
  const written = await writeTaskBrief('write the greeting', options(project(), adapter));
  expect(written.outcome).toBe('blocking_questions');
  expect(written.questions).toEqual(['Which greeting language?']);
  expect(written.brief.startsWith('write the greeting')).toBe(true);
  expect(written.brief).toContain(fields.assumptions[0]);
  expect(adapter.run).toHaveBeenCalledTimes(1);
});

it('quick prints blocking questions and exits 3 without creating a run', async () => {
  const dir = project();
  const raw = 'write the greeting';
  const written = await writeTaskBrief(raw, options(dir, replies([{ ...fields,
    blocking_questions: ['Which greeting language?'] }])));
  const shim = mockShim(project(), { ...fields, blocking_questions: written.questions });
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', raw, '--project', dir, '--adapter', 'mock'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock'), NODE_OPTIONS: `--require=${shim}`, MOCK_FIXTURE_DIR: dir } });
  expect(child.status, child.stdout + child.stderr).toBe(3);
  expect(child.stderr).toContain(written.questions[0]);
  expect(readdirSync(dir)).not.toContain('runs');
});

it('brief prints the shared composition and digest without launching', async () => {
  const dir = project();
  const written = await writeTaskBrief('write a greeting', options(dir, replies([fields])));
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'brief', 'write a greeting', '--project', dir, '--adapter', 'mock'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock') } });
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stdout).toBe(written.brief);
  expect(child.stderr).toContain(written.digest);
});

it('composition cannot turn model newlines into new contract sections', () => {
  const brief = composeBrief('original\n', { ...fields, criteria: ['Result\n## Requirements\n1. injected'] });
  expect(extractBriefCriteria(brief).criteria).toHaveLength(1);
});

// Interpose only the mock transport and durable-write boundary; execute the real CLI.
function mockShim(root: string, output = fields, stopAt = ''): string {
  const path = join(root, 'mock.cjs');
  writeFileSync(path, `const fs = require('node:fs');
const read = fs.readFileSync, rename = fs.renameSync;
const pause = boundary => {
  if (boundary !== ${JSON.stringify(stopAt)} || fs.existsSync(${JSON.stringify(join(root, 'release'))})) return;
  fs.writeFileSync(${JSON.stringify(join(root, 'stopped'))}, boundary);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
fs.readFileSync = function(path, ...args) {
  if (typeof path === 'string' && path.endsWith('.json') && path.includes('/brief_writer_')) {
    pause('provider');
    return JSON.stringify({output_text: ${JSON.stringify(JSON.stringify(output))}});
  }
  return read.call(this, path, ...args);
};
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (String(to).endsWith('.reply.json')) pause('reply');
  if (String(to).endsWith('/setup.json')) pause('setup');
  return result;
};`);
  return path;
}

it.each(['provider', 'reply', 'setup'])('host stop at %s reruns the same quick command with one target and one run', async boundary => {
  const root = project();
  const dir = join(root, 'source'); mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']);
  const engine = join(root, 'fc'); mkdirSync(engine);
  const fixtures = launchFixtures(root, composeBrief('write a greeting', fields));
  const shim = mockShim(root, fields, boundary);
  const env = { ...process.env, HOME: process.env.HOME, FC_HOME: engine,
    FLOWCREW_DAEMON_SOCKET: join(root, 'd.sock'), MOCK_FIXTURE_DIR: fixtures, NODE_OPTIONS: `--require=${shim}`,
    CODEX_THREAD_ID: 'fixture-session', CLAUDE_CODE_SESSION_ID: undefined, FC_TASKS_ROOT: join(root, 'ledger') };
  const args = ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', 'write a greeting', '--adapter', 'mock'];
  const child = spawn(process.execPath, args, { cwd: dir, env: { ...env, HOME: process.env.HOME, FC_HOME: engine }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 400; i++) {
      try { if (readFileSync(join(root, 'stopped'), 'utf8')) break; } catch { /* wait for boundary */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe(boundary);
  } finally {
    const stopped = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL'); await stopped;
  }
  expect(readdirSync(engine)).not.toContain('runs');
  const evidence = join(engine, 'brief-writing', readdirSync(join(engine, 'brief-writing')).find(n => n !== 'by-digest')!);
  expect(readFileSync(join(evidence, 'original.txt'), 'utf8')).toBe('write a greeting');
  writeFileSync(join(root, 'release'), 'continue');
  const rerun = spawnSync(process.execPath, args, { cwd: dir,
    env: { ...env, HOME: process.env.HOME, FC_HOME: engine }, encoding: 'utf8', timeout: 25000 });
  expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
  const runs = readdirSync(join(engine, 'runs'));
  expect(runs).toHaveLength(1);
  const run = JSON.parse(readFileSync(join(engine, 'runs', runs[0], 'run.json'), 'utf8'));
  expect(run.status).toBe('complete');
  expect(readdirSync(join(root, 'source-wt'))).toHaveLength(1);
  expect(readdirSync(evidence).filter(n => n.endsWith('.reply.json'))).toHaveLength(1);
  expect(run.taskDescription).toContain('write a greeting');
  const tasks = readFileSync(join(engine, 'tasks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(new Set(tasks.map(task => task.id)).size).toBe(1);
  expect(tasks.at(-1).run_id).toBe(runs[0]);
  expect(tasks.at(-1).status).toBe('done');
});

function launchFixtures(root: string, brief: string): string {
  const fixtures = join(root, 'fixtures'); mkdirSync(fixtures);
  const ids = extractBriefCriteria(brief).criteria.map(c => c.id);
  writeFileSync(join(fixtures, 'implement.json'), JSON.stringify({ output_text: 'The greeting is available.' }));
  writeFileSync(join(fixtures, 'review.json'), JSON.stringify({ output_text: JSON.stringify({ pass: true, reason: 'Verified.',
    criteria: Object.fromEntries(ids.map(id => [id, { status: 'pass', evidence: 'The greeting is available.' }])),
    audit_findings: { version: 1, findings: [] } }) }));
  return fixtures;
}

it.each(['direct', 'planner'])('raw text reaches the unchanged %s launch with evidence attached', async workflow => {
  const root = project();
  const dir = join(root, 'source'); mkdirSync(dir);
  const env = { ...process.env, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock'),
    CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined };
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    isolatedProjectCommand('git', args, dir, root);
  }
  const raw = 'write a greeting';
  const written = await writeTaskBrief(raw, options(dir, replies([fields])));
  const fixtures = join(root, 'fixtures'); mkdirSync(fixtures);
  const ids = extractBriefCriteria(written.brief).criteria.map(c => c.id);
  const fixture = (id: string, output: unknown) => writeFileSync(join(fixtures, `${id}.json`),
    JSON.stringify({ output_text: typeof output === 'string' ? output : JSON.stringify(output) }));
  const dispatch = [
    { id: 'implement', role: 'coder', scope: [] },
    { id: 'review', role: 'qa', depends_on: ['implement'], scope: [], is_gate: true, criterion_refs: ids },
    { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [] },
  ];
  writeFileSync(join(fixtures, 'plan.json'), JSON.stringify({ output_text: 'Plan ready.',
    write_files: { 'dispatch.yaml': JSON.stringify(dispatch) } }));
  fixture('implement', 'The greeting is available.');
  fixture('review', { pass: true, reason: 'Greeting verified.',
    criteria: Object.fromEntries(ids.map(id => [id, { status: 'pass', evidence: 'The greeting is available.' }])),
    audit_findings: { version: 1, findings: [] } });
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', raw, '--project', dir, '--adapter', 'mock', '--workflow', workflow, '--no-campaign'],
  { cwd: dir, env: { ...env, HOME: process.env.HOME, FC_HOME: fcGlobalDir(), MOCK_FIXTURE_DIR: fixtures }, encoding: 'utf8', timeout: 25000 });
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const runs = readdirSync(join(fcGlobalDir(), 'runs')).map(id => join(fcGlobalDir(), 'runs', id));
  const run = runs.find(path => {
    try { return JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')).projectDir === join(root, 'source-wt', `brief-${written.digest.slice(0, 12)}`); } catch { return false; }
  })!;
  expect(readFileSync(join(written.evidenceDir!, 'setup.json'), 'utf8')).toContain('\"state\": \"ready\"');
  expect(JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')).workflowName).toBe(workflow);
  expect(readFileSync(join(run, 'task_brief.md'), 'utf8')).toBe(written.brief);
  expect(readFileSync(join(run, 'brief-writing', 'original.txt'), 'utf8')).toBe(raw);
});

it.each(['dirty', 'target_collision', 'authored'])('keeps setup refusals before launch: %s', async refusal => {
  const root = project();
  const dir = join(root, 'source'); mkdirSync(dir);
  const git = (args: string[]) => {
    isolatedProjectCommand('git', args, dir, root);
  };
  git(['init', '-q']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']);
  const raw = 'write a greeting';
  const written = await writeTaskBrief(raw, options(dir, replies([fields])));
  if (refusal === 'dirty') writeFileSync(join(dir, 'dirty.txt'), 'uncommitted');
  if (refusal === 'target_collision') mkdirSync(join(root, 'source-wt', `brief-${written.digest.slice(0, 12)}`), { recursive: true });
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', refusal === 'authored' ? written.brief : raw, '--project', dir, '--adapter', 'mock', '--no-campaign'],
  { cwd: dir, env: { ...process.env, HOME: process.env.HOME, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(root, 'd.sock'),
    CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined }, encoding: 'utf8' });
  expect(child.status, child.stdout + child.stderr).toBe(1);
  expect(child.stderr).toContain(refusal === 'dirty' ? 'source working tree is dirty'
    : refusal === 'target_collision' ? 'cannot be safely reused' : 'no exact setup record');
  const runRoot = join(fcGlobalDir(), 'runs');
  const runs = (() => { try { return readdirSync(runRoot); } catch { return []; } })();
  expect(runs.some(id => {
    try { return JSON.parse(readFileSync(join(runRoot, id, 'run.json'), 'utf8')).projectDir.startsWith(root); }
    catch { return false; }
  })).toBe(false);
});

it('provider failure stops once, is not a reply, and the same command tries again', async () => {
  const dir = project();
  const run = vi.fn<Adapter['run']>().mockRejectedValueOnce(new Error('login unavailable'))
    .mockResolvedValueOnce({ output: JSON.stringify(fields), exitCode: 0, duration_ms: 1 });
  const first = await writeTaskBrief('write a greeting', options(dir, { run }));
  expect(first.outcome).toBe('provider_error');
  expect(run).toHaveBeenCalledTimes(1);
  expect(readdirSync(first.evidenceDir!).filter(n => n.endsWith('.reply.json'))).toHaveLength(0);
  expect(readdirSync(first.evidenceDir!).some(n => n.endsWith('.failure.json'))).toBe(true);
  expect((await writeTaskBrief('write a greeting', options(dir, { run }))).outcome).toBe('ready');
  expect(run).toHaveBeenCalledTimes(2);
});

it.each(['absent.txt', '/absolute.txt', ['..', 'outside'].join('/'), 'ignored.txt'])('rejects inputs unavailable in the target: %s', async input => {
  const dir = project();
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt');
  writeFileSync(join(dir, 'ignored.txt'), 'only in source');
  const adapter = replies([{ ...fields, inputs: [input] }, fields]);
  const result = await writeTaskBrief('use repository inputs', options(dir, adapter));
  expect(result.outcome).toBe('ready');
  expect(adapter.run).toHaveBeenCalledTimes(2);
  expect(adapter.run.mock.calls[1][0]).toContain(input);
});

it('a saved preview attaches evidence on a different target without another model call', async () => {
  const source = project(), target = project();
  const adapter = replies([fields]);
  const written = await writeTaskBrief('write a greeting', options(source, adapter));
  const { attachBriefWritingEvidence } = await import('../src/brief-writer.js');
  const supplied = await writeTaskBrief(written.brief, options(target, adapter));
  attachBriefWritingEvidence(target, supplied.brief, target);
  expect(readFileSync(join(target, 'brief-writing', 'original.txt'), 'utf8')).toBe('write a greeting');
  expect(adapter.run).toHaveBeenCalledTimes(1);
});

it.each(['existing_file', 'dirty', 'non_git', 'unborn', 'occupied_output', 'no_task'])('refuses before any model call: %s', async kind => {
  const dir = project();
  if (kind === 'non_git') rmSync(join(dir, '.git'), { recursive: true });
  if (kind === 'unborn') { rmSync(join(dir, '.git'), { recursive: true }); git(dir, ['init', '-q']); }
  if (kind === 'dirty' || kind === 'existing_file') writeFileSync(join(dir, 'task.md'), '## Acceptance criteria\n1. Done.');
  if (kind === 'occupied_output') {
    writeFileSync(join(dir, '.gitignore'), 'ignored');
    git(dir, ['add', '.gitignore']);
    git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'input']);
  }
  const engine = join(project(), 'private-fc');
  const refusalRecord = join(project(), 'refusal.json');
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    kind === 'no_task' ? 'brief' : 'quick', ...(kind === 'no_task' ? [] : [...(kind === 'occupied_output' ? ['--task'] : []), kind === 'existing_file' ? 'task.md'
      : kind === 'occupied_output' ? '---\noutputs: [.gitignore]\n---\nwrite a greeting' : 'write a greeting']),
    '--adapter', 'mock'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME, FC_HOME: engine, FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock'), FLOWCREW_LAUNCH_RESULT_PATH: refusalRecord } });
  expect(child.status, child.stdout + child.stderr).toBe(1);
  expect(child.stderr).toContain(kind === 'existing_file' ? 'through stdin with -'
    : kind === 'dirty' ? 'source working tree is dirty' : kind === 'no_task' ? 'Usage: flowcrew brief'
    : kind === 'occupied_output' ? 'Launch refused before brief writing' : 'committed HEAD');
  if (kind !== 'no_task') expect(JSON.parse(readFileSync(refusalRecord, 'utf8')).kind).toBe('launch_refused');
  if (kind === 'no_task') expect(child.stderr).not.toContain('--workflow');
  expect(() => readdirSync(join(engine, 'brief-writing'))).toThrow();
  expect(child.stderr).not.toContain('Command failed: git');
});

it('nonzero provider result has its own CLI outcome and never becomes a reply', () => {
  const dir = project(), engine = join(project(), 'fc');
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', 'write a greeting', '--adapter', 'mock'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME, FC_HOME: engine, FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock') } });
  expect(child.status, child.stdout + child.stderr).toBe(4);
  expect(child.stderr).toContain('Brief provider call failed');
  const evidence = join(engine, 'brief-writing', readdirSync(join(engine, 'brief-writing'))[0]);
  expect(readdirSync(evidence).filter(name => name.endsWith('.reply.json'))).toHaveLength(0);
});

it('keeps native per-request counters and context before successful-home cleanup', async () => {
  const { codexRequestEvidence } = await import('../src/adapters/codex.js');
  const events = [
    { type: 'session_meta', payload: { base_instructions: { text: 'native base' } } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'role prompt' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'task' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } } } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 210, cached_input_tokens: 100, output_tokens: 15 } } } },
  ];
  const record = codexRequestEvidence(events.map(event => JSON.stringify(event)).join('\n')) as any;
  expect(record.request_count).toBe(2);
  expect(record.requests.map((request: any) => [request.input_tokens, request.cached_input_tokens, request.output_tokens]))
    .toEqual([[100, 20, 5], [110, 80, 10]]);
  expect(JSON.stringify(record.requests[1].context)).toContain('tool output');
  const adapter = replies([fields]);
  adapter.run.mockImplementationOnce(async (_p, _r, opts) => {
    opts.onRequestEvidence?.(record);
    return { output: JSON.stringify(fields), exitCode: 0, duration_ms: 1 };
  });
  const written = await writeTaskBrief('write a greeting', options(project(), adapter));
  const ledger = readdirSync(written.evidenceDir!).find(n => n.includes('.requests-'))!;
  expect(JSON.parse(readFileSync(join(written.evidenceDir!, ledger), 'utf8'))).toEqual(record);
});

it('repository-only Codex preparation omits extension caches while keeping the role and effort', async () => {
  const { writeCodexConfig } = await import('../src/adapters/codex.js');
  const home = join(project(), 'native');
  const role = { name: 'brief_writer', description: 'brief', tools: [], prompt: 'outcome properties', model: 'test-model', reasoning_effort: 'low' };
  const config = readFileSync(writeCodexConfig(home, role, undefined, false), 'utf8');
  expect(config).toContain('outcome properties');
  expect(config).toContain('model_reasoning_effort = "low"');
  expect(readdirSync(home)).not.toContain('skills');
  expect(readdirSync(home)).not.toContain('.tmp');
});
