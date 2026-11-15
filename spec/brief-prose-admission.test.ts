import './test-support/policy-runtime.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefDeclarationFailures, inspectBrief } from '../src/brief-preflight.js';
import { rehearseBrief, rehearsalExitCode } from '../src/rehearse.js';
import { captureTerminalReceiptBaselines, evaluateTerminalFloor, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import type { StoreState } from '../src/store.js';

function staticRehearsal(brief: string) {
  const root = mkdtempSync(join(tmpdir(), 'brief-prose-'));
  try {
    const project = join(root, 'project');
    const fcHome = join(root, 'fc');
    mkdirSync(project);
    mkdirSync(fcHome);
    const briefPath = join(root, 'brief.md');
    writeFileSync(briefPath, brief);
    return spawnSync(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'rehearse', briefPath, '--static-only', '--project', project], {
      cwd: project,
      env: { ...process.env, HOME: root, FC_HOME: fcHome, FLOWCREW_DAEMON_SOCKET: join(fcHome, 'daemon.sock'), TMPDIR: root },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Scrubbed historical wording: admission follows declared contracts even when
// prose describes statistics, implementation instruments, or frozen rules.
describe('brief prose admission', () => {
  it.each([
    'Figures quoted above are context, not thresholds, except the ones named as\ncriteria in the metric section.',
    '每一个会执行 build 或 test 的阶段，其声明的写范围**必须**包含 `.cache/**`、`dist/**`、`.vitest/**` 和 `.flowcrew-build-manifest.json`。',
    '6. **不写 operator 的真实账本，不写任何声明输入。** 可观察的性质是：跑完整个测试套件后，`records/`、`history/` 和 `.cache/` 顶层文件逐字节不变，且这一点不依赖调用方是否导出了 `APP_STATE_DIR`。现有 `tests/app/conftest.py` 的会话级哈希守卫就是检验这一性质的仪器，这个守卫本身属于判据，必须保留。不设该变量时，所有模块使用原生产路径，行为与合并基线一致。',
    'Pre-register the selection rule before measuring outcomes.',
  ])('accepts a declared contract with descriptive wording: %s', prose => {
    const brief = `---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Report the measured result.\"}]\noutputs: [docs/report.md]\n---\n# Goal\n${prose}\n\n## Criteria\n1. Report the measured result.\n`;
    const report = inspectBrief(brief);
    expect(staticRehearsal(brief).status).toBe(0);
    expect(report.contractReady).toBe(true);
    expect(rehearsalExitCode(report.findings.map(finding => ({ level: finding.level, text: finding.message })))).toBe(0);
    for (const code of ['headline_distribution_missing', 'criterion_instrument_wording', 'preregistration_feasibility_missing']) {
      expect(report.findings.map(finding => finding.code)).not.toContain(code);
    }
  });

  it.each([
    'Implement operator cutover: deploy between hands and report criteria 1–4.',
    'The operator supplied an expected result of -112.89 bps.',
  ])('rehearses prose expectations without semantic findings: %s', prose => {
    const brief = `---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Report the independently measured result.\"}]\noutputs: [docs/report.md]\n---\n# Goal\n${prose}\n\n## Criteria\n1. Report the independently measured result.\n`;
    const report = inspectBrief(brief);
    expect(report.contractReady).toBe(true);
    expect(report.findings.some(finding => finding.level === 'fail')).toBe(false);
    expect(report.findings.some(finding => finding.level === 'warn')).toBe(true);
    expect(staticRehearsal(brief).status).toBe(0);
  });

  it('rejects a research ship target already crossed by its declared baseline', () => {
    // Historical baseline replay; this was not a recorded interception.
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Report measured research evidence.\"}]\nresearch:\n  baseline: 0.1457\n  higher_is_better: true\n  stop:\n    beat: 0.05\n---\n## Criteria\n1. Report measured research evidence.\n";
    const report = inspectBrief(brief);
    expect(staticRehearsal(brief).status).toBe(1);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'frontmatter_invalid', level: 'fail' }));
    expect(rehearsalExitCode(report.findings.map(finding => ({ level: finding.level, text: finding.message })))).toBe(1);
  });

  it.each([
    ['complete', 'result.md', './stage_*_verdict.md'],
    ['complete', 'docs/task_summary.md', 'docs/stage_*_verdict.md'],
    ['ceiling_hit', 'docs/task_summary.md', 'docs/stage_*_verdict.md'],
  ])('admits an inferred %s receipt floor for %s through rehearsal and launch', async (status, path, glob) => {
    const brief = `---\nterminal_states:\n  ${status}:\n    paths: [${path}]\n    floor:\n      min_attempted_stages: 1\n---\nProduce a summary.\n`;
    const root = mkdtempSync(join(tmpdir(), 'inferred-receipt-'));
    try {
      mkdirSync(join(root, 'docs'));
      const report = inspectBrief(brief);
      expect(report.findings).not.toContainEqual(expect.objectContaining({ code: `terminal_floor_uncountable_${status}` }));
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: `terminal_state_${status}`, level: 'ok', message: expect.stringContaining(`stage_glob=${glob}`),
      }));
      expect(briefDeclarationFailures(brief, report)).toEqual([]);
      const rehearsal = await rehearseBrief(['brief.md', '--static-only', '--project', root], { briefText: brief, render: false });
      expect(rehearsal.findings).toContainEqual(expect.objectContaining({ code: `terminal_state_${status}`, level: 'ok' }));
      expect(rehearsal.exitCode).toBe(0);
      expect(rehearsal.preflight.contractReady).toBe(true);

      // Admission accepts the inferred contract; runtime still requires fresh
      // nonempty evidence rather than merely the terminal summary artifact.
      const entry = parseBriefFrontmatter(brief).terminalStates![status as 'complete' | 'ceiling_hit']!;
      const receipt = join(root, glob.replace('*', 'one'));
      writeFileSync(receipt, 'old evidence');
      const state = { startedAt: '2026-01-01T00:00:00.000Z',
        terminalReceiptBaselines: captureTerminalReceiptBaselines(root, [entry]) } as StoreState;
      expect(evaluateTerminalFloor(state, entry, root)).toMatchObject({ passed: false,
        reason: expect.stringContaining(`match inferred stage_glob '${glob}'; 1 matching file(s) have unchanged launch content; need 1`) });
      writeFileSync(receipt, '');
      expect(evaluateTerminalFloor(state, entry, root)).toMatchObject({ passed: false,
        reason: expect.stringContaining('only 0 fresh stage verdict file(s)') });
      writeFileSync(receipt, 'new measured evidence');
      expect(evaluateTerminalFloor(state, entry, root)).toEqual({ passed: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a malformed stage floor through the shared declaration rule', async () => {
    const brief = '---\nterminal_states:\n  complete:\n    paths: [result.md]\n    floor: {min_attempted_stages: -1}\n---\nProduce a summary.';
    const report = inspectBrief(brief);
    expect(briefDeclarationFailures(brief, report)).toContainEqual(expect.objectContaining({
      code: 'frontmatter_invalid', level: 'fail', keyPath: 'terminal_states.complete.floor.min_attempted_stages',
    }));
    const root = mkdtempSync(join(tmpdir(), 'invalid-receipt-'));
    try {
      const rehearsal = await rehearseBrief(['brief.md', '--static-only', '--project', root], { briefText: brief, render: false });
      expect(rehearsal.findings).toContainEqual(expect.objectContaining({ code: 'frontmatter_invalid', level: 'fail' }));
      expect(rehearsal.exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an explicit stage_glob without inferring a writer from prose', () => {
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Produce a summary.\"}]\nterminal_states:\n  complete:\n    paths: [docs/task_summary.md]\n    stage_glob: docs/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 3\n---\n## Criteria\n1. Produce a summary.\n";
    expect(inspectBrief(brief).findings.some(entry => entry.code.startsWith('terminal_floor_uncountable_'))).toBe(false);
    expect(staticRehearsal(brief).status).toBe(0);
  });

  it('requires migration before interpreting legacy research ceiling floors', () => {
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Report measured evidence.\"}]\nresearch:\n  baseline: 0\n  higher_is_better: true\n  stop:\n    beat: 1\nterminal_states:\n  ceiling_hit:\n    paths: [docs/ceiling.md]\n    floor:\n      min_attempted_stages: 3\n---\n## Criteria\n1. Report measured evidence.\n";
    expect(inspectBrief(brief).findings.some(entry => entry.code === 'frontmatter_invalid')).toBe(true);
    expect(staticRehearsal(brief).status).toBe(1);
  });

  it('rejects malformed frontmatter', () => {
    const brief = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Report evidence.\"}]\nresearch: [\n---\n## Criteria\n1. Report evidence.\n";
    const report = inspectBrief(brief);
    expect(staticRehearsal(brief).status).toBe(1);
    expect(report.frontmatter.status).toBe('invalid');
    expect(rehearsalExitCode(report.findings.map(finding => ({ level: finding.level, text: finding.message })))).toBe(1);
  });
});
