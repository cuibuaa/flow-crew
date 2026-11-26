import { spawn,type ChildProcess } from 'node:child_process';
import { copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { observe } from '../../integrations/claude/flowcrew-session.mjs';
import { fixture,projectRoot,source,status } from '../fixtures/rewrite-hooks.js';
const births = new Map<ChildProcess, string>();
function birth(child: ChildProcess) {
  return readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19];
}
function remember(child: ChildProcess) { if (process.platform === 'linux') births.set(child, birth(child)); }
function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'linux' && birth(child) !== births.get(child)) throw new Error('Child birth changed');
  child.kill('SIGKILL');
}
const children: {child:ChildProcess;ended:Promise<unknown>}[]=[];
afterEach(async()=>{for(const {child,ended} of children.splice(0)){kill(child);await ended;}});
// Instrument production source in a private, self-contained module tree.
// Bundlers may rename locals; emitted-entry coverage stays in nativeHook below.
// Only these copies gain IPC barriers. Node children inherit test priority.
type Boundary = 'allocation' | 'slot' | 'linked' | 'claim' | 'closed' | 'publication' | 'retirement' | 'ownership' | 'poll' | 'claimed';
const anchors: Record<Boundary, string> = {
  claimed: '    decision.reports = reports;',
  poll: '    await pause(); // Cadence only; never an age, duration or deadline verdict.',
  ownership: '      // One owner for updates and withdrawal: ID plus a retained inode, never',
  retirement: '    if (previous) {',
  allocation: '          const taskId = `flowcrew-${number++}`;',
  slot: '      let before = priorEntry(path);',
  linked: '        before = priorEntry(path);',
  publication: "    const parent = openSync(dirname(path), 'r');",
  claim: '    const reports = [];',
  closed: '      const next = { ...before, ...entry(slot.id), blocks: before?.blocks ?? [], blockedBy: before?.blockedBy ?? [] };',
};
function worker(f: ReturnType<typeof fixture>, boundary: Boundary, event = 'Wake') {
  const dir = mkdtempSync(join(f.root, 'process-hooks-')), hook = join(dir, 'integrations/claude/flowcrew-session.mjs');
  const implementation = readFileSync(join(projectRoot, 'integrations/claude/flowcrew-session.mjs'), 'utf8');
  const anchor = anchors[boundary]; expect(implementation).toContain(anchor);
  mkdirSync(dirname(hook), { recursive: true });
  cpSync(join(projectRoot, 'rewrite-src'), join(dir, 'rewrite-src'), {recursive:true});
  writeFileSync(join(dirname(hook), 'flowcrew-session.json'), JSON.stringify(f.config));
  writeFileSync(hook, implementation
    .replaceAll('publish(', 'await publish(').replace('function await publish(', 'async function publish(')
    .replace(anchor, `
      if (process.connected ${boundary === 'publication' ? "&& path.endsWith('.json') && !exclusive" : ''}) {
        process.send('boundary');
        await new Promise(resolve => process.once('message', resolve));
        process.disconnect();
      }
` + anchor));
  const child = spawn(process.execPath, [hook, event, join(dirname(hook), 'flowcrew-session.json')], { cwd: projectRoot,
    env: { ...process.env, HOME: join(f.root, 'home'), FC_HOME: join(f.root, 'unused-store'), PATH: '' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  const paused = new Promise<void>((done, reject) => {
    child.on('message', value => { if (value === 'boundary') done(); });
    child.once('close', () => reject(new Error(`Hook closed before ${boundary}: ${stderr}`)));
    child.once('error', reject);
  });
  void paused.catch(() => {});
  const ended = new Promise<number | null>((done, reject) => { child.once('close', done); child.once('error', reject); });
  remember(child); children.push({ child, ended }); child.stdin!.end(JSON.stringify({ session_id: 'session-one' }));
  return { child, paused, ended, stderr: () => stderr, release: () => child.send('release') };
}

async function nativeHook(f: ReturnType<typeof fixture>, symlink = false) {
  const dir = join(f.root, 'home/.claude/hooks'); mkdirSync(dir, { recursive: true });
  const hook = join(dir, 'flowcrew-session.mjs'); copyFileSync(source, hook);
  writeFileSync(join(dir, 'flowcrew-session.json'), JSON.stringify(f.config));
  const entry = join(f.root, 'hook-link.mjs'); if (symlink) symlinkSync(hook, entry);
  const child = spawn(process.execPath, [symlink ? entry : hook, 'Wake', join(dir, 'flowcrew-session.json')], { cwd: projectRoot,
    env: { ...process.env, HOME: join(f.root, 'home'), FC_HOME: join(f.root, 'unused-store'), PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
  const ended = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  remember(child); children.push({ child, ended }); child.stdin!.end(JSON.stringify({ session_id: 'session-one' }));
  return { code: await ended, stdout, stderr };
}

describe('native Claude session hooks',()=>{
it('keeps only the newest waiter and reports a terminal transition once after handover', async () => {
    const f = fixture(); f.publish(status());
    const first = worker(f, 'poll'); await first.paused;
    const second = worker(f, 'poll'); await second.paused;
    const newest = worker(f, 'poll'); await newest.paused;
    first.release(); second.release();
    // Publishing completion lets an unfixed waiter finish too: red is a wrong
    // report/exit, never a hung test that requires a timeout verdict.
    f.publish(status('RunOne', 'complete'));
    expect(await Promise.all([first.ended, second.ended])).toEqual([0, 0]);
    expect([first.stderr(), second.stderr()]).toEqual(['', '']);
    newest.release(); expect(await newest.ended).toBe(2);
    expect(newest.stderr().split('FlowCrew RunOne: complete')).toHaveLength(2);
    expect((await nativeHook(f)).code).toBe(0);
  });
it('replaces the owner left by a crashed waiter without an age or PID check', async () => {
    const f = fixture(); f.publish(status());
    const crashed = worker(f, 'poll'); await crashed.paused;
    const owner = join(f.tasksRoot, 'session-one/.flowcrew-wake-owner');
    const stale = readFileSync(owner, 'utf8');
    kill(crashed.child); await crashed.ended;
    expect(crashed.child.signalCode).toBe('SIGKILL');
    expect(readFileSync(owner, 'utf8')).toBe(stale);
    f.publish(status('RunOne', 'complete'));
    const next = await nativeHook(f); expect(next.code).toBe(2);
    expect(next.stderr).toContain('RunOne: complete');
    expect(readFileSync(owner, 'utf8')).not.toBe(stale);
    expect((await nativeHook(f)).code).toBe(0);
  });
it('returns an already claimed report across handover instead of consuming it silently', async () => {
    const f = fixture(); f.publish(status('RunOne', 'complete'));
    const old = worker(f, 'claimed'); await old.paused;
    expect((await nativeHook(f)).code).toBe(0);
    old.release(); expect(await old.ended).toBe(2);
    expect(old.stderr().split('FlowCrew RunOne: complete')).toHaveLength(2);
    expect((await nativeHook(f)).code).toBe(0);
  });

it.each(['initial', 'published'] as const)('treats an %s entry unlinked between read and ownership as absent', async origin => {
    const f = fixture(); f.publish(status()); await f.invoke();
    if (origin === 'published') {
      f.publish({ ...status(), journalCursor: 8, statusSince: 8 }); await f.invoke();
    }
    f.publish(status('RunOne', 'running', 'claude:session-two'));
    const stale = worker(f, 'ownership', '--statusline'); await stale.paused;
    // A real second hook withdraws the entry after stale read its JSON, before
    // stale can check its inode. The IPC barrier fixes the interleaving exactly.
    expect((await f.invoke()).stderr).toBe(''); expect(f.entries()).toHaveLength(0);
    stale.release(); expect(await stale.ended).toBe(0);
    expect(stale.stderr()).toBe(''); expect(f.entries()).toHaveLength(0);
  });
it('keeps closure monotonic when a stale concurrent hook writes after the terminal hook and source retirement', async () => {
    const f = fixture(); f.publish(status()); await f.invoke('SessionStart');
    const stale = worker(f, 'closed', 'Stop'); await stale.paused;
    f.publish({ ...status('RunOne', 'complete'), journalCursor: 8, statusSince: 8 });
    expect((await nativeHook(f)).code).toBe(2);
    stale.release(); expect(await stale.ended).toBe(0);
    const records = join(f.tasksRoot, 'session-one/.flowcrew-state');
    const root = join(records, readdirSync(records).find(name => name !== 'ids')!);
    expect(JSON.parse(readFileSync(join(root, 'closed'), 'utf8'))).toBe(true);
    rmSync(join(f.store, 'runs/RunOne'), { recursive: true });
    expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('done');
    expect(f.entries()[0].status).toBe('completed');
    expect((await f.invoke('--statusline')).stdout).toBe('');
  });
it('retries exclusive ID reservations across separate processes on one session', async () => {
    const f = fixture(); f.publish(status('One', 'complete')); f.publish(status('Two', 'failed'));
    const contenders = [worker(f, 'allocation', 'SessionStart'), worker(f, 'allocation', 'Stop'), worker(f, 'allocation', '--statusline')];
    await Promise.all(contenders.map(w => w.paused));
    // All three selected the same free candidate before any reservation write.
    for (const w of contenders) w.release();
    expect(await Promise.all(contenders.map(w => w.ended))).toEqual([0, 0, 0]);
    expect(contenders.map(w => w.stderr())).toEqual(['', '', '']);
    const entries = f.entries(); expect(entries).toHaveLength(2);
    expect(new Set(entries.map(e => e.id)).size).toBe(2);
    expect(entries.map(e => e.subject).sort()).toEqual(['FlowCrew One', 'FlowCrew Two']);
    const before = entries.map(e => e.id); await f.invoke(); expect(f.entries().map(e => e.id)).toEqual(before);
  });
it('claims a wake once when a superseded process wins the publication race', async () => {
    const f = fixture(); f.publish(status('One', 'complete'));
    await f.invoke('SessionStart'); await f.invoke('Stop'); await f.invoke('--statusline');
    const old = worker(f, 'claim'); await old.paused;
    const newest = worker(f, 'claim'); await newest.paused;
    // Both computed the same unseen transition. Fix the race so the old
    // observation publishes first, after the new waiter has taken ownership.
    old.release(); expect(await old.ended).toBe(2);
    newest.release(); expect(await newest.ended).toBe(0);
    expect(old.stderr().split('FlowCrew One: complete')).toHaveLength(2);
    expect(newest.stderr()).toBe('');
    expect(readdirSync(join(f.tasksRoot, 'session-one/.flowcrew-wakes'))).toHaveLength(1);
    expect((await nativeHook(f)).code).toBe(0);
  });

it.each(['slot', 'linked'] as const)('recovers after SIGKILL between %s writes with a clean-run control', async boundary => {
    // The same two-hook sequence must succeed without a kill. A mutant that
    // breaks every second invocation fails here and cannot count as kill evidence.
    const control = fixture(); control.publish(status('RunOne', 'complete'));
    const graceful = worker(control, boundary); await graceful.paused; graceful.release();
    expect(await graceful.ended).toBe(2); expect((await nativeHook(control)).code).toBe(0);
    expect(control.entries()).toHaveLength(1);
    const f = fixture(); f.publish(status('RunOne', 'complete'));
    const killed = worker(f, boundary); await killed.paused;
    expect(f.entries()).toHaveLength(boundary === 'slot' ? 0 : 1);
    kill(killed.child); await killed.ended; expect(killed.child.signalCode).toBe('SIGKILL');
    const next = await nativeHook(f); expect(next.code).toBe(2); expect(next.stderr).toContain('RunOne: complete');
    expect(f.entries()).toHaveLength(1); expect(f.entries()[0].status).toBe('completed');
    const records = join(f.tasksRoot, 'session-one/.flowcrew-state');
    const runRoot = join(records, readdirSync(records).find(name => name !== 'ids')!);
    const slot = JSON.parse(readFileSync(join(runRoot, 'slot-0'), 'utf8'));
    expect(f.entries()[0].id).toBe(slot.id);
    expect(JSON.parse(readFileSync(join(runRoot, 'closed'), 'utf8'))).toBe(true);
    expect((await nativeHook(f)).code).toBe(0);
  });
it.each([['open', 'publication'], ['closed', 'publication'], ['open', 'retirement'], ['closed', 'retirement']] as const)('A10 recovers the %s task %s crash cut and preserves a later foreign inode', async (state, boundary) => {
    async function prepared() {
      const f = fixture(); f.publish(status('RunOne', state === 'open' ? 'running' : 'complete'));
      await f.invoke('SessionStart');
      // Start with a published inode so retirement has a superseded proof.
      f.publish({ ...status('RunOne', state === 'open' ? 'running' : 'complete'), journalCursor: 8, statusSince: 8 });
      await f.invoke();
      const path = join(f.tasksRoot, 'session-one/flowcrew-1.json');
      if (state === 'open') f.publish(status('RunOne', 'complete'));
      else {
        rmSync(join(f.store, 'runs/RunOne'), { recursive: true });
        writeFileSync(path, JSON.stringify({ ...f.entries()[0], status: 'in_progress', custom: 17 }));
      }
      return { f, path, inode: statSync(path).ino };
    }
    // Clean and killed executions take the same publication branch. The barrier
    // is after rename, either before parent fsync or before old-proof retirement.
    const control = await prepared(), graceful = worker(control.f, boundary, 'Stop');
    await graceful.paused; graceful.release(); expect(await graceful.ended).toBe(0);
    expect((await control.f.invoke()).stderr).toBe('');
    expect(control.f.entries()).toHaveLength(1); expect(control.f.entries()[0].status).toBe('completed');
    const { f, path, inode } = await prepared(), killed = worker(f, boundary, 'Stop');
    await killed.paused;
    expect(statSync(path).ino).not.toBe(inode); expect(f.entries()[0].status).toBe('completed');
    kill(killed.child); await killed.ended; expect(killed.child.signalCode).toBe('SIGKILL');
    expect((await f.invoke()).stderr).toBe(''); expect(f.entries()).toHaveLength(1);
    expect(f.entries()[0]).toMatchObject({ id: 'flowcrew-1', status: 'completed' });
    if (state === 'closed') expect(f.entries()[0].custom).toBe(17);
    // A surviving old identity must distinguish our publication from an atomic
    // replacement carrying the identical ID and title after recovery.
    const foreign = JSON.stringify({ ...f.entries()[0], custom: 42 });
    writeFileSync(path + '.replacement', foreign); renameSync(path + '.replacement', path);
    f.publish(status('RunOne', 'complete')); expect((await f.invoke()).stderr).toBe('');
    expect(readFileSync(path, 'utf8')).toBe(foreign);
    expect(f.entries().find(e => e.id === 'flowcrew-2')).toMatchObject({ status: 'completed' });
  });
it.each([false, true])('real hook process renders entries and returns the stderr exit-2 protocol (symlink=%s)', async symlink => {
    const f = fixture(); f.publish(status('RunOne', 'complete'));
    const result = await nativeHook(f, symlink);
    expect(result.code).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain('RunOne: complete');
    expect(f.entries()[0].status).toBe('completed');
  });
});
