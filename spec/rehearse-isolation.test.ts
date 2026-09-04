import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const helloBrief = join(repositoryRoot, 'examples', 'hello-research.brief.md');
const fixtureRoots: string[] = [];

interface RehearsalFixture {
  root: string;
  home: string;
  fcHome: string;
  codexHome: string;
  temp: string;
  project: string;
}

function rehearsalFixture(): RehearsalFixture {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-rehearse-isolation-${randomBytes(4).toString('hex')}-`));
  fixtureRoots.push(root);
  const fixture = {
    root,
    home: join(root, 'home'),
    fcHome: join(root, 'fc-home'),
    codexHome: join(root, 'codex-home'),
    temp: join(root, 'tmp'),
    project: join(root, 'project'),
  };
  for (const path of [fixture.home, fixture.fcHome, fixture.codexHome, fixture.temp, fixture.project]) {
    mkdirSync(path, { recursive: true });
  }
  return fixture;
}

function runRehearsal(
  fixture: RehearsalFixture,
  briefPath: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, 'dist', 'cli.js'), 'rehearse', briefPath],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...extraEnv,
        HOME: fixture.home,
        FC_HOME: fixture.fcHome,
        CODEX_HOME: fixture.codexHome,
        TMPDIR: fixture.temp,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rehearsal Git isolation', () => {
  it('ignores signing, hook, template, config and repository controls inherited from the caller', { timeout: 100_000 }, () => {
    const fixture = rehearsalFixture();
    const missing = join(fixture.root, 'does-not-exist');
    writeFileSync(join(fixture.home, '.gitconfig'), [
      '[commit]',
      '  gpgsign = true',
      '[user]',
      '  signingkey = definitely-missing-key',
      '[gpg]',
      `  program = ${missing}`,
      '[core]',
      `  hooksPath = ${missing}`,
      '',
    ].join('\n'), 'utf-8');

    const result = runRehearsal(fixture, helloBrief, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: missing,
      GIT_CONFIG_GLOBAL: join(fixture.home, '.gitconfig'),
      GIT_CONFIG_SYSTEM: join(fixture.home, '.gitconfig'),
      GIT_TEMPLATE_DIR: missing,
      GIT_DIR: missing,
      GIT_WORK_TREE: missing,
      GIT_INDEX_FILE: missing,
      GIT_OBJECT_DIRECTORY: missing,
      GIT_EXEC_PATH: missing,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain('✅ Contract ready');
    expect(output).toContain('0 tokens');
    expect(output).not.toContain('gpg failed');
    expect(output).not.toContain('Buffer <');
    expect(output).not.toContain('at cmdRehearse');
  });

  it('keeps the caller project and FC home untouched and removes temporary run repositories', { timeout: 100_000 }, () => {
    const fixture = rehearsalFixture();
    const brief = join(fixture.project, 'brief.md');
    const sentinel = join(fixture.project, 'sentinel.txt');
    const briefSource = readFileSync(helloBrief, 'utf-8');
    writeFileSync(brief, briefSource, 'utf-8');
    writeFileSync(sentinel, 'unchanged\n', 'utf-8');

    const result = runRehearsal(fixture, brief);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain('✅ Contract ready');
    expect(output).toContain('0 tokens');
    expect(readFileSync(brief, 'utf-8')).toBe(briefSource);
    expect(readFileSync(sentinel, 'utf-8')).toBe('unchanged\n');
    expect(readdirSync(fixture.project).sort()).toEqual(['brief.md', 'sentinel.txt']);
    expect(readdirSync(fixture.fcHome)).toEqual([]);
    const tempEntries = readdirSync(fixture.temp);
    expect(tempEntries.some((entry) => entry.startsWith('fc-rehearse-home-'))).toBe(false);
    expect(tempEntries.some((entry) => entry.startsWith('fc-rehearse-proj-'))).toBe(false);
    expect(tempEntries.some((entry) => entry.startsWith('flowcrew-rehearse-diagnostics-'))).toBe(true);
  });

  it('turns a real Git setup failure into a concise report with executable next steps', { timeout: 100_000 }, () => {
    const fixture = rehearsalFixture();
    const bin = join(fixture.root, 'broken-git-bin');
    mkdirSync(bin, { recursive: true });
    const git = join(bin, 'git');
    writeFileSync(git, `#!${process.execPath}\nprocess.exit(73);\n`, 'utf-8');
    chmodSync(git, 0o755);

    const result = runRehearsal(fixture, helloBrief, { PATH: bin });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('Git could not create the isolated temporary repository (git exit 73).');
    expect(output).toContain('Next: git --version');
    expect(output).toContain(`Static fallback: flowcrew rehearse '${helloBrief}' --static-only`);
    expect(output).toContain('❌ 1 contract problem');
    expect(output).not.toContain('Buffer <');
    expect(output).not.toContain('at cmdRehearse');
    expect(output).not.toMatch(/\n\s+at\s+/);
  });

  it('simulates a research brief with canonical numbered criteria through a criterion-aware gate', { timeout: 100_000 }, () => {
    const fixture = rehearsalFixture();
    const brief = join(fixture.project, 'criteria-research.md');
    const source = readFileSync(helloBrief, 'utf-8').replace(
      '## Round contract',
      '## What the report must show\n\n1. Report the measured count and the direct command evidence.\n\n## Round contract',
    );
    writeFileSync(brief, source, 'utf-8');

    const result = runRehearsal(fixture, brief, { PROJECT_DIR: fixture.project });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain('✅ Contract ready');
    expect(output).toContain('0 tokens');
    expect(output).not.toContain('criterion_');
    expect(output).not.toContain('dispatch');
  });

  it('rejects an occupied declared output before simulation', { timeout: 100_000 }, () => {
    const fixture = rehearsalFixture();
    const brief = join(fixture.project, 'occupied-output.md');
    const resultPath = join(fixture.project, 'docs', 'hello-research', 'round_result.json');
    mkdirSync(join(fixture.project, 'docs', 'hello-research'), { recursive: true });
    writeFileSync(resultPath, 'x'.repeat(286 * 1024));
    writeFileSync(brief, readFileSync(helloBrief, 'utf-8'), 'utf-8');

    const result = runRehearsal(fixture, brief, { PROJECT_DIR: fixture.project });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('Declared output docs/hello-research/round_result.json is already occupied');
    expect(output).toContain(`${286 * 1024} bytes`);
    expect(output).toContain('❌');
  });
});
