import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { initializeState, openJournal, putEvidence, storeEvidence, recordOperation } from '../../dist-rewrite/records/state.js';
import { TERMINAL_GRACE_MS } from '../../dist-rewrite/host/process.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import { createClaudeAdapter } from '../../dist-rewrite/exec/claude.js';
import { createCodexAdapter } from '../../dist-rewrite/exec/codex.js';
import type { Result } from '../../dist-rewrite/contract/brief.js';
import type { ActivityEvent, LiveInvocation } from '../../dist-rewrite/contract/live.js';
import type { BackendRequest } from '../../dist-rewrite/contract/runtime.js';
import type { TransportContext } from '../../dist-rewrite/exec/transport.js';
const watcher = vi.hoisted(() => vi.fn(() => { throw Error('watch unavailable'); }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), watch: watcher }));
const roots: string[] = [];
afterEach(async () => { watcher.mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function get<T>(result: Result<T>): T { if (!result.ok) throw Error(result.detail); return result.value; }
/** One real journal, host and adapter over a fake provider executable; `script` is the fixture it runs. */
async function harness(backend: 'codex' | 'claude', script: string, environment: (root: string) => Record<string, string>) {
  const recorded: { type: string; owner?: unknown }[] = [];
  const root = await mkdtemp(join(tmpdir(), 'rewrite-provider-live-')); roots.push(root);
  for (const name of ['bin', 'project', 'scratch', 'store']) await mkdir(join(root, name));
  const database = get(initializeState(join(root, 'state.sqlite')));
  const journal = get(await openJournal({ database, storeRoot: join(root, 'store'), run: 'LiveRun' }, 'create'));
  const executable = join(root, 'bin', backend);
  // The fixture receives its backend as argv[2], independently of the adapter flags.
  await writeFile(executable, '#!' + process.execPath + '\nprocess.argv[2]=' + JSON.stringify(backend) + '; await import(' +
    JSON.stringify(resolve(script)) + ');\n', { mode: 0o755 });
  const context: TransportContext = { journal, privateEnvironment: { PATH: join(root, 'bin') + ':/usr/bin:/bin', ...environment(root) },
    process: { contain: async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } }), streamRoot: journal.root, scratch: join(root, 'scratch'),
      operation: request => recordOperation(journal, 'construct', request),
      storeEvidence: source => storeEvidence(journal, source), putEvidence: bytes => putEvidence(journal, bytes),
      readEvidence: ref => readEvidence(journal, ref), recordProcess: async payload => { recorded.push(payload); return { ok: true, value: 1 }; } } };
  const request = async (input: string, live: BackendRequest['live'], abort = new AbortController().signal): Promise<BackendRequest> => ({
    role: { id: 'author', backend, model: 'default', effort: 'default', prompt: '', description: '' },
    preferences: { source: {} }, attempt: { run: 'LiveRun', stage: 'work', attempt: 'attempt', invocation: 1 },
    input: get(await putEvidence(journal, Buffer.from(input))),
    instruction: 'Role text.',
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    project: join(root, 'project'), scratch: join(root, 'scratch'), abort, live });
  return { root, journal, context, request, recorded };
}
it.each([['codex', ''], ['claude', ''], ['claude', 'exit-tail']] as const)('%s real adapter %s completes independently of filesystem watchers', async (backend, mode) => {
  const activities: ActivityEvent[] = [], beforeExit: Promise<boolean>[] = [];
  let live: LiveInvocation | undefined, steering: Promise<string> | undefined, marker = '';
  const { journal, context, request } = await harness(backend, 'spec/native/fixtures/provider-live.mjs', root => ({
    EXIT_MARKER: marker = join(root, 'exited'), FINAL_WITHOUT_NEWLINE: mode }));
  const reply = get(await (backend === 'codex' ? createCodexAdapter(context) : createClaudeAdapter(context)).invoke(await request('Use initial answer', {
    onLive(value) { expect(backend).toBe('claude'); live = value; }, onActivity(event) {
      activities.push(event); beforeExit.push(access(marker).then(() => false, () => true));
      if (backend === 'claude' && !mode && event.kind === 'tool-start') steering = live!.steer('Use steered answer');
    } })));
  const carrier = JSON.parse(Buffer.from(get(await readEvidence(journal, reply.raw))).toString());
  expect(carrier.process.guarantee).toBe('marker');
  expect(carrier.process.owner.containment.kind).toBe('marker');
  expect(reply.closure).toBe('dead');
  expect(reply.ending).toBe('delivered');
  if (!mode) expect(await Promise.all(beforeExit)).toEqual([true, true, true, true]);
  expect(watcher).not.toHaveBeenCalled();
  expect(activities.map(event => event.kind)).toEqual(['tool-start', 'tool-end', 'message', 'turn-end']);
  expect(JSON.stringify(activities)).not.toContain('synthetic secret');
  expect(JSON.parse(Buffer.from(get(await readEvidence(journal, reply.answerBytes!))).toString())).toEqual({ answer: backend === 'claude' && !mode ? 'steered' : 'initial' });
  if (backend === 'claude') {
    if (!mode) expect(await steering).toBe('delivered');
    expect(await live!.steer('late')).toBe('ended');
  } else expect(live).toBeUndefined();
}, 60000);
it('a Claude result closes the owner at the terminal event although its tool stays blocked on stdin', async () => {
  let pid = '';
  const abort = new AbortController();
  const { journal, context, request, recorded } = await harness('claude', 'spec/native/fixtures/provider-blocked.mjs', root => ({
    TOOL_PID: pid = join(root, 'tool.pid') }));
  try {
    const reply = get(await createClaudeAdapter(context).invoke(await request(JSON.stringify({ answer: 'blocked' }), {}, abort.signal)));
    const carrier = JSON.parse(Buffer.from(get(await readEvidence(journal, reply.raw))).toString());
    expect(reply).toMatchObject({ ending: 'delivered', closure: 'dead' });
    expect(carrier.process).toMatchObject({ state: 'closed', exit: null, signal: null, guarantee: 'marker' });
    // The closure path ran: the host recorded the owner as closed (its descendants gone), after the terminal event and not at a native exit.
    expect(carrier.process).toMatchObject({ closedAtTerminal: true });
    expect(recorded.filter(payload => payload.type === 'owner_closed')).toEqual([{ type: 'owner_closed', owner: carrier.process.owner }]);
    expect(() => process.kill(Number(readFileSync(pid, 'utf8')), 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(JSON.parse(Buffer.from(get(await readEvidence(journal, reply.answerBytes!))).toString())).toEqual({ answer: 'blocked' });
  } finally {
    // Even when an assertion above failed: end the invocation and remove the tool process this test started.
    abort.abort();
    try { process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL'); } catch { }
  }
});
// A guide is delivered when Claude echoes it (consumes it into a turn), never at the write; a result with a written but
// unechoed guide is not terminal, since Claude runs another turn for that guide.
it.each([
  ['consumed in-turn: delivered, one result', 'in-turn', 'tool-start', 'delivered', 1, 'second'],
  ['written after the last tool boundary: the invocation waits for the second turn, which outlasts the grace period', 'after-boundary', 'tool-end', 'delivered', 2, 'second'],
  ['provider exits at its result without consuming it: stays pending', 'exit-at-result', 'tool-end', 'ended', 1, 'first'],
] as const)('guide %s', async (_name, mode, trigger, outcome, results, answer) => {
  let live: LiveInvocation | undefined, steering: Promise<string> | undefined;
  const { journal, context, request } = await harness('claude', 'spec/native/fixtures/provider-guided.mjs', () => ({
    MODE: mode, SECOND_TURN_MS: String(TERMINAL_GRACE_MS + 1500) }));
  const reply = get(await createClaudeAdapter(context).invoke(await request(JSON.stringify({ answer: 'first' }), {
    onLive(value) { live = value; }, onActivity(event) { if (event.kind === trigger) steering ??= live!.steer(JSON.stringify({ answer: 'second' })); } })));
  const carrier = JSON.parse(Buffer.from(get(await readEvidence(journal, reply.raw))).toString());
  const stdout = Buffer.from(get(await readEvidence(journal, carrier.process.stdout))).toString();
  expect(await steering).toBe(outcome);
  expect(stdout.split('\n').filter(line => line.includes('"type":"result"'))).toHaveLength(results);
  expect(reply).toMatchObject({ ending: 'delivered', closure: 'dead' });
  expect(JSON.parse(Buffer.from(get(await readEvidence(journal, reply.answerBytes!))).toString())).toEqual({ answer });
}, 30000);
