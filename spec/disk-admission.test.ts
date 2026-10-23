import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireDiskCapacity } from '../src/disk-admission.js';
import { copyFileSync, cpSync } from '../src/engine-fs.js';
import { installDiskGuardFixture } from './test-support/disk-guard-fixture.js';

let root: string;
let log: string;
beforeEach(() => {
  root = join(process.env.FLOWCREW_VITEST_ROOT!, `disk-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root);
  log = installDiskGuardFixture(root, 10);
  vi.stubEnv('HOME', root);
});
afterEach(() => vi.unstubAllEnvs());

describe('setup disk admission boundary', () => {
  it('uses the existing need interface and retains the capacity refusal reason', () => {
    requireDiskCapacity(5);
    expect(() => requireDiskCapacity(11)).toThrow(/before copying 11 bytes: disk-guard need REFUSED/);
    expect(readFileSync(log, 'utf8')).toBe('5\n11\n');
  });

  it('rejects invalid estimates before invoking the tool', () => {
    for (const bytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => requireDiskCapacity(bytes)).toThrow('Cannot estimate disk growth');
    }
    expect(existsSync(log)).toBe(false);
  });

  it('fails closed for a missing or failing admission executable', () => {
    vi.stubEnv('HOME', join(root, 'empty'));
    vi.stubEnv('PATH', join(root, 'no-executables'));
    expect(() => requireDiskCapacity(1)).toThrow('Disk admission refused');
    vi.stubEnv('HOME', root);
    writeFileSync(join(root, 'bin', 'disk-guard'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    expect(() => requireDiskCapacity(1)).toThrow('exit 7');
  });

  it('keeps ordinary engine file and tree copies independent of disk-guard', () => {
    // This tool would reject either copy. It must never be invoked here.
    installDiskGuardFixture(root, 0);
    const source = join(root, 'source'), target = join(root, 'target');
    mkdirSync(source);
    writeFileSync(join(source, 'input'), 'independent input');
    copyFileSync(join(source, 'input'), target, constants.COPYFILE_EXCL);
    cpSync(source, join(root, 'tree'), { recursive: true });
    expect(readFileSync(target, 'utf8')).toBe('independent input');
    expect(readFileSync(join(root, 'tree', 'input'), 'utf8')).toBe('independent input');
    writeFileSync(join(source, 'input'), 'changed');
    expect(() => copyFileSync(join(source, 'input'), target, constants.COPYFILE_EXCL)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('independent input');
    expect(existsSync(log)).toBe(false);
    // A missing tool must not add a new failure mode to these paths either.
    vi.stubEnv('HOME', join(root, 'empty'));
    vi.stubEnv('PATH', join(root, 'no-executables'));
    copyFileSync(target, join(root, 'without-tool'));
    cpSync(source, join(root, 'tree-without-tool'), { recursive: true });
  });
});
