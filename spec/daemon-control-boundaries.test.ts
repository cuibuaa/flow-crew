/** Current control-plane contract: private authority precedes every external
 * outlet; socket transport rejects ABI truncation; dashboards bind explicit
 * addresses and keep the operator's Tailscale route. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { NodeSystemd } from '../src/orchestrator.js';
import { commandSocketPath, defaultSocketPath, sendRpc, startRpcServer } from '../src/orchestrator-rpc.js';
import { assertUnixSocketPath, findUnixSocketOwnerPid, writeDaemonIdentity } from '../src/daemon-identity.js';
import { dashboardListenHosts, startDashboard } from '../src/dashboard.js';
import { cmdTask } from '../src/cli-task.js';
import { cmdDaemon } from '../src/cli-daemon.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-control-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function identity(socketPath: string, homeDir?: string) {
  return {
    pid: process.pid, startedAt: new Date().toISOString(), socketPath,
    ...(homeDir ? { homeDir, storeDir: join(root, 'foreign') } : {}),
    build: { algorithm: 'sha256' as const, hash: 'a'.repeat(64), files: 1, newestMtimeMs: 0 },
  };
}
function output() {
  let text = '';
  return { stream: { write: (data: string) => { text += data; return true; } } as NodeJS.WriteStream, text: () => text };
}

describe('private manager authority', () => {
  it.each(['unix:path=/private/bus', 'unix:abstract=private-bus', 'tcp:host=127.0.0.1,port=9', 'autolaunch:', ''])('refuses inherited session bus %s before launch, stop, observe or journal', async (bus) => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', bus);
    const backend = new NodeSystemd(root);
    expect(await backend.isActive('unit.service')).toMatchObject({ kind: 'unobservable', reason: expect.stringContaining('session bus') });
    await expect(backend.runUnit({ unit: 'unit.service', workingDirectory: root, command: 'false' })).rejects.toThrow('Refusing per-user systemd manager');
    await expect(backend.stopUnit('unit.service')).rejects.toThrow('Refusing per-user systemd manager');
    await expect(backend.journalTail('unit.service', 1)).rejects.toThrow('Refusing per-user systemd manager');
    expect(await backend.logSource('unit.service')).toMatchObject({ kind: 'unavailable' });
    expect(existsSync(join(root, 'supervise', 'unit.service', 'launch.json'))).toBe(false);
  });

  it('keeps private executable stubs and their existing arguments usable', async () => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const calls = join(root, 'calls');
    for (const name of ['systemctl', 'systemd-run', 'journalctl']) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> '${calls}'\n${name === 'systemctl' ? 'echo active' : ''}\n`);
      chmodSync(path, 0o755);
    }
    vi.stubEnv('PATH', bin);
    vi.stubEnv('XDG_RUNTIME_DIR', root);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    const backend = new NodeSystemd(root);
    expect(await backend.isActive('unit.service')).toEqual({ kind: 'active' });
    await backend.runUnit({ unit: 'unit.service', workingDirectory: root, command: 'false' });
    await backend.stopUnit('unit.service');
    await backend.journalTail('journal.service', 2);
    const text = readFileSync(calls, 'utf8');
    expect(text).toContain('systemd-run\n--user\n--unit=unit.service');
    expect(text).toContain('systemctl\n--user\nis-active\nunit.service');
    expect(text).toContain('systemctl\n--user\nstop\nunit.service');
    expect(text).toContain('journalctl\n--user\n-u\njournal.service');
  });

  it('refuses implicit routing without a private runtime and runtime endpoints', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    const backend = new NodeSystemd(root);
    await expect(backend.stopUnit('unit.service')).rejects.toThrow('private runtime');
    vi.stubEnv('XDG_RUNTIME_DIR', root);
    writeFileSync(join(root, 'bus'), 'endpoint stand-in');
    await expect(backend.stopUnit('unit.service')).rejects.toThrow('manager endpoint');
  });
});

describe('socket authority and ABI', () => {
  it('keeps the intentional custom fuse and does not change the default store', () => {
    const previousDefault = defaultSocketPath();
    const fuse = join(root, 'custom.sock');
    vi.stubEnv('FLOWCREW_DAEMON_SOCKET', fuse);
    expect(commandSocketPath()).toBe(fuse);
    expect(defaultSocketPath()).toBe(previousDefault);
  });

  it('refuses positively foreign provenance before commands can connect or signal', async () => {
    const socket = join(root, 'daemon.sock');
    writeDaemonIdentity(socket, identity(socket, join(root, 'foreign-home')));
    vi.stubEnv('FLOWCREW_DAEMON_SOCKET', socket);
    expect(() => commandSocketPath()).toThrow('another home');
    const out = output();
    expect(await cmdTask(['task', 'cancel', '1'], { stderr: out.stream })).toBe(1);
    const send = vi.fn(); const kill = vi.fn(); const owner = vi.fn();
    expect(await cmdDaemon(['daemon', 'restart'], { stderr: out.stream, controls: { sendRpc: send, killProcess: kill, findSocketOwnerPid: owner } })).toBe(1);
    expect(send).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled();
    expect(out.text()).toContain('another home');
  });

  it('keeps legacy private sockets without attestation usable', () => {
    const socket = join(root, 'daemon.sock');
    writeDaemonIdentity(socket, identity(socket));
    expect(commandSocketPath(socket)).toBe(socket);
  });

  it('refuses an attestation whose store does not name the socket parent', () => {
    const socket = join(root, 'daemon.sock');
    const home = join(root, 'home'); mkdirSync(home);
    vi.stubEnv('HOME', home);
    writeDaemonIdentity(socket, identity(socket, home));
    expect(() => commandSocketPath(socket)).toThrow('inconsistent store provenance');
  });

  it.each(['linux', 'darwin'] as const)('refuses UTF-8 paths before transport, bind, mkdir and owner lookup on %s', async (platform) => {
    const limit = platform === 'linux' ? 108 : 104;
    const path = join(root, '未'.repeat(limit));
    expect(() => assertUnixSocketPath(path, platform)).toThrow('too long');
    expect(() => findUnixSocketOwnerPid(path, { platform, procRoot: join(root, 'absent') })).toThrow('too long');
    const connect = vi.spyOn(net, 'createConnection');
    await expect(sendRpc(path, { cmd: 'stop' })).rejects.toThrow('too long');
    await expect(startRpcServer(path, () => ({ ok: true }))).rejects.toThrow('too long');
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('checks the byte boundary and rejects empty or abstract paths', () => {
    assertUnixSocketPath('/' + 'a'.repeat(106), 'linux');
    expect(() => assertUnixSocketPath('/' + 'a'.repeat(107), 'linux')).toThrow('too long');
    expect(() => assertUnixSocketPath('', 'linux')).toThrow('Invalid');
    expect(() => assertUnixSocketPath('\0abstract', 'linux')).toThrow('Invalid');
  });

  it('also checks relative and alias-resolved spellings without remapping the store', () => {
    const long = join(root, 'directory-'.repeat(14)); mkdirSync(long);
    const alias = join(root, 'alias'); symlinkSync(long, alias, 'dir');
    expect(() => assertUnixSocketPath(join(alias, 'daemon.sock'), 'linux')).toThrow('too long');
    vi.spyOn(process, 'cwd').mockReturnValue(long);
    expect(() => assertUnixSocketPath('daemon.sock', 'linux')).toThrow('too long');
  });
});

describe('dashboard listener authority', () => {
  it('retains operator Tailscale addresses while excluding LAN, CGNAT on other interfaces and wildcards', () => {
    const address = (value: string, family: 'IPv4' | 'IPv6') => ({ address: value, family, internal: false, netmask: '', mac: '', cidr: null });
    const home = join(root, 'home');
    expect(dashboardListenHosts({ home, store: join(home, '.fc'), loginHome: home, interfaces: {
      tailscale0: [address('100.98.1.2', 'IPv4'), address('fd7a:115c:a1e0::123', 'IPv6'), address('fe80::1', 'IPv6')],
      eth0: [address('192.168.1.2', 'IPv4'), address('100.98.2.3', 'IPv4')],
    } })).toEqual(['127.0.0.1', '100.98.1.2', 'fd7a:115c:a1e0::123']);
    expect(dashboardListenHosts({ home, store: root, loginHome: home })).toEqual(['127.0.0.1']);
  });

  it('starts a private listener on loopback, serves a positive response and releases its port', async () => {
    const app = await startDashboard(root, 0);
    const address = app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    expect(app.server.keepAliveTimeout).toBe(app.initialConfig.keepAliveTimeout);
    expect(app.server.requestTimeout).toBe(app.initialConfig.requestTimeout);
    expect(app.server.timeout).toBe(app.initialConfig.connectionTimeout);
    expect(app.server.listeners('clientError')).toHaveLength(1);
    try {
      expect((await app.inject('/api/dashboard/status')).statusCode).toBe(200);
    } finally { await app.close(); }
    expect(app.server.listening).toBe(false);
  });
});
