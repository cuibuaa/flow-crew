import './test-support/policy-runtime.js';
import { expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validationEnvironment } from '../src/validation-environment.js';
import { assertCommandSocketAuthority } from '../src/daemon-identity.js';

it('constructs a private validation environment under a long root without requiring a usable daemon endpoint', () => {
  const root = join(process.env.FLOWCREW_VITEST_ROOT!, 'long-private-root-'.repeat(8));
  mkdirSync(root, { recursive: true });
  const { env } = validationEnvironment(root, { PATH: '/project/bin', FLOWCREW_DAEMON_SOCKET: '/ambient/daemon.sock' });
  expect(env.FLOWCREW_DAEMON_SOCKET).toBeUndefined();
  expect(env.FC_HOME).toBe(join(root, 'home/.fc'));
  if (process.platform !== 'win32') {
    expect(() => assertCommandSocketAuthority(join(env.FC_HOME!, 'daemon.sock'), env.HOME!, env.FC_HOME!)).toThrow('too long');
  }
});
