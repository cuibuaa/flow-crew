import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
