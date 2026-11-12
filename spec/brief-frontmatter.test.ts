import './test-support/policy-runtime.js';
import { spawnSync } from 'node:child_process';
import { EXIT_CODE } from '../src/exit-code.js';
import { runShipSetup, cmdShipSetupWithDeps } from '../src/cli-ship-setup.js';
import { cmdShipPreflightWithDeps } from '../src/cli-ship-preflight.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { extractDeclaredBriefInputPaths } from '../src/ship-inputs.js';
import { parseBriefFrontmatterDocument } from '../src/brief-frontmatter.js';
import { parseBriefValidationCommands } from '../src/cli-ship-setup.js';
import { collectShipPreflight } from '../src/cli-ship-preflight.js';
import { inspectBrief } from '../src/brief-preflight.js';
import { entryWorkflow, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { rehearseBrief } from '../src/rehearse.js';

const root = mkdtempSync(join(tmpdir(), 'frontmatter-contract-'));
const deps = {
  projectDir: root,
  packageRoot: root,
  readGitCommonDir: () => '.git',
  readCampaignEntries: () => [],
  runsRoot: () => join(root, 'runs'),
  probeDaemon: async () => ({ state: 'fresh' as const, loadedBuild: 'same', diskBuild: 'same' }),
};
mkdirSync(join(root, 'runs'));

describe('shared frontmatter contract', () => {
  it.each([
    "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Deliver a result.\"}]\nvalidation: [\n---\n## Requirements\n1. Deliver a result.\n",
  ])('reports one malformed-metadata error through each entrance', async (brief) => {
    const briefPath = join(root, 'brief.md');
    writeFileSync(briefPath, brief);
    const error = parseBriefFrontmatterDocument(brief)?.error;
    expect(error).toBeTruthy();
    // quick uses this exact workflow selection after rendering inspectBrief.
    expect(entryWorkflow(parseBriefFrontmatter(brief)).error).toBe(error);
    expect(parseBriefValidationCommands(brief, briefPath).error).toBe(error);
    const { report } = await collectShipPreflight(['ship-preflight', '--brief', briefPath], deps);
    expect(report.workflow?.error).toBe(error);
    const rehearsal = await rehearseBrief([briefPath, '--static-only'], { briefText: brief });
    expect(rehearsal.exitCode).toBe(1);
    expect(rehearsal.findings).toContainEqual(expect.objectContaining({
      level: 'fail', text: expect.stringContaining(error!),
    }));
  });

  it.each([
    '---\nworkflow: direct\n',
    '---\nBody prose after a Markdown horizontal rule.\n',
  ])('treats an unclosed opener as body prose at admission', async (opening) => {
    const brief = `${opening}## Requirements\n1. Deliver a result.\n`;
    expect(parseBriefFrontmatterDocument(brief)).toBeUndefined();
    expect(inspectBrief(brief).frontmatter.status).toBe('absent');
    expect(inspectBrief(brief).contractReady).toBe(true);
    expect(entryWorkflow(parseBriefFrontmatter(brief)).error).toBeUndefined();
    expect(parseBriefValidationCommands(brief, 'brief.md')).toEqual({ commands: [] });
    const briefPath = join(root, 'unclosed.md');
    writeFileSync(briefPath, brief);
    expect((await rehearseBrief([briefPath, '--static-only'])).exitCode).toBe(0);
    const { report } = await collectShipPreflight(['ship-preflight', '--brief', briefPath], deps);
    expect(report.briefErrors).toEqual([]);
  });

  it('retains the legacy semantic readers for empty, scalar, and sequence YAML', () => {
    for (const yaml of ['', 'plain scalar', '[one, two]']) {
      const brief = `---\n${yaml}${yaml ? '\n' : ''}---\n## Requirements\n1. Deliver a result.\n`;
      expect(parseBriefFrontmatterDocument(brief)?.error).toBeUndefined();
      expect(parseBriefValidationCommands(brief, 'brief.md')).toEqual({ commands: [] });
      expect(Boolean(parseBriefFrontmatter(brief).frontmatterError)).toBe(yaml !== '');
    }
  });

  it('gives prose criteria no admission authority', async () => {
    for (const brief of ['# Goal\nDeliver a result.', '## Requirements\n1. Deliver a result.']) {
      expect(extractBriefCriteria(brief).criteria).toEqual([]);
      expect(inspectBrief(brief).contractReady).toBe(true);
      expect((await rehearseBrief(['opaque.md', '--static-only'], { briefText: brief })).exitCode).toBe(0);
    }
  });
});

describe('brief consumers share the leading metadata boundary', () => {
  it.each(['\n', '\r\n'])('reads BOM declarations independently of body criteria (%j)', (newline) => {
    const brief = ['\uFEFF---', 'inputs: [input.txt]', '---', '## Acceptance Criteria', '1. Preserve exact evidence.'].join(newline);
    expect(extractDeclaredBriefInputPaths(brief)).toEqual(['input.txt']);
    expect(parseBriefFrontmatter(brief).stripped).toBe(['## Acceptance Criteria', '1. Preserve exact evidence.'].join(newline));
    expect(extractBriefCriteria(brief).criteria).toEqual([]);
  });

  it('accepts an empty block and refuses a closing delimiter with trailing text', () => {
    expect(parseBriefFrontmatter('---\n---\nBody').stripped).toBe('Body');
    expect(parseBriefFrontmatter('---\ninputs: [input.txt]\n---suffix\nBody').frontmatterError).toContain('never closed');
  });

});

describe('real brief admission entry points', () => {
  it.each([
    ['frontmatter_invalid', "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Deliver a result.\"}]\nvalidation: [\n---\n## Requirements\n1. Deliver a result.\n"],
    ['frontmatter_invalid', '---\ninputs: [{path: input.txt, typo: true}]\n---\nDeliver a result.'],
  ])('keeps authored %s diagnostics while quick writes missing criteria', async (code, brief) => {
    const briefPath = join(root, `${code}.md`);
    writeFileSync(briefPath, brief);
    const finding = inspectBrief(brief).findings.find(finding => finding.code === code)!;
    const home = join(root, `${code}-home`);
    const quick = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src/cli.ts'),
      'quick', '--project', root, '--adapter', 'mock', '--no-campaign', '--task', brief], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, FC_HOME: home, NO_COLOR: '1' },
    });
    expect(quick.status, quick.stderr).toBe(EXIT_CODE.failed);
    if (code === 'brief_criteria_missing') {
      expect(quick.stderr).toContain('automatic setup requires a Git working tree with a committed HEAD');
    } else expect(quick.stderr).toContain(`[${code}] ${finding.message}`);
    const rehearsal = await rehearseBrief([briefPath, '--static-only']);
    expect(rehearsal.exitCode).toBe(EXIT_CODE.failed);
    expect(rehearsal.findings).toContainEqual({ code, level: 'fail', text: expect.stringContaining(finding.message) });
    const args = ['ship-setup', '--brief', briefPath, '--project', root, '--target', join(root, `${code}-target`),
      '--base', 'HEAD', '--branch', `test-${code}`];
    const setup = await runShipSetup(args);
    expect(setup).toMatchObject({ state: 'refused', worktreeCreated: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code, reason: finding.message })]) });
    const output = { write: (_text: string) => {} };
    expect(await cmdShipSetupWithDeps(args, { stdout: output, stderr: output })).toBe(EXIT_CODE.failed);
    let rendered = '';
    expect(await cmdShipPreflightWithDeps(['ship-preflight', '--brief', briefPath], {
      ...deps, stdout: { write: text => { rendered += text; } }, stderr: output,
    })).toBe(EXIT_CODE.failed);
    expect(rendered).toContain(`[${code}] ${finding.message}`);
    const { report } = await collectShipPreflight(['ship-preflight', '--brief', briefPath], deps);
    expect(report.briefErrors).toContainEqual(finding);
  });
});
