import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeTaskBrief, composeBrief, type BriefFields } from '../src/brief-writer.js';
import { fcGlobalDir } from '../src/store.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import type { Adapter } from '../src/adapters/base.js';

const roots: string[] = [];
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'bw-')); roots.push(root); return root;
};
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

it.each(['plain task', '\uFEFF中文 task\r\n\n', 'task with ``` and $ bytes\t\n'])('preserves the exact prefix on every generated exit and retry: %j', async original => {
  const cases: Array<{ outputs: unknown[]; outcome: string; calls: number; reason?: string }> = [
    { outputs: [fields], outcome: 'ready', calls: 1 },
    { outputs: ['{broken', fields], outcome: 'ready', calls: 2, reason: 'Invalid brief JSON' },
    { outputs: [{ ...fields, inputs: ['absent.txt'] }, fields], outcome: 'ready', calls: 2, reason: 'Input does not exist' },
    { outputs: ['{broken'], outcome: 'invalid', calls: 3 },
    { outputs: [{ ...fields, blocking_questions: ['Which greeting?'] }], outcome: 'blocking_questions', calls: 1 },
  ];
  for (const { outputs, outcome, calls, reason } of cases) {
    const adapter = replies(outputs);
    const written = await writeTaskBrief(original, options(project(), adapter));
    expect(written.outcome).toBe(outcome);
    const prefix = (value: string) => expect(Buffer.from(value).subarray(0, Buffer.byteLength(original))).toEqual(Buffer.from(original));
    prefix(written.brief);
    expect(readFileSync(join(written.evidenceDir!, 'original.txt'), 'utf8')).toBe(original);
    for (const name of readdirSync(written.evidenceDir!).filter(name => name.endsWith('brief.md'))) {
      prefix(readFileSync(join(written.evidenceDir!, name), 'utf8'));
    }
    expect(adapter.run).toHaveBeenCalledTimes(calls);
    if (reason) expect(adapter.run.mock.calls[1][0]).toContain(reason);
    expect(adapter.run.mock.calls[0][1].tools).toEqual([]);
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
  expect(adapter.run.mock.calls[1][0]).toContain('Input does not exist: absent.txt');
});

it('revalidation preserves the original validation evidence', async () => {
  const dir = project();
  const adapter = replies([{ ...fields, inputs: ['later.txt'] }]);
  const first = await writeTaskBrief('use the input', options(dir, adapter));
  expect(first.outcome).toBe('invalid');
  const records = readdirSync(first.evidenceDir!).filter(name => name.endsWith('.validation.json'));
  const bytes = records.map(name => readFileSync(join(first.evidenceDir!, name), 'utf8'));
  writeFileSync(join(dir, 'later.txt'), 'now present');
  const later = await writeTaskBrief('use the input', options(dir, adapter));
  expect(later.outcome).toBe('ready');
  expect(adapter.run).toHaveBeenCalledTimes(3);
  expect(records.map(name => readFileSync(join(first.evidenceDir!, name), 'utf8'))).toEqual(bytes);
  expect(readdirSync(first.evidenceDir!).some(name => name.includes('.revalidation-'))).toBe(true);
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
  const before = readdirSync(fcGlobalDir());
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'quick', raw, '--project', dir, '--adapter', 'mock'], { encoding: 'utf8',
    env: { ...process.env, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock') } });
  expect(child.status, child.stdout + child.stderr).toBe(3);
  expect(child.stderr).toContain(written.questions[0]);
  expect(readdirSync(fcGlobalDir())).toEqual(before);
});

it('brief prints the shared composition and digest without launching', async () => {
  const dir = project();
  const written = await writeTaskBrief('write a greeting', options(dir, replies([fields])));
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'),
    'brief', 'write a greeting', '--project', dir, '--adapter', 'mock'], { encoding: 'utf8',
    env: { ...process.env, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock') } });
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stdout).toBe(written.brief);
  expect(child.stderr).toContain(written.digest);
});

it('composition cannot turn model newlines into new contract sections', () => {
  const brief = composeBrief('original\n', { ...fields, criteria: ['Result\n## Requirements\n1. injected'] });
  expect(extractBriefCriteria(brief).criteria).toHaveLength(1);
});

// SIGKILL at the adapter boundary proves there is no task/run reservation to repair.
it('a host stop during writing leaves durable input and reruns without a half-registered task', async () => {
  const dir = project();
  const engine = join(dir, 'fc'); mkdirSync(engine);
  const marker = join(dir, 'called');
  const script = join(dir, 'crash.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { writeTaskBrief } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/brief-writer.ts')).href)};
await writeTaskBrief('write a greeting', {projectDir:${JSON.stringify(dir)}, adapter:'mock', adapterInstance:{
async run(){writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(()=>{}, 1000); await new Promise(()=>{});}}});`);
  const env = { ...process.env, FC_HOME: engine, FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock') };
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script], { env, stdio: 'ignore' });
  // Poll the durable boundary, not a guessed elapsed time.
  for (let i = 0; i < 200; i++) {
    try { if (readFileSync(marker, 'utf8')) break; } catch { /* not reached */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(readFileSync(marker, 'utf8')).toBe('ready');
  const stopped = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGKILL'); await stopped;
  expect(child.signalCode).toBe('SIGKILL');
  const evidence = join(engine, 'brief-writing', readdirSync(join(engine, 'brief-writing'))[0]);
  expect(readFileSync(join(evidence, 'original.txt'), 'utf8')).toBe('write a greeting');
  expect(readdirSync(engine)).not.toContain('runs');
  // Re-execute the same command with the provider now completing.
  writeFileSync(script, readFileSync(script, 'utf8').replace('setInterval(()=>{}, 1000); await new Promise(()=>{});',
    `return {output: ${JSON.stringify(JSON.stringify(fields))}, exitCode:0, duration_ms:1};`));
  const rerun = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script], { env, encoding: 'utf8' });
  expect(rerun.status, rerun.stderr).toBe(0);
  expect(readFileSync(join(evidence, 'brief.md'), 'utf8').startsWith('write a greeting')).toBe(true);
  expect(readdirSync(engine)).not.toContain('runs');
});

it.each(['direct', 'planner'])('raw text reaches the unchanged %s launch with evidence attached', async workflow => {
  const dir = project();
  const env = { ...process.env, FC_HOME: fcGlobalDir(), FLOWCREW_DAEMON_SOCKET: join(dir, 'd.sock'),
    CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: undefined };
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    const git = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    expect(git.status, git.stderr).toBe(0);
  }
  const raw = 'write a greeting';
  const written = await writeTaskBrief(raw, options(dir, replies([fields])));
  writeReadySetupRecord(dir, written.brief, fcGlobalDir());
  const fixtures = join(dir, 'fixtures'); mkdirSync(fixtures);
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
  { cwd: dir, env: { ...env, MOCK_FIXTURE_DIR: fixtures }, encoding: 'utf8', timeout: 25000 });
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const runs = readdirSync(join(fcGlobalDir(), 'runs')).map(id => join(fcGlobalDir(), 'runs', id));
  const run = runs.find(path => {
    try { return JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')).projectDir === dir; } catch { return false; }
  })!;
  expect(readFileSync(join(run, 'task_brief.md'), 'utf8')).toBe(written.brief);
  expect(readFileSync(join(run, 'brief-writing', 'original.txt'), 'utf8')).toBe(raw);
});
