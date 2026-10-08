import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A container started with `--user <uid>` has HOME but no passwd entry for that uid, so
// os.userInfo() throws ENOENT while os.homedir() still works.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => {
      throw Object.assign(new Error('A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)'), { code: 'ERR_SYSTEM_ERROR' });
    },
  };
});

import { assertCommandSocketAuthority, isOperatorStateRoot, loginHomeDirectory } from '../src/daemon-identity.js';
import { dashboardListenHosts } from '../src/dashboard.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flowcrew-no-passwd-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a uid with no passwd entry', () => {
  it('has no login home, so no state root is the operator\'s', () => {
    const home = join(root, 'home');
    expect(loginHomeDirectory()).toBeUndefined();
    expect(isOperatorStateRoot(home, join(home, '.fc'))).toBe(false);
  });

  it('serves a dashboard on loopback only, even beside a Tailscale interface', () => {
    const home = join(root, 'home');
    const tailscale = { address: '100.98.1.2', family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null };
    expect(dashboardListenHosts({ home, store: join(home, '.fc'), interfaces: { tailscale0: [tailscale] } })).toEqual(['127.0.0.1']);
  });

  it('still checks a custom command socket, with no login store to protect', () => {
    const home = join(root, 'home');
    expect(() => assertCommandSocketAuthority(join(root, 'daemon.sock'), home, join(home, '.fc'))).not.toThrow();
    expect(() => assertCommandSocketAuthority(join(root, 'x'.repeat(120), 'daemon.sock'), home, join(home, '.fc'))).toThrow('too long');
  });
});
