import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';

const roots: string[] = [];

function fixture(label: string): { projectDir: string; runDir: string } {
  const root = mkdtempSync(join(
    tmpdir(),
    `flowcrew-artifact-${label}-${randomBytes(4).toString('hex')}-`,
  ));
  roots.push(root);
  const projectDir = join(root, 'project');
  const runDir = join(root, 'run');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return { projectDir, runDir };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function auditReport(
  projectDir: string,
  runDir: string,
  reportPath: string,
  report: string,
) {
  write(join(projectDir, reportPath), report);
  return inspectStageArtifactContract({
    stageId: 'artifact-replay',
    template: `Write ${reportPath}.`,
    projectDir,
    runDir,
    writes: [reportPath],
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('8 — published replay commands are executed and measured', () => {
  it('refuses the recorded exit-zero replay when its selector exercises no test', () => {
    const { projectDir, runDir } = fixture('zero-executed');
    const target = 'spec/existing.test.cjs';
    const marker = join(projectDir, 'executed.marker');
    write(join(projectDir, target), [
      "const { test } = require('node:test');",
      "const { writeFileSync } = require('node:fs');",
      `test('must execute', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); throw new Error('selected failure'); });`,
      '',
    ].join('\n'));

    const audit = auditReport(
      projectDir,
      runDir,
      'reports/audit.md',
      `# Replay\n\nReplay command: \`node --test --test-name-pattern=never-selected ${target}\`\n`,
    );

    expect(existsSync(marker)).toBe(false);
    expect(audit.replayExecutions).toEqual([
      expect.objectContaining({
        command: `node --test --test-name-pattern=never-selected ${target}`,
        runner: 'node_test',
        status: 'failed',
        exitCode: 0,
        timedOut: false,
        collectedTests: 0,
        executedTests: 0,
        failedTests: 0,
      }),
    ]);
    expect(audit.violations).toEqual([
      expect.objectContaining({
        mention: target,
        reason: expect.stringContaining('collected zero tests'),
      }),
    ]);
  });

  it('keeps a genuine replay passing and the missing-target guard failing', () => {
    const { projectDir, runDir } = fixture('genuine-control');
    const target = 'spec/genuine.test.cjs';
    const marker = join(projectDir, 'genuine.marker');
    write(join(projectDir, target), [
      "const { test } = require('node:test');",
      "const { writeFileSync } = require('node:fs');",
      `test('genuine run', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });`,
      '',
    ].join('\n'));

    const passing = auditReport(
      projectDir,
      runDir,
      'reports/passing.md',
      `# Replay\n\n\`node --test ${target}\`\n`,
    );
    expect(existsSync(marker)).toBe(true);
    expect(passing.replayExecutions).toEqual([
      expect.objectContaining({ status: 'passed', exitCode: 0, collectedTests: 1, executedTests: 1 }),
    ]);
    expect(passing.violations).toEqual([]);

    const missingTarget = 'spec/missing.test.cjs';
    const missing = auditReport(
      projectDir,
      runDir,
      'reports/missing.md',
      `# Replay\n\n\`node --test ${missingTarget}\`\n`,
    );
    expect(missing.replayExecutions).toEqual([
      expect.objectContaining({ status: 'not_run', exitCode: null }),
    ]);
    expect(missing.violations).toEqual([
      expect.objectContaining({
        mention: missingTarget,
        reason: expect.stringContaining('no readable input file exists'),
      }),
    ]);
  });

  it('uses a project-contained Vitest entry point and never executes report shell operators', () => {
    const { projectDir, runDir } = fixture('bounded-grammar');
    const target = 'spec/vitest-pass.test.ts';
    write(join(projectDir, target), [
      "import { expect, it } from 'vitest';",
      "it('runs through the resolved Vitest CLI', () => expect(2 + 2).toBe(4));",
      '',
    ].join('\n'));
    const vitest = auditReport(
      projectDir,
      runDir,
      'reports/vitest.md',
      `# Replay\n\n\`npm exec vitest -- run ${target}\`\n`,
    );
    expect(vitest.replayExecutions).toEqual([
      expect.objectContaining({ runner: 'vitest', status: 'passed', collectedTests: 1, executedTests: 1 }),
    ]);
    expect(vitest.violations).toEqual([]);

    const shellMarker = join(projectDir, 'shell.marker');
    const rejected = auditReport(
      projectDir,
      runDir,
      'reports/shell.md',
      `# Replay\n\n\`node --test ${target} && node -e "require('node:fs').writeFileSync('${shellMarker}','ran')"\`\n`,
    );
    expect(existsSync(shellMarker)).toBe(false);
    expect(rejected.replayExecutions).toEqual([
      expect.objectContaining({ runner: 'unsupported', status: 'not_run', reason: 'shell operators are not accepted' }),
    ]);
    expect(rejected.violations).toEqual([
      expect.objectContaining({ mention: target, reason: expect.stringContaining('shell operators are not accepted') }),
    ]);
  }, 30_000);

  it('refuses a lexical in-project target whose symlink resolves outside the project', () => {
    const { projectDir, runDir } = fixture('symlink-escape');
    const outsideTarget = join(dirname(projectDir), 'outside.test.cjs');
    const marker = join(dirname(projectDir), 'outside.marker');
    write(outsideTarget, [
      "const { test } = require('node:test');",
      "const { writeFileSync } = require('node:fs');",
      `test('must stay outside', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));`,
      '',
    ].join('\n'));
    const target = 'spec/link.test.cjs';
    mkdirSync(dirname(join(projectDir, target)), { recursive: true });
    symlinkSync(outsideTarget, join(projectDir, target));

    const audit = auditReport(
      projectDir,
      runDir,
      'reports/symlink.md',
      `# Replay\n\n\`node --test ${target}\`\n`,
    );

    expect(existsSync(marker)).toBe(false);
    expect(audit.replayExecutions).toEqual([
      expect.objectContaining({
        status: 'not_run',
        reason: expect.stringContaining('resolves outside the project'),
      }),
    ]);
    expect(audit.violations).toEqual([
      expect.objectContaining({
        mention: target,
        reason: expect.stringContaining('resolves outside the project'),
      }),
    ]);
  });
});

describe('19 — lexical suffixes are not promoted into replay paths', () => {
  it('leaves the recorded precise suite-count sentence as prose', () => {
    const { projectDir, runDir } = fixture('suffix-prose');
    const report = [
      '# Suite inventory',
      '',
      'The published Vitest suite uses `.test.ts` (189 files); the other plausible `.spec.ts` suffix matches 0 files.',
      '',
    ].join('\n');
    const audit = auditReport(projectDir, runDir, 'reports/suffixes.md', report);

    expect(audit.obligations).toEqual([
      expect.objectContaining({ kind: 'prompt_artifact', mention: 'reports/suffixes.md' }),
    ]);
    expect(audit.replayExecutions).toEqual([]);
    expect(audit.violations).toEqual([]);
  });

  it('retains real dotfiles and explicit relative paths as executable targets', () => {
    const { projectDir, runDir } = fixture('path-classes');
    const dotfile = '.hidden.test.cjs';
    const relative = './spec/relative.test.cjs';
    const source = "const { test } = require('node:test'); test('runs', () => {});\n";
    write(join(projectDir, dotfile), source);
    write(join(projectDir, relative), source);
    const audit = auditReport(
      projectDir,
      runDir,
      'reports/paths.md',
      `# Replay\n\n\`node --test ${dotfile}\`\n\n\`node --test ${relative}\`\n`,
    );

    expect(audit.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'replay_command_target', mention: dotfile }),
      expect.objectContaining({ kind: 'replay_command_target', mention: relative }),
    ]));
    expect(audit.replayExecutions).toEqual([
      expect.objectContaining({ status: 'passed', executedTests: 1 }),
      expect.objectContaining({ status: 'passed', executedTests: 1 }),
    ]);
    expect(audit.violations).toEqual([]);
  });

  it('still treats a suffix used as an explicit replay argument as a missing target', () => {
    const { projectDir, runDir } = fixture('suffix-command');
    const audit = auditReport(
      projectDir,
      runDir,
      'reports/explicit.md',
      '# Replay\n\n`node --test .test.ts`\n',
    );

    expect(audit.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'replay_command_target', mention: '.test.ts' }),
    ]));
    expect(audit.violations).toEqual([
      expect.objectContaining({ mention: '.test.ts', reason: expect.stringContaining('no readable input file exists') }),
    ]);
  });
});
