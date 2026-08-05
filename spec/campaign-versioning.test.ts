import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rollback } from '../src/brief-versioning.js';
import { loadCampaignConfig, runCampaign } from '../src/campaign.js';
import { campaignDir, runsRoot } from '../src/store.js';

let tempDir: string;
let runsBefore: Set<string>;
let campaignId: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-campaign-versioning-${randomBytes(4).toString('hex')}-`));
  runsBefore = existsSync(runsRoot()) ? new Set(readdirSync(runsRoot())) : new Set();
  campaignId = `campaign-versioning-${randomBytes(4).toString('hex')}`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(campaignDir(campaignId), { recursive: true, force: true });
  if (existsSync(runsRoot())) {
    for (const id of readdirSync(runsRoot())) {
      if (!runsBefore.has(id) && id.startsWith('campaign-versioning-run-')) {
        rmSync(join(runsRoot(), id), { recursive: true, force: true });
      }
    }
  }
});

function readRevisions(briefDir: string): any[] {
  return readFileSync(join(briefDir, 'revisions.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('campaign brief versioning integration', () => {
  it('advances brief versions for fired diagnosis rules and supports rollback', async () => {
    const briefDir = join(tempDir, 'docs', 'brief');
    const scriptPath = join(tempDir, 'launch.sh');
    const yamlPath = join(tempDir, 'campaign.yaml');
    const initialBrief = `# Brief

## Two priorities
Start here.

## Other
Keep.
`;

    writeFileSync(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
run_id="campaign-versioning-run-$(date +%s%N)-$RANDOM"
dir="${runsRoot()}/$run_id"
mkdir -p "$dir"
cat > "$dir/run.json" <<JSON
{"runId":"$run_id","workflowName":"test","projectDir":"${tempDir}","status":"failed","stages":{},"startedAt":"2026-05-23T00:00:00.000Z","result":0}
JSON
cat > "$dir/research_integrity_rejections.json" <<JSON
{"unstable_seeds":7}
JSON
`, 'utf-8');
    chmodSync(scriptPath, 0o755);

    writeFileSync(yamlPath, `
campaign:
  id: ${campaignId}
  briefDir: ${JSON.stringify(briefDir)}
  projectDir: ${JSON.stringify(tempDir)}
  goal:
    metric: result
    validRange: [1, 2]
  budget:
    maxRuns: 3
    maxWallHours: 0.001
  launch:
    systemdUnit: test-unit
    launchScript: ${JSON.stringify(scriptPath)}
  diagnosisRules:
    - signal: "rejections.unstable_seeds >= 5"
      action:
        type: brief_patch
        section: "## Two priorities"
        op: append
        value: "Train longer."
`, 'utf-8');

    const cfg = await loadCampaignConfig(yamlPath);
    const seed = await import('../src/brief-versioning.js');
    seed.ensureBriefDir(briefDir, initialBrief);

    const result = await runCampaign(cfg);

    expect(result.status).toBe('budget_exhausted');
    expect(readFileSync(join(briefDir, 'HEAD'), 'utf-8')).toBe('v4\n');
    expect(readFileSync(join(briefDir, 'v4.md'), 'utf-8').match(/Train longer\./g)).toHaveLength(3);
    const revisions = readRevisions(briefDir);
    expect(revisions).toHaveLength(3);
    expect(revisions.every((entry) => typeof entry.diff === 'string' && entry.diff.includes('+Train longer.'))).toBe(true);

    rollback(briefDir, 'v2', 'test rollback');

    expect(readFileSync(join(briefDir, 'HEAD'), 'utf-8')).toBe('v2\n');
    expect(readFileSync(join(briefDir, 'v2.md'), 'utf-8').match(/Train longer\./g)).toHaveLength(1);
    expect(readRevisions(briefDir).at(-1)).toMatchObject({ from: 'v4', to: 'v2', reason: 'test rollback' });
  });
});
