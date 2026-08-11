import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditReportUsage, parseAuditReportArgs } from '../src/cli-audit-report.js';
import { createBriefAdmission, inspectBrief, verifyBriefAdmission } from '../src/brief-preflight.js';
import { landUsage, parseLandArgs } from '../src/cli-land.js';
import { parseShipSetupArgs, shipSetupUsage } from '../src/cli-ship-setup.js';
import { parseWatchArgs, watchUsage } from '../src/cli-watch.js';
import { projectBriefPreflightContext } from '../src/rehearse.js';

const repositoryRoot = join(import.meta.dirname, '..');
const cliSource = readFileSync(join(repositoryRoot, 'src', 'cli.ts'), 'utf-8');

describe('autonomous launch CLI integration', () => {
  it('advertises setup, wrap-up, audit, and watch commands with pasteable examples', () => {
    expect(cliSource).toContain('ship-setup  Create a launch worktree, link declared inputs, and baseline validation');
    expect(cliSource).toContain('land      Audit terminal artifacts and every unique worktree item before safe removal');
    expect(cliSource).toContain('audit-report  Re-derive supported numeric and path-bearing claims from a terminal report');
    expect(cliSource).toContain('watch     Report edge-triggered stall judgements for live runs');
    expect(cliSource).toContain('flowcrew ship-setup --brief docs/task_brief.md --target ../task-worktree --base HEAD --branch task-work');
    expect(cliSource).toContain('flowcrew land --run <run-id>');
    expect(cliSource).toContain('flowcrew audit-report --report docs/final.md --run-dir <run-dir>');
    expect(cliSource).toContain('flowcrew watch --once');
  });

  it('dispatches scoped command modules lazily and propagates their returned exit codes', () => {
    expect(cliSource).toContain("case 'ship-setup':");
    expect(cliSource).toContain("import('./cli-ship-setup.js').then(({ cmdShipSetup }) => cmdShipSetup(args))");
    expect(cliSource).toContain("case 'land':");
    expect(cliSource).toContain("import('./cli-land.js').then(({ cmdLand }) => cmdLand(args))");
    expect(cliSource).toContain("case 'audit-report':");
    expect(cliSource).toContain("import('./cli-audit-report.js').then(({ cmdAuditReport }) => cmdAuditReport(args))");
    expect(cliSource).toContain("case 'watch':");
    expect(cliSource).toContain("import('./cli-watch.js').then(({ cmdWatch }) => cmdWatch(args))");
    expect(cliSource.match(/\.then\(\(code\) => \{ process\.exitCode = code; \}\)/g)?.length)
      .toBeGreaterThanOrEqual(9);
    expect(cliSource).not.toMatch(/^import .*cli-(?:ship-setup|land|audit-report|watch)\.js/m);
  });

  it('keeps setup identity explicit and watch polling bounded at their public parsers', () => {
    expect(shipSetupUsage()).toContain('--brief <path> --target <path> --base <ref> --branch <name>');
    expect(() => parseShipSetupArgs(['ship-setup', '--brief', 'brief.md']))
      .toThrow('--target is required');
    expect(parseShipSetupArgs([
      'ship-setup',
      '--brief', 'brief.md',
      '--target', '../worktree',
      '--base', 'release',
      '--branch', 'result',
    ])).toMatchObject({ base: 'release', branch: 'result', target: '../worktree' });

    expect(watchUsage()).toContain('first-pass heartbeat and edge-triggered stall judgements');
    expect(parseWatchArgs(['watch', '--once', '--poll', '5'])).toMatchObject({ once: true, pollMs: 5_000 });
    expect(() => parseWatchArgs(['watch', '--poll', '0'])).toThrow('between 1 and 3600 seconds');
  });

  it('keeps land fail-closed and audit-report bound to an explicit report and run', () => {
    expect(landUsage()).toContain('--run <run-id> [--remove] [--json]');
    expect(parseLandArgs(['land', '--run', 'run-123', '--remove'])).toMatchObject({
      run: 'run-123', remove: true,
    });
    expect(() => parseLandArgs(['land', '--remove'])).toThrow('--run is required');

    expect(auditReportUsage()).toContain('--report <path> --run-dir <path> [--json]');
    expect(auditReportUsage()).toContain('confirmed, contradicted, or not_checkable');
    expect(parseAuditReportArgs([
      'audit-report', '--report', 'docs/final.md', '--run-dir', '/tmp/run', '--json',
    ])).toMatchObject({ report: 'docs/final.md', runDir: '/tmp/run', json: true });
    expect(() => parseAuditReportArgs(['audit-report', '--report', 'docs/final.md']))
      .toThrow('--run-dir is required');
  });

  it('binds ignored-input acknowledgement to exact project facts without host probes in the spec', () => {
    const brief = [
      '# Inputs',
      'Use `private-data/prices.csv` and `private-data/metadata.json` as source evidence.',
    ].join('\n');
    const firstContext = projectBriefPreflightContext('/fixture/project', brief, (project, paths) => {
      expect(project).toBe('/fixture/project');
      expect(paths).toEqual(['private-data/metadata.json', 'private-data/prices.csv']);
      return ['private-data/prices.csv'];
    });
    const firstReport = inspectBrief(brief, firstContext);
    expect(firstReport.findings).toContainEqual(expect.objectContaining({
      code: 'gitignored_input_undeclared',
      message: expect.stringContaining('private-data/prices.csv'),
    }));
    const record = createBriefAdmission(firstReport, {
      kind: 'explicit', source: 'cli_current_input_flag', at: '2026-08-10T00:00:00.000Z',
    });

    expect(verifyBriefAdmission(brief, record, firstContext).status).toBe('valid');
    expect(verifyBriefAdmission(brief, record).status).toBe('valid');

    const expandedContext = projectBriefPreflightContext(
      '/fixture/project', brief, (_project, paths) => paths,
    );
    expect(verifyBriefAdmission(brief, record, expandedContext).status)
      .toBe('acknowledgement_missing');
  });
});
