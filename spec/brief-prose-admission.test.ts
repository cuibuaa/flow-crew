import './test-support/policy-runtime.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { rehearsalExitCode } from '../src/rehearse.js';

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
    const brief = `---\noutputs: [docs/report.md]\n---\n# Goal\n${prose}\n\n## Criteria\n1. Report the measured result.\n`;
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
  ])('rehearses undeclared prose expectations with warnings only: %s', prose => {
    const brief = `---\noutputs: [docs/report.md]\n---\n# Goal\n${prose}\n\n## Criteria\n1. Report the independently measured result.\n`;
    const report = inspectBrief(brief);
    expect(report.contractReady).toBe(true);
    expect(report.findings.some(finding => finding.level === 'fail')).toBe(false);
    expect(report.findings.some(finding => finding.level === 'warn')).toBe(true);
    expect(staticRehearsal(brief).status).toBe(0);
  });

  it.each([
    '',
    'Require `within_expected_range`.',
    'Require `method_was_not_adjusted_to_match_expectation`.',
    'Do not include `within_expected_range` or `method_was_not_adjusted_to_match_expectation`.',
  ])('refuses declared supplied numbers unless both fields are required: %s', requirement => {
    const brief = `---\nsupplied_numbers: [0, -112.89, 226.69]\noutputs: [docs/report.md]\n---\n## Criteria\n1. Report the independent calculation. ${requirement}\n`;
    expect(inspectBrief(brief).findings).toContainEqual(expect.objectContaining({
      code: 'operator_figure_anti_anchoring_missing', level: 'fail',
    }));
    expect(staticRehearsal(brief).status).toBe(1);
  });

  it.each([
    '["12"]',
    '12',
    '"12"',
    '{expected: 12}',
    'null',
    '',
    'true',
    '[12, "13"]',
    '[null]',
    '[[12]]',
    '[.inf]',
    '[-.inf]',
    '[.nan]',
  ])('refuses malformed supplied_numbers: %s', declaration => {
    const brief = `---\nsupplied_numbers: ${declaration}\noutputs: [docs/report.md]\n---\n## Criteria\n1. Require \`within_expected_range\` and \`method_was_not_adjusted_to_match_expectation\`.\n`;
    const report = inspectBrief(brief);
    const finding = report.findings.find(entry => entry.code === 'supplied_numbers_invalid');
    expect(finding).toMatchObject({ level: 'fail', consequential: true });
    expect(finding?.message).toContain('`supplied_numbers` must be an array of finite YAML numbers');
    expect(report.contractReady).toBe(false);
    const rehearsal = staticRehearsal(brief);
    expect(rehearsal.status).toBe(1);
    expect(rehearsal.stdout).toContain(finding?.message);
  });

  it('rejects a research ship target already crossed by its declared baseline', () => {
    // Historical baseline replay; this was not a recorded interception.
    const brief = '---\nresearch:\n  baseline: 0.1457\n  higher_is_better: true\n  stop:\n    beat: 0.05\n---\n## Criteria\n1. Report measured research evidence.\n';
    const report = inspectBrief(brief);
    expect(staticRehearsal(brief).status).toBe(1);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'research_ship_target_already_crossed', level: 'fail' }));
    expect(rehearsalExitCode(report.findings.map(finding => ({ level: finding.level, text: finding.message })))).toBe(1);
  });

  it.each(['complete', 'ceiling_hit'])('rejects a %s stage-count floor without an explicit stage_glob', status => {
    const brief = `---\nterminal_states:\n  ${status}:\n    paths: [docs/task_summary.md]\n    floor:\n      min_attempted_stages: 3\n---\n## Criteria\n1. Produce a summary.\n`;
    const report = inspectBrief(brief);
    const finding = report.findings.find(entry => entry.code === `terminal_floor_uncountable_${status}`);
    expect(finding).toMatchObject({ level: 'fail', consequential: true });
    expect(finding?.message).toContain('docs/stage_*_verdict.md');
    expect(report.contractReady).toBe(false);
    const rehearsal = staticRehearsal(brief);
    expect(rehearsal.status).toBe(1);
    expect(rehearsal.stdout).toContain(finding?.message);
    expect(rehearsalExitCode(report.findings.map(entry => ({ level: entry.level, text: entry.message })))).toBe(1);
  });

  it('accepts an explicit stage_glob without inferring a writer from prose', () => {
    const brief = '---\nterminal_states:\n  complete:\n    paths: [docs/task_summary.md]\n    stage_glob: docs/stage_*_verdict.md\n    floor:\n      min_attempted_stages: 3\n---\n## Criteria\n1. Produce a summary.\n';
    expect(inspectBrief(brief).findings.some(entry => entry.code.startsWith('terminal_floor_uncountable_'))).toBe(false);
    expect(staticRehearsal(brief).status).toBe(0);
  });

  it('keeps research ceiling floors counted by measured rounds', () => {
    const brief = '---\nresearch:\n  baseline: 0\n  higher_is_better: true\n  stop:\n    beat: 1\nterminal_states:\n  ceiling_hit:\n    paths: [docs/ceiling.md]\n    floor:\n      min_attempted_stages: 3\n---\n## Criteria\n1. Report measured evidence.\n';
    expect(inspectBrief(brief).findings.some(entry => entry.code.startsWith('terminal_floor_uncountable_'))).toBe(false);
    expect(staticRehearsal(brief).status).toBe(0);
  });

  it('rejects malformed frontmatter', () => {
    const brief = '---\nresearch: [\n---\n## Criteria\n1. Report evidence.\n';
    const report = inspectBrief(brief);
    expect(staticRehearsal(brief).status).toBe(1);
    expect(report.frontmatter.status).toBe('invalid');
    expect(rehearsalExitCode(report.findings.map(finding => ({ level: finding.level, text: finding.message })))).toBe(1);
  });
});
