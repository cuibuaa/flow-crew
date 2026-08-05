import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { aggregateAcrossRuns, readEscalations } from '../src/supervisor-escalation.js';
import { runsRoot } from '../src/store.js';

let tempDir: string;
let runId: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-supervisor-escalation-${randomBytes(4).toString('hex')}-`));
  runId = `supervisor-escalation-${randomBytes(4).toString('hex')}`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(join(runsRoot(), runId), { recursive: true, force: true });
});

describe('supervisor escalation reader', () => {
  it('returns an empty array when campaign_revision_request.jsonl is missing', () => {
    expect(readEscalations(tempDir)).toEqual([]);
  });

  it('parses well-formed JSONL requests', () => {
    writeFileSync(join(tempDir, 'campaign_revision_request.jsonl'), [
      JSON.stringify({
        ts: '2026-05-23T00:00:00.000Z',
        runId: 'run-1',
        severity: 'high',
        reason: 'death spiral',
        proposedPatch: { type: 'brief_patch', section: '## Risk Controls', op: 'append', value: 'Stop the spiral.' },
      }),
      '',
    ].join('\n'), 'utf-8');

    expect(readEscalations(tempDir)).toEqual([
      {
        ts: '2026-05-23T00:00:00.000Z',
        runId: 'run-1',
        severity: 'high',
        reason: 'death spiral',
        proposedPatch: { type: 'brief_patch', section: '## Risk Controls', op: 'append', value: 'Stop the spiral.' },
      },
    ]);
  });

  it('skips malformed lines without crashing', () => {
    writeFileSync(join(tempDir, 'campaign_revision_request.jsonl'), [
      '{bad json',
      JSON.stringify({ ts: '2026-05-23T00:00:00.000Z', runId: 'run-2', severity: 'low', reason: 'valid' }),
    ].join('\n'), 'utf-8');

    expect(readEscalations(tempDir)).toMatchObject([{ runId: 'run-2', severity: 'low', reason: 'valid' }]);
  });

  it('aggregates requests across run ids from iteration_log.jsonl', () => {
    const campaignDir = join(tempDir, 'campaign');
    const realRunDir = join(runsRoot(), runId);
    mkdirSync(campaignDir, { recursive: true });
    mkdirSync(realRunDir, { recursive: true });
    writeFileSync(join(campaignDir, 'iteration_log.jsonl'), JSON.stringify({ iter: 1, runId }) + '\n', 'utf-8');
    writeFileSync(join(realRunDir, 'campaign_revision_request.jsonl'), JSON.stringify({
      ts: '2026-05-23T00:00:00.000Z',
      severity: 'medium',
      reason: 'aggregated',
    }) + '\n', 'utf-8');

    expect(aggregateAcrossRuns(campaignDir)).toMatchObject([
      { runId, severity: 'medium', reason: 'aggregated' },
    ]);
  });
});
