// Use Codex's own config editor for narrow hook trust. Never parse/rewrite the
// user's TOML or trust other hooks as a side effect of installing FlowCrew.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, codexBin, cwd, shipPath, statusPath, frontendRoot] = process.argv.slice(2);
// Exit values mirror src/exit-code.ts: completed=0, failed=1, inProgress=5.
class VerificationUnfinished extends Error {}
const allowance = process.env.FLOWCREW_CODEX_VERIFY_TIMEOUT_MS;
if (allowance !== undefined && (!/^[0-9]+$/.test(allowance) || !Number.isSafeInteger(Number(allowance))
    || Number(allowance) <= 0 || Number(allowance) > 2 ** 31 - 1)) {
  process.stderr.write('FLOWCREW_CODEX_VERIFY_TIMEOUT_MS must be a positive integer no greater than 2147483647.\n');
  process.exit(1);
}
const manifestPath = join(frontendRoot, 'hooks', 'flowcrew-session.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const child = spawn(codexBin, ['app-server'], { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let identity = 0;
let input = '';
let stderr = '';
let closed = false;
const done = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
const timer = allowance === undefined ? undefined : setTimeout(() => fail(
  new VerificationUnfinished(`declared verification allowance (${allowance} ms) expired before verification completed`)), Number(allowance));
child.stdin.on('error', () => {});
child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-64 * 1024); });
child.once('error', error => fail(error));
child.once('close', code => fail(new Error(stderr.trim() || `Codex app-server exited without skills/list (status ${code})`)));
child.stdout.setEncoding('utf8').on('data', text => {
  input += text;
  if (input.length > 4 * 1024 * 1024) return fail(new Error('Codex response exceeded limit'));
  for (;;) {
    const end = input.indexOf('\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++identity;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const signal = name => {
  try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch {}
};
const interrupt = signalName => {
  signal('SIGKILL');
  process.exit(signalName === 'SIGINT' ? 130 : 143);
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  await call('initialize', { clientInfo: { name: 'flowcrew_installer', title: 'FlowCrew Installer', version: '1' } });
  send({ method: 'initialized', params: {} });
  if (action === 'install') {
    const result = await call('skills/list', { cwds: [cwd], forceReload: true });
    const listed = result.data?.flatMap(row => row.skills || []) || [];
    for (const [name, path] of [['ship', shipPath], ['fc-status', statusPath]]) {
      if (!listed.some(entry => entry.name === name && typeof entry.path === 'string' && realpathSync(entry.path) === realpathSync(path) && entry.enabled !== false)) {
        throw new Error(`Codex did not enumerate ${name} at ${path}`);
      }
    }
    process.stdout.write('  Codex skills/list enumerated ship and fc-status.\n');
  }
  const source = realpathSync(join(frontendRoot, 'hooks.json'));
  const listedHooks = async () => (await call('hooks/list', { cwds: [cwd] })).data?.flatMap(row => row.hooks || []) || [];
  const ownHooks = rows => rows.filter(h => h.sourcePath === source && ['sessionStart', 'stop'].includes(h.eventName)
    && h.command === `${manifest.command} ${h.eventName === 'stop' ? 'Stop' : 'SessionStart'}`);
  const hooks = ownHooks(await listedHooks());
  if (action === 'install' && (hooks.length !== 2 || !hooks.every(h => /^sha256:[a-f0-9]{64}$/.test(h.currentHash)))) {
    throw new Error('Codex did not enumerate both FlowCrew hooks. Trust the project layer or install --global; run flowcrew doctor.');
  }
  if (action === 'check') {
    if (hooks.length !== 2 || hooks.some(h => !h.enabled || !['trusted', 'managed'].includes(h.trustStatus)
        || !manifest.codexTrust?.some(record => record.key === h.key && record.hash === h.currentHash))) {
      throw new Error('missing, modified or disabled current Codex hook trust; rerun installer to enroll only FlowCrew definitions');
    }
    process.stdout.write('  Current native FlowCrew hook definitions are enabled and trusted.\n');
  }
  const selected = action === 'install' ? hooks : action === 'remove'
    ? hooks.filter(h => manifest.codexTrust?.some(record => record.key === h.key && record.hash === h.currentHash)) : [];
  if (selected.length) {
    await call('config/batchWrite', {
      reloadUserConfig: true,
      edits: selected.flatMap(h => action === 'install' ? [
        { keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: 'replace' },
        { keyPath: `hooks.state.${JSON.stringify(h.key)}.enabled`, value: true, mergeStrategy: 'replace' },
      ] : [{ keyPath: `hooks.state.${JSON.stringify(h.key)}`, value: null, mergeStrategy: 'replace' }]),
    });
    process.stdout.write('  Completed: Codex native hook config edits acknowledged.\n');
  }
  if (action === 'install') {
    const active = ownHooks(await listedHooks());
    if (active.length !== 2 || active.some(h => !h.enabled || !['trusted', 'managed'].includes(h.trustStatus))) throw new Error('FlowCrew hook trust did not become active');
    manifest.codexTrust = active.map(h => ({ key: h.key, hash: h.currentHash }));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('  Codex trusts only the two installed FlowCrew hook definitions.\n');
  }
  process.stdout.write('Codex verification verified.\n');
} catch (error) {
  const unfinished = error instanceof VerificationUnfinished;
  process.stderr.write(`Codex verification ${unfinished ? 'unfinished' : 'unavailable'}: ${error.message}\n`);
  process.exitCode = unfinished ? 5 : 1;
} finally {
  clearTimeout(timer);
  child.stdin.end();
  // This app-server belongs only to this probe. Retire it on every result,
  // including interrupt/expiry, without timing shutdown or changing the verdict.
  if (!closed) signal('SIGKILL');
  await done;
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
