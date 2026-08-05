import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyBriefPatch, evaluateDiagnosis, loadCampaignConfig } from '../src/campaign.js';
import type { DiagnosisContext, DiagnosisRule } from '../src/campaign.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-campaign-${randomBytes(4).toString('hex')}-`));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTemp(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

const baseContext: DiagnosisContext = {
  rejections: {},
  decision: {},
  journal: {},
  noImprovementRuns: 0,
  iteration: 1,
};

describe('loadCampaignConfig', () => {
  it('parses a valid campaign yaml and normalizes project-relative paths', async () => {
    const yamlPath = writeTemp('campaign.yaml', `
campaign:
  id: test-campaign
  briefPath: docs/task.md
  projectDir: ${JSON.stringify(tempDir)}
  goal:
    metric: result
    validRange: [1, 2]
  budget:
    maxRuns: 3
  launch:
    systemdUnit: test-unit
    launchScript: scripts/run.sh
  diagnosisRules:
    - signal: "rejections.unstable_seeds >= 5"
      action:
        type: brief_patch
        section: "## Two priorities"
        op: append
        value: "Train longer."
`);

    const cfg = await loadCampaignConfig(yamlPath);

    expect(cfg.id).toBe('test-campaign');
    expect(cfg.briefPath).toBe(join(tempDir, 'docs/task.md'));
    expect(cfg.launch.launchScript).toBe(join(tempDir, 'scripts/run.sh'));
    expect(cfg.goal.validRange).toEqual([1, 2]);
  });

  it('rejects malformed campaign yaml', async () => {
    const yamlPath = writeTemp('bad.yaml', `
campaign:
  id: broken
  budget:
    maxRuns: nope
`);

    await expect(loadCampaignConfig(yamlPath)).rejects.toThrow();
  });
});

describe('evaluateDiagnosis', () => {
  it('returns the first matching rule action', async () => {
    const rules: DiagnosisRule[] = [
      {
        signal: 'rejections.unstable_seeds >= 5',
        action: { type: 'brief_patch', section: '## A', op: 'append', value: 'first' },
      },
      {
        signal: 'noImprovementRuns >= 2',
        action: { type: 'brief_patch', section: '## B', op: 'append', value: 'second' },
      },
    ];

    const patch = await evaluateDiagnosis(rules, {
      ...baseContext,
      rejections: { unstable_seeds: 7 },
      noImprovementRuns: 3,
    });

    expect(patch?.value).toBe('first');
  });

  it('returns null when no rule matches', async () => {
    const patch = await evaluateDiagnosis([
      { signal: 'rejections.outlier_too_high >= 3', action: { type: 'brief_patch', section: '## A', op: 'append', value: 'x' } },
    ], baseContext);

    expect(patch).toBeNull();
  });

  it('rejects unsafe expressions before evaluation', async () => {
    await expect(evaluateDiagnosis([
      { signal: 'globalThis.process !== undefined', action: { type: 'brief_patch', section: '## A', op: 'append', value: 'x' } },
    ], baseContext)).rejects.toThrow(/Unsafe diagnosis expression/);
  });
});

describe('applyBriefPatch', () => {
  it('appends content under the requested markdown section', () => {
    const brief = writeTemp('brief.md', `# Brief

## Two priorities
Existing line.

## Other
Keep this.
`);

    applyBriefPatch(brief, { type: 'brief_patch', section: '## Two priorities', op: 'append', value: 'New priority.' });

    expect(readFileSync(brief, 'utf-8')).toBe(`# Brief

## Two priorities
Existing line.

New priority.

## Other
Keep this.
`);
  });

  it('replaces the first plausible value line in a section', () => {
    const brief = writeTemp('brief.md', `# Brief

## Action grid
Notes first.
actions: [-1, 0, 1]

## Done
`);

    applyBriefPatch(brief, {
      type: 'brief_patch',
      section: '## Action grid',
      op: 'replace_value',
      value: '[-1.00, 0.00, 1.00]',
    });

    expect(readFileSync(brief, 'utf-8')).toContain(`## Action grid
Notes first.
[-1.00, 0.00, 1.00]`);
  });

  it('edits a substring within the requested section', () => {
    const brief = writeTemp('brief.md', `# Brief

## Reward shaping
soft_drawdown_penalty coefficient 0.05

## Other
soft_drawdown_penalty coefficient 0.05
`);

    applyBriefPatch(brief, {
      type: 'brief_patch',
      section: '## Reward shaping',
      op: 'edit',
      value: '0.05 -> 0.20',
    });

    expect(readFileSync(brief, 'utf-8')).toBe(`# Brief

## Reward shaping
soft_drawdown_penalty coefficient 0.20

## Other
soft_drawdown_penalty coefficient 0.05
`);
  });
});
