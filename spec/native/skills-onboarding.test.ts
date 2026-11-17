import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '../..');
const installerPath = join(repositoryRoot, 'skills', 'install.sh');
const fixtureRoots: string[] = [];

function installedSkillSource(name: string): string {
  return readFileSync(join(repositoryRoot, 'skills', `${name}.md`), 'utf8')
    .replaceAll('](../guide/', '](references/');
}

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
  writeFileSync(join(fixture.bin, 'package.json'), JSON.stringify({ type: 'module' }));
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
    "  killSignal: 'SIGKILL',",
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
    "if (process.argv[2] !== 'app-server') process.exit(0);",
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
    timeout: 40_000, killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
  });
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
      const claudeShip = join(fixture.home, '.claude', 'skills', 'ship', 'SKILL.md');
      const claudeStatus = join(fixture.home, '.claude', 'skills', 'fc-status', 'SKILL.md');
      if (setup.codex) {
        expect(output).toContain('Codex skills/list enumerated ship and fc-status');
        expect(output).toContain('✓ Codex skills installed and enumerated');
        expect(output).toContain('$ship');
        expect(readFileSync(codexShip, 'utf-8')).toBe(installedSkillSource('ship'));
        expect(readFileSync(codexStatus, 'utf-8')).toBe(installedSkillSource('fc-status'));
      } else {
        expect(output).toContain('Codex CLI not found; skipped');
        expect(output).not.toContain('✓ Codex skills installed');
        expect(existsSync(join(fixture.home, '.agents'))).toBe(false);
      }
      if (setup.claude) {
        expect(output).toContain('✓ Claude Code skills installed and byte-verified');
        expect(readFileSync(claudeShip, 'utf-8')).toBe(installedSkillSource('ship'));
        expect(readFileSync(claudeStatus, 'utf-8')).toBe(installedSkillSource('fc-status'));
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

  it('reports unfinished partial installation, retires its verifier, and completes on rerun', () => {
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

    expect(result.status, output).toBe(5);
    expect(elapsedMs).toBeLessThan(verificationTimeoutMs + 4_000);
    expect(output).toContain('Codex verification unfinished');
    expect(output).toContain('Completed: Codex skill bundles installed and byte-verified');
    expect(output).not.toContain('session hooks and manifest written');
    expect(output).toContain('Completed steps are preserved');
    expect(output).not.toContain('verification failed');
    expect(output).not.toContain('✓ Codex skills installed');
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
    const skillPath = join(fixture.home, '.agents/skills/ship/SKILL.md');
    const completed = readFileSync(skillPath, 'utf8');
    expect(existsSync(join(fixture.codexHome, 'hooks/flowcrew-session.json'))).toBe(false);
    expect(existsSync(join(fixture.codexHome, 'hooks.json'))).toBe(false);
    installFakeCodex(fixture);
    const retry = runInstaller(fixture, ['--codex']);
    expect(retry.status, `${retry.stdout}${retry.stderr}`).toBe(0);
    expect(retry.stdout).toContain('Codex skills/list enumerated ship and fc-status');
    expect(readFileSync(skillPath, 'utf8')).toEqual(completed);
    const repeated = runInstaller(fixture, ['--codex']);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(skillPath, 'utf8')).toEqual(completed);
  });

  it('uses supported project layouts without writing the disposable HOME', () => {
    const fixture = onboardingFixture();
    installFakeCodex(fixture);
    installFakeClaude(fixture);
    const result = runInstaller(fixture, ['--project'], fixture.project);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(existsSync(join(fixture.project, '.agents', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fixture.project, '.claude', 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fixture.home, '.agents'))).toBe(false);
    expect(existsSync(join(fixture.home, '.claude'))).toBe(false);
  });

  it('installs self-contained bundles with every relative link resolving and idempotently retires legacy Claude commands', () => {
    const fixture = onboardingFixture();
    installFakeClaude(fixture);
    installFakeCodex(fixture);
    const commands = join(fixture.home, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    for (const name of ['ship', 'fc-status']) writeFileSync(join(commands, `${name}.md`), 'legacy command\n');

    const install = () => {
      const result = runInstaller(fixture, ['--claude', '--codex', '--global']);
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    };
    const snapshot = () => {
      const files = new Map<string, string>();
      for (const agent of ['.claude', '.agents']) {
        for (const name of ['ship', 'fc-status']) {
          const root = join(fixture.home, agent, 'skills', name);
          const paths = readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
          expect(paths).toContain(join(root, 'SKILL.md'));
          const sourceSkill = readFileSync(join(repositoryRoot, 'skills', `${name}.md`), 'utf8');
          for (const [, guide] of sourceSkill.matchAll(/\]\(\.\.\/guide\/([^#)]+)/g)) {
            expect(paths).toContain(join(root, 'references', guide));
          }
          for (const path of paths) {
            const content = readFileSync(path, 'utf8');
            files.set(relative(fixture.home, path), content);
            // These documents use inline links; include reference-style destinations too.
            const destinations = [
              ...[...content.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/g)].map((match) => match[1]),
              ...[...content.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]),
            ];
            if (path === join(root, 'SKILL.md')) expect(destinations.length, path).toBeGreaterThan(0);
            for (const href of destinations) {
              if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
              const [file, anchor] = href.split('#');
              const target = file ? resolve(dirname(path), file) : path;
              expect(target.startsWith(root + sep), `${path}: ${href}`).toBe(true);
              expect(existsSync(target), `${path}: ${href}`).toBe(true);
              if (anchor) {
                const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)]
                  .map(([, heading]) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-'));
                expect(headings, `${path}: ${href}`).toContain(anchor);
              }
            }
          }
        }
      }
      return files;
    };
    install();
    for (const name of ['ship', 'fc-status']) expect(existsSync(join(commands, `${name}.md`))).toBe(false);
    const first = snapshot();
    install();
    expect(snapshot()).toEqual(first);
    for (const name of ['ship', 'fc-status']) expect(existsSync(join(commands, `${name}.md`))).toBe(false);
    const reference = join(fixture.home, '.claude', 'skills', 'ship', 'references', 'brief-contract.md');
    for (const corrupt of [() => writeFileSync(reference, 'locally changed\n'), () => rmSync(reference)]) {
      corrupt();
      install();
      expect(snapshot()).toEqual(first);
    }
  });
});
