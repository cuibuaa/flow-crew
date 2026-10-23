import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, utimesSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareContentIdentities, readContentIdentity } from '../src/content-identity.js';

describe('content identity independent of metadata', () => {
  it('defines identity from object type, byte length, and bytes while ignoring timestamps and permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'content-identity-'));
    try {
    const path = join(root, 'identity.txt');
    writeFileSync(path, 'same bytes\n');
    const before = readContentIdentity(path);
    chmodSync(path, 0o777);
    const future = new Date(Date.now() + 86_400_000);
    utimesSync(path, future, future);
    expect(compareContentIdentities(before, readContentIdentity(path))).toBe('equal');

    writeFileSync(path, 'diff bytes\n');
    expect(compareContentIdentities(before, readContentIdentity(path))).toBe('different');

    const link = join(root, 'identity-link');
    symlinkSync('diff bytes\n', link);
    expect(compareContentIdentities(
      readContentIdentity(path),
      readContentIdentity(link),
    )).toBe('different');
    expect(compareContentIdentities(
      before,
      { state: 'unavailable', reason: 'simulated unstable read' },
    )).toBe('unavailable');

    const rawLink = join(root, 'raw-identity-link');
    symlinkSync(Buffer.from([0xff]), rawLink);
    const rawBefore = readContentIdentity(rawLink);
    rmSync(rawLink);
    symlinkSync(Buffer.from([0xfe]), rawLink);
    expect(compareContentIdentities(
      rawBefore,
      readContentIdentity(rawLink),
    )).toBe('different');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
