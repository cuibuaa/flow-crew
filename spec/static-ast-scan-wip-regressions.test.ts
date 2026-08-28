import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAllChecks } from '../src/reality-gate/index.js';
import type { CheckContext, CheckDecl } from '../src/reality-gate/types.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanSourceUrl = pathToFileURL(join(
  repositoryRoot,
  'src',
  'reality-gate',
  'checks',
  'static-ast-scan.ts',
)).href;

let projectDir: string;
let taskDir: string;
let cleanupRoots: string[];

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'static-scan-wip-project-'));
  taskDir = mkdtempSync(join(tmpdir(), 'static-scan-wip-task-'));
  cleanupRoots = [projectDir, taskDir];
});

afterEach(() => {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

function context(): CheckContext {
  return { projectDir, taskDir };
}

function write(root: string, relativePath: string, text: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
  return path;
}

function declaration(glob: string, forbidPattern = 'forbidden'): CheckDecl {
  return {
    name: `scan ${glob}`,
    type: 'static-ast-scan',
    params: { glob, language: 'typescript', forbid_pattern: forbidPattern },
  };
}

describe('bounded static scan traversal regressions', () => {
  it('F06 ignores an excluded symlink cycle instead of failing a focused gate', async () => {
    write(projectDir, 'spec/fc-tasks.test.ts', 'const clean = true;\n');
    symlinkSync(join(projectDir, 'spec'), join(projectDir, 'spec', 'unrelated-loop'), 'dir');

    const result = await runAllChecks([declaration('spec/*fc-tasks*.test.ts')], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('F06 never follows directory or file symlinks to content outside the selected anchor', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'static-scan-wip-outside-'));
    cleanupRoots.push(outside);
    write(projectDir, 'src/real.ts', 'const clean = true;\n');
    write(outside, 'escaped.ts', 'const value = "forbidden";\n');
    write(outside, 'file-target.ts', 'const value = "forbidden";\n');
    symlinkSync(outside, join(projectDir, 'src', 'linked-outside'), 'dir');
    symlinkSync(join(outside, 'file-target.ts'), join(projectDir, 'src', 'linked-file.ts'), 'file');

    const result = await runAllChecks([declaration('src/**/*.ts')], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('F09 resolves an exact top-level task artifact through project-first task fallback', async () => {
    mkdirSync(join(projectDir, 'verification.md'));
    write(taskDir, 'verification.md', 'verified and clean\n');

    const result = await runAllChecks([declaration('verification.md')], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('F12 uses the matcher grammar when deriving the root for a question-mark glob', async () => {
    write(projectDir, 'src/a/file.ts', 'const clean = true;\n');

    const result = await runAllChecks([declaration('src/?/file.ts')], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('QA04 uses the matcher grammar when an extglob appears in a directory component', async () => {
    write(projectDir, 'src/a/file.ts', 'const clean = true;\n');

    const result = await runAllChecks([declaration('src/@(a|b)/*.ts')], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('preserves slash-bearing brace alternatives while pruning candidate directories', async () => {
    write(projectDir, 'src/a/b/file.ts', 'const clean = true;\n');

    const result = await runAllChecks([
      declaration('src/{a/b,c}/file.ts'),
    ], context());
    expect(result.pass).toBe(true);
    expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
  });

  it('QA05 refuses explicit absolute and parent-relative globs outside both configured anchors', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'static-scan-wip-explicit-outside-'));
    cleanupRoots.push(outside);
    const escaped = write(outside, 'escaped.ts', 'const secret = "forbidden";\n');
    const absolute = await runAllChecks([declaration(escaped)], context());
    const relativeEscape = await runAllChecks([
      declaration(join('..', basename(outside), 'escaped.ts')),
    ], context());

    for (const result of [absolute, relativeEscape]) {
      expect(result.pass).toBe(false);
      const evidence = result.results[0].evidence as { findings?: unknown[] } | undefined;
      expect(evidence?.findings ?? []).toEqual([]);
    }
  });

  it('QA06 does not enter an excluded unreadable subtree for a nonrecursive glob', async () => {
    write(projectDir, 'spec/clean.test.ts', 'const clean = true;\n');
    const unreadable = join(projectDir, 'spec', 'excluded');
    mkdirSync(unreadable);
    chmodSync(unreadable, 0);
    try {
      const result = await runAllChecks([declaration('spec/*.test.ts')], context());
      expect(result.pass).toBe(true);
      expect(result.results[0].evidence).toMatchObject({ filesScanned: 1, findings: [] });
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });

  it('QA09 refuses a file symlink swap between candidate classification and read', () => {
    const outside = mkdtempSync(join(tmpdir(), 'static-scan-wip-swap-outside-'));
    cleanupRoots.push(outside);
    const benign = write(projectDir, 'src/benign.ts', 'const clean = true;\n');
    const escaped = write(outside, 'escaped.ts', 'const secret = "forbidden";\n');
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, projectDir, taskDir, benign, escaped] = process.argv.slice(1);
      const originalReadFile = fs.readFileSync;
      const originalOpen = fs.openSync;
      let swapped = false;
      const swap = () => {
        if (!swapped) {
          swapped = true;
          fs.unlinkSync(benign);
          fs.symlinkSync(escaped, benign, 'file');
        }
      };
      fs.readFileSync = (...args) => { if (String(args[0]) === benign) swap(); return originalReadFile(...args); };
      fs.openSync = (...args) => { if (String(args[0]) === benign) swap(); return originalOpen(...args); };
      syncBuiltinESMExports();
      const { default: StaticAstScanCheck } = await import(moduleUrl);
      const result = await new StaticAstScanCheck().run(
        { glob: 'src/*.ts', language: 'typescript', forbid_pattern: 'forbidden' },
        { projectDir, taskDir },
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', source,
      scanSourceUrl, projectDir, taskDir, benign, escaped,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: projectDir,
        FC_HOME: join(taskDir, 'fc-home'),
        NODE_NO_WARNINGS: '1',
      },
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      pass: boolean;
      evidence?: { findings?: unknown[] };
    };
    expect(result.pass).toBe(false);
    expect(result.evidence?.findings ?? []).toEqual([]);
  });

  it('QA10 bounds candidate enumeration before a large matching directory can exhaust the process', { timeout: 20_000 }, () => {
    const sourceDirectory = join(projectDir, 'many');
    mkdirSync(sourceDirectory);
    for (let index = 0; index < 100_000; index += 1) {
      writeFileSync(join(sourceDirectory, `${index}.ts`), '');
    }
    const source = `
      const { default: StaticAstScanCheck } = await import(process.argv[1]);
      const result = await new StaticAstScanCheck().run(
        { glob: 'many/*.ts', language: 'typescript', forbid_pattern: 'forbidden' },
        { projectDir: process.argv[2], taskDir: process.argv[3] },
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const control = spawnSync(process.execPath, [
      '--max-old-space-size=12', '--import', 'tsx', '--input-type=module', '-e',
      `const module = await import(process.argv[1]); process.stdout.write(typeof module.default);`,
      scanSourceUrl,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      env: { ...process.env, HOME: projectDir, FC_HOME: join(taskDir, 'fc-home') },
    });
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toBe('function');

    const child = spawnSync(process.execPath, [
      '--max-old-space-size=12', '--import', 'tsx', '--input-type=module', '-e', source,
      scanSourceUrl, projectDir, taskDir,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, HOME: projectDir, FC_HOME: join(taskDir, 'fc-home') },
    });
    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    const result = JSON.parse(child.stdout) as { pass: boolean; details: string };
    expect(typeof result.pass).toBe('boolean');
    expect(result.details.trim()).not.toBe('');
  });

  it('QA11 caps stored findings and computes line numbers without quadratic rescanning', { timeout: 10_000 }, () => {
    write(projectDir, 'src/many-hits.ts', 'x\n'.repeat(20_000));
    const source = `
      const { default: StaticAstScanCheck } = await import(process.argv[1]);
      const result = await new StaticAstScanCheck().run(
        { glob: 'src/*.ts', language: 'typescript', forbid_pattern: 'x' },
        { projectDir: process.argv[2], taskDir: process.argv[3] },
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, [
      '--max-old-space-size=64', '--import', 'tsx', '--input-type=module', '-e', source,
      scanSourceUrl, projectDir, taskDir,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
      timeout: 3_000,
      env: { ...process.env, HOME: projectDir, FC_HOME: join(taskDir, 'fc-home') },
    });

    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    const result = JSON.parse(child.stdout) as {
      pass: boolean;
      details: string;
      evidence?: { findings?: unknown[] };
    };
    expect(result.pass).toBe(false);
    expect(result.evidence?.findings?.length).toBeLessThan(20_000);
  });

  it('QA12 refuses an oversized candidate before allocating the whole file', async () => {
    write(projectDir, 'src/oversized.ts', 'x'.repeat(1024 * 1024 + 1));

    const result = await runAllChecks([declaration('src/*.ts')], context());
    expect(result.pass).toBe(false);
    expect(result.results[0].details).toMatch(/oversized|too large|byte limit/iu);
    expect(result.results[0].evidence).toMatchObject({ findings: [] });
  });
});
