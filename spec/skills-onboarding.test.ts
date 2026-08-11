import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const installerPath = join(repositoryRoot, 'skills', 'install.sh');
const fixtureRoots: string[] = [];

interface OnboardingFixture {
  root: string;
  home: string;
  fcHome: string;
  codexHome: string;
  temp: string;
  project: string;
  bin: string;
  runner: string;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf-8');
  chmodSync(path, 0o755);
}

function createToolbox(fixture: OnboardingFixture): void {
  const toolbox = join(fixture.root, 'toolbox.mjs');
  executable(toolbox, [
    `#!${process.execPath}`,
    "import { accessSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';",
    "import { basename, delimiter, join } from 'node:path';",
    "import process from 'node:process';",
    'const tool = basename(process.argv[1]);',
    'const args = process.argv.slice(2);',
    "if (tool === 'mkdir') {",
    "  for (const path of args.filter((arg) => arg !== '-p')) mkdirSync(path, { recursive: args.includes('-p') });",
    "} else if (tool === 'cp') {",
    '  copyFileSync(args.at(-2), args.at(-1));',
    "} else if (tool === 'cmp') {",
    "  const paths = args.filter((arg) => arg !== '-s');",
    '  process.exit(readFileSync(paths[0]).equals(readFileSync(paths[1])) ? 0 : 1);',
    "} else if (tool === 'which') {",
    '  const command = args[0];',
    '  for (const directory of (process.env.PATH || "").split(delimiter)) {',
    '    const candidate = join(directory, command);',
    '    try { accessSync(candidate, 1); process.stdout.write(candidate + "\\n"); process.exit(0); } catch {}',
    '  }',
    '  process.exit(1);',
    '} else {',
    '  process.stderr.write("unsupported fixture tool: " + tool + "\\n");',
    '  process.exit(2);',
    '}',
    '',
  ].join('\n'));
  for (const name of ['mkdir', 'cp', 'cmp', 'which']) {
    symlinkSync(toolbox, join(fixture.bin, name));
  }
}

function onboardingFixture(): OnboardingFixture {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-skills-${randomBytes(4).toString('hex')}-`));
  fixtureRoots.push(root);
  const fixture: OnboardingFixture = {
    root,
    home: join(root, 'home'),
    fcHome: join(root, 'fc-home'),
    codexHome: join(root, 'codex-home'),
    temp: join(root, 'tmp'),
    project: join(root, 'project'),
    bin: join(root, 'bin'),
    runner: join(root, 'run-command.mjs'),
  };
  for (const path of [
    fixture.home,
    fixture.fcHome,
    fixture.codexHome,
    fixture.temp,
    fixture.project,
    fixture.bin,
  ]) mkdirSync(path, { recursive: true });
  createToolbox(fixture);
  executable(fixture.runner, [
    `#!${process.execPath}`,
    "import { spawnSync } from 'node:child_process';",
    "import process from 'node:process';",
    'const [command, ...args] = process.argv.slice(2);',
    'const result = spawnSync(command, args, {',
    '  cwd: process.env.PROBE_CWD,',
    '  env: process.env,',
    "  encoding: 'utf8',",
    '  timeout: 30_000,',
    '  maxBuffer: 8 * 1024 * 1024,',
    '});',
    'if (result.stdout) process.stdout.write(result.stdout);',
    'if (result.stderr) process.stderr.write(result.stderr);',
    'if (result.error) process.stderr.write(result.error.message + "\\n");',
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n'));
  return fixture;
}

function installFakeClaude(fixture: OnboardingFixture): void {
  executable(join(fixture.bin, 'claude'), `#!${process.execPath}\nprocess.exit(0);\n`);
}

function installFakeCodex(fixture: OnboardingFixture, omit: string | undefined = undefined): void {
  executable(join(fixture.bin, 'codex'), [
    `#!${process.execPath}`,
    "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    "import { join, resolve } from 'node:path';",
    "import process from 'node:process';",
    "if (process.argv[2] !== 'app-server') process.exit(0);",
    'const listed = [];',
    'const addRoot = (root) => {',
    '  if (!existsSync(root)) return;',
    '  for (const entry of readdirSync(root, { withFileTypes: true })) {',
    '    if (!entry.isDirectory()) continue;',
    "    const path = join(root, entry.name, 'SKILL.md');",
    '    if (!existsSync(path)) continue;',
    "    const source = readFileSync(path, 'utf8');",
    "    const frontmatter = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(source)?.[1];",
    "    const name = frontmatter && /^name:\\s*(\\S+)\\s*$/m.exec(frontmatter)?.[1];",
    "    const description = frontmatter && /^description:\\s*(.+)\\s*$/m.exec(frontmatter)?.[1]?.trim();",
    `    if (name && description && name !== ${JSON.stringify(omit)}) listed.push({ name, path: resolve(path), enabled: true });`,
    '  }',
    '};',
    'const input = createInterface({ input: process.stdin });',
    'for await (const line of input) {',
    '  if (!line.trim()) continue;',
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    '    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
    "  } else if (message.method === 'skills/list') {",
    "    addRoot(join(process.env.HOME, '.agents', 'skills'));",
    "    for (const cwd of message.params?.cwds || []) addRoot(join(cwd, '.agents', 'skills'));",
    '    process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ skills: listed }] } }) + "\\n");',
    '  }',
    '}',
    '',
  ].join('\n'));
}

function installStubbornFakeCodex(fixture: OnboardingFixture): string {
  const pidFile = join(fixture.root, 'stubborn-codex.pid');
  executable(join(fixture.bin, 'codex'), [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs';",
    "import process from 'node:process';",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n", 'utf8');`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1_000);',
    '',
  ].join('\n'));
  return pidFile;
}

function runInstaller(
  fixture: OnboardingFixture,
  args: string[] = [],
  cwd = repositoryRoot,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [fixture.runner, installerPath, ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: fixture.home,
      FC_HOME: fixture.fcHome,
      CODEX_HOME: fixture.codexHome,
      TMPDIR: fixture.temp,
      PATH: fixture.bin,
      FLOWCREW_NODE: process.execPath,
      PROBE_CWD: cwd,
      NO_COLOR: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 40_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function prepareDoctorProject(fixture: OnboardingFixture): void {
  const config = join(fixture.project, 'config');
  const agents = join(config, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(config, 'defaults.yaml'), 'adapter: auto\n', 'utf-8');
  writeFileSync(join(agents, 'planner.yaml'), 'name: planner\nprompt: fixture\n', 'utf-8');
  writeFileSync(join(agents, '_base.md'), 'fixture base prompt\n', 'utf-8');
}

function runDoctor(fixture: OnboardingFixture, packageRoot = repositoryRoot) {
  prepareDoctorProject(fixture);
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'), 'doctor'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: fixture.home,
        FC_HOME: fixture.fcHome,
        CODEX_HOME: fixture.codexHome,
        TMPDIR: fixture.temp,
        PROJECT_DIR: fixture.project,
        PATH: fixture.bin,
        PORT: '65534',
        NO_COLOR: '1',
        FLOWCREW_DOCTOR_SKILL_ROOT: packageRoot,
      },
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FlowCrew skill installer', () => {
  const matrix = [
    { label: 'neither CLI', codex: false, claude: false },
    { label: 'Codex only', codex: true, claude: false },
    { label: 'Claude Code only', codex: false, claude: true },
    { label: 'both CLIs', codex: true, claude: true },
  ];

  for (const setup of matrix) {
    it(`reports and installs truthfully with ${setup.label}`, () => {
      const fixture = onboardingFixture();
      if (setup.codex) installFakeCodex(fixture);
      if (setup.claude) installFakeClaude(fixture);

      const result = runInstaller(fixture);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(0);

      const codexShip = join(fixture.home, '.agents', 'skills', 'ship', 'SKILL.md');
      const codexStatus = join(fixture.home, '.agents', 'skills', 'fc-status', 'SKILL.md');
      const claudeShip = join(fixture.home, '.claude', 'commands', 'ship.md');
      const claudeStatus = join(fixture.home, '.claude', 'commands', 'fc-status.md');
      if (setup.codex) {
        expect(output).toContain('Codex skills/list enumerated ship and fc-status');
        expect(output).toContain('✓ Codex skills installed and enumerated');
        expect(output).toContain('$ship');
        expect(readFileSync(codexShip, 'utf-8')).toBe(readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf-8'));
        expect(readFileSync(codexStatus, 'utf-8')).toBe(readFileSync(join(repositoryRoot, 'skills', 'fc-status.md'), 'utf-8'));
      } else {
        expect(output).toContain('Codex CLI not found; skipped');
        expect(output).not.toContain('✓ Codex skills installed');
        expect(existsSync(join(fixture.home, '.agents'))).toBe(false);
      }
      if (setup.claude) {
        expect(output).toContain('✓ Claude Code skills installed and byte-verified');
        expect(readFileSync(claudeShip, 'utf-8')).toBe(readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf-8'));
        expect(readFileSync(claudeStatus, 'utf-8')).toBe(readFileSync(join(repositoryRoot, 'skills', 'fc-status.md'), 'utf-8'));
      } else {
        expect(output).toContain('Claude Code CLI not found; skipped');
        expect(output).not.toContain('✓ Claude Code skills installed');
        expect(existsSync(join(fixture.home, '.claude'))).toBe(false);
      }
      if (!setup.codex && !setup.claude) {
        expect(output).toContain('No skills were installed because no requested agent CLI was found');
        expect(output).not.toContain('use /ship');
      }
    });
  }

  it('rejects an unknown flag with usage and a nonzero exit', () => {
    const fixture = onboardingFixture();
    const result = runInstaller(fixture, ['--codx']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain('Unknown option: --codx');
    expect(output).toContain('Usage: ./install.sh');
  });

  it('considers only the explicitly selected agent', () => {
    const fixture = onboardingFixture();
    installFakeClaude(fixture);
    const result = runInstaller(fixture, ['--codex']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('Codex CLI not found; skipped');
    expect(output).not.toContain('Claude Code');
    expect(existsSync(join(fixture.home, '.claude'))).toBe(false);
  });

  it('fails instead of claiming Codex success when skills/list omits an installed skill', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture, 'fc-status');
    const result = runInstaller(fixture, ['--codex']);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Codex did not enumerate fc-status');
    expect(output).toContain('installation was not reported as successful');
    expect(output).not.toContain('✓ Codex skills installed');
  });

  it('force-terminates a Codex verifier that ignores SIGTERM', () => {
    const fixture = onboardingFixture();
    const pidFile = installStubbornFakeCodex(fixture);
    // The PID write is the fake verifier's first action, but 100ms was still
    // shorter than process startup under the three-worker suite. One second
    // keeps the timeout behavior fast while making readiness observable.
    const verificationTimeoutMs = 1_000;
    const startedAt = Date.now();
    const result = runInstaller(
      fixture,
      ['--codex'],
      repositoryRoot,
      { FLOWCREW_CODEX_VERIFY_TIMEOUT_MS: String(verificationTimeoutMs) },
    );
    const elapsedMs = Date.now() - startedAt;
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(elapsedMs).toBeLessThan(verificationTimeoutMs + 4_000);
    expect(output).toContain('Codex skills/list timed out');
    expect(output).not.toContain('✓ Codex skills installed');
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('uses supported project layouts without writing the disposable HOME', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    installFakeClaude(fixture);
    const result = runInstaller(fixture, ['--project'], fixture.project);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(existsSync(join(fixture.project, '.agents', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fixture.project, '.claude', 'commands', 'ship.md'))).toBe(true);
    expect(existsSync(join(fixture.home, '.agents'))).toBe(false);
    expect(existsSync(join(fixture.home, '.claude'))).toBe(false);
  });
});

describe('skill manifests and doctor freshness', () => {
  it('gives both source skills enumerable frontmatter and a revision stamp', () => {
    const expected = new Map([
      ['ship.md', 'ship'],
      ['fc-status.md', 'fc-status'],
    ]);
    for (const [file, expectedName] of expected) {
      const source = readFileSync(join(repositoryRoot, 'skills', file), 'utf-8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
      expect(match, file).not.toBeNull();
      const metadata = parseYaml(match![1]) as Record<string, unknown>;
      expect(metadata.name).toBe(expectedName);
      expect(typeof metadata.description).toBe('string');
      expect((metadata.description as string).trim().length).toBeGreaterThan(0);
      const revision = /<!-- flowcrew-skill-revision: (\d+) -->/.exec(source)?.[1];
      expect(Number(revision)).toBeGreaterThan(0);
    }
  });

  it('uses the real invocation syntax for both agents wherever onboarding first asks users to ship', () => {
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
    const firstExample = readme.slice(0, readme.indexOf('**Most AI agents'));
    expect(firstExample).toContain('/ship');
    expect(firstExample).toContain('$ship');

    const ship = readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf8');
    expect(ship).toContain('`/ship <flag>` in Claude Code or `$ship <flag>` in Codex');
    expect(ship).not.toContain('If the user said `/ship');
    expect(ship).not.toMatch(/^- `\/ship --/m);
    expect(ship).not.toContain('npx flowcrew');
    expect(ship).not.toContain("npm install --global 'git+https://github.com/cuibuaa/flow-crew.git'");
    expect(ship).toContain('git clone https://github.com/cuibuaa/flow-crew.git && cd flow-crew && npm install && npm link');
  });

  it('warns for missing skills only when that agent is installed and gives a pasteable repair command', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    const result = runDoctor(fixture);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('Codex skills: missing ship, fc-status');
    expect(output).toContain(`bash '${installerPath}' --codex --global`);
    expect(output).not.toContain('Claude Code skills:');
    expect(output).not.toMatch(/✅\s+Codex skills:/);
  });

  it('does not add a skill warning for either absent agent', () => {
    const fixture = onboardingFixture();
    const result = runDoctor(fixture);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).not.toContain('Codex skills:');
    expect(output).not.toContain('Claude Code skills:');
  });

  it('reports exact global copies as current for both agents', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    installFakeClaude(fixture);
    const install = runInstaller(fixture);
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);

    const doctor = runDoctor(fixture);
    const output = `${doctor.stdout}${doctor.stderr}`;
    expect(output).toMatch(/✅\s+Codex skills: current repository copies found/);
    expect(output).toMatch(/✅\s+Claude Code skills: current repository copies found/);
  });

  it('detects an older installed revision and names the matching repair scope', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    const install = runInstaller(fixture, ['--codex']);
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);
    const installed = join(fixture.home, '.agents', 'skills', 'ship', 'SKILL.md');
    const source = readFileSync(installed, 'utf-8');
    const repositoryRevision = /flowcrew-skill-revision: (\d+)/.exec(source)?.[1];
    expect(repositoryRevision).toBeDefined();
    writeFileSync(
      installed,
      source.replace(`flowcrew-skill-revision: ${repositoryRevision}`, 'flowcrew-skill-revision: 0'),
      'utf-8',
    );

    const doctor = runDoctor(fixture);
    const output = `${doctor.stdout}${doctor.stderr}`;
    expect(output).toContain('ship (global) is outdated or locally changed');
    expect(output).toContain(`revision 0; repository revision ${repositoryRevision}`);
    expect(output).toContain(`bash '${installerPath}' --codex --global`);
    expect(output).not.toMatch(/✅\s+Codex skills:/);
  });

  it('keeps a stale project shadow visible even when global copies are current', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    expect(runInstaller(fixture, ['--codex']).status).toBe(0);
    const projectSkill = join(fixture.project, '.agents', 'skills', 'ship', 'SKILL.md');
    mkdirSync(join(fixture.project, '.agents', 'skills', 'ship'), { recursive: true });
    writeFileSync(projectSkill, '<!-- old local copy -->\n', 'utf-8');

    const doctor = runDoctor(fixture);
    const output = `${doctor.stdout}${doctor.stderr}`;
    expect(output).toContain('project install is incomplete (missing fc-status)');
    expect(output).toContain('ship (project) is outdated or locally changed');
    expect(output).toContain(`bash '${installerPath}' --codex --project`);
  });

  it('restores missing checkout sources without naming an unpublished registry package', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    const brokenPackageRoot = join(fixture.root, 'broken-package');
    mkdirSync(join(brokenPackageRoot, '.git'), { recursive: true });
    mkdirSync(join(brokenPackageRoot, 'skills'), { recursive: true });
    writeFileSync(join(brokenPackageRoot, 'package.json'), JSON.stringify({
      repository: { url: 'git+https://github.com/cuibuaa/flow-crew.git' },
    }), 'utf8');
    writeFileSync(join(brokenPackageRoot, 'skills', 'fc-status.md'), 'fixture\n', 'utf8');
    writeFileSync(join(brokenPackageRoot, 'skills', 'install.sh'), '#!/bin/bash\n', 'utf8');

    const doctor = runDoctor(fixture, brokenPackageRoot);
    const output = `${doctor.stdout}${doctor.stderr}`;
    expect(doctor.status, output).toBe(0);
    expect(output).toContain(`git -C '${brokenPackageRoot}' restore --source=HEAD -- 'skills/ship.md'`);
    expect(output).toContain(`bash '${join(brokenPackageRoot, 'skills', 'install.sh')}' --codex --global`);
    expect(output).not.toContain('npm i -g flowcrew');
  });
});
