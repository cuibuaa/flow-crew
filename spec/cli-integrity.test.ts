import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const fixtures: string[] = [];

function fixture(): { root: string; home: string; fcHome: string; temp: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-p10-cli-'));
  fixtures.push(root);
  const home = join(root, 'home');
  const fcHome = join(root, 'state');
  const temp = join(root, 'tmp');
  for (const path of [home, fcHome, temp]) mkdirSync(path, { recursive: true });
  return { root, home, fcHome, temp };
}

function rehearse(args: string[], env: { home: string; fcHome: string; temp: string }) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'), 'rehearse', ...args],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: env.home,
        FC_HOME: env.fcHome,
        TMPDIR: env.temp,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function diagnosticPath(stdout: string): string {
  const match = stdout.match(/^Engine diagnostics \(not part of the verdict\): (.+)$/m);
  if (!match) throw new Error(`Rehearsal output did not name its diagnostic log:\n${stdout}`);
  return match[1].trim();
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('rehearsal language and diagnostic integrity', () => {
  it('prints the complete hello-research report in English and retains pino diagnostics outside stdout', { timeout: 70_000 }, () => {
    const isolated = fixture();
    const result = rehearse(['examples/hello-research.brief.md'], isolated);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Rehearsal report');
    expect(result.stdout).toContain('Contract ready');
    expect(result.stdout).toContain('floor(stages≥1)');
    expect(result.stdout).not.toContain('≥-');
    expect(result.stdout).not.toMatch(/[\u3400-\u9fff]/u);
    expect(result.stdout).not.toMatch(/^\{"level":\d+/m);

    const path = diagnosticPath(result.stdout);
    expect(path.startsWith(isolated.temp)).toBe(true);
    expect(existsSync(path)).toBe(true);
    const diagnostics = readFileSync(path, 'utf-8');
    expect(diagnostics).toMatch(/^\{"level":\d+/m);
    expect(result.stderr).not.toMatch(/^\{"level":\d+/m);
  });

  it('still recognizes a Chinese instrument criterion while generating its warning in English', () => {
    const isolated = fixture();
    const brief = join(isolated.root, 'chinese-criteria.brief.md');
    const criterion = '源码里必须出现 `new JSDOM(...)`。';
    writeFileSync(brief, [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/result.md]',
      '---',
      '# 验收判据',
      criterion,
      '',
    ].join('\n'), 'utf-8');

    const result = rehearse([brief, '--static-only'], isolated);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(`Criteria lint at line 7: “${criterion}”`);
    expect(result.stdout).toContain('\n  Risk: This wording makes a specific implementation instrument mandatory');
    expect(result.stdout).toContain('This wording makes a specific implementation instrument mandatory');
    expect(result.stdout).toContain('\n  Suggestion: State the observable property to prove.');
    const generatedText = result.stdout
      .replace(criterion, '')
      .replace('# 验收判据', '');
    expect(generatedText).not.toMatch(/[\u3400-\u9fff]/u);
  });
});

describe('doctor tells port occupancy apart from your own dashboard', () => {
  // The probe cannot be exercised here — `spec/` may not open sockets or spawn servers
  // (see spec/purity.ts). Five branches were measured by hand against real listeners: this
  // install's dashboard, a non-FlowCrew server, a 404, a FlowCrew dashboard serving another
  // directory, and a pid whose cwd is unreadable. What is guarded here is that the
  // distinction still exists in the source, because the failure it replaced was a single
  // unconditional "FlowCrew server is running" for any response at all.
  const source = readFileSync(join(repositoryRoot, 'src', 'cli.ts'), 'utf-8');

  it('rejects a non-2xx response instead of counting it as a running server', () => {
    expect(source).toContain('res.statusCode < 200 || res.statusCode >= 300');
  });

  it('requires a FlowCrew-shaped payload before claiming a dashboard answered', () => {
    expect(source).toContain("does not answer as a FlowCrew dashboard");
  });

  it('names the other directory when the port belongs to a different install', () => {
    expect(source).toContain('for a different install');
  });

  it('says the install is unconfirmed rather than claiming it is this one', () => {
    expect(source).toContain('could not be confirmed');
  });

  it('no longer claims a bare "server is running" for whatever holds the port', () => {
    expect(source).not.toContain("message: 'FlowCrew server is running'");
  });
});
