import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from './test-support/create-run.js';

import { StageConfigSchema } from '../src/scheduler.js';
import { runStageWave } from '../src/scheduler/stage-wave.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';

// Completion must work on platforms without filesystem notifications as well.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watch: () => { throw new Error('fixture has no filesystem notifications'); },
}));

afterEach(() => vi.useRealTimers());

describe('stage wave completion', () => {
  it.each([false, true])('releases the approval monitor after all stages settle, with rejected peer = %s', async (rejectPeer) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-wave-'));
    const selected = ['first', 'last'].map((id) => StageConfigSchema.parse({ id, role: 'coder', scope: [] }));
    const created = createRun(projectDir, 'wave', 'name: wave', selected.map((stage) => stage.id));
    const closed: string[] = [];
    const { monitorApprovalRequests } = createApprovalMonitor({ writeCampaignEntryUnlessPaused: () => {} });
    let closeLast!: () => void;
    const lastStage = new Promise<void>((resolve) => { closeLast = resolve; });
    let settled = false;
    // Hold polling timers still: only a completion notification can release
    // the monitors. setImmediate continues to drain ordinary event-loop work.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const execution = runStageWave(selected, {
      monitorApproval: (completion) => monitorApprovalRequests({
        selected, projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1, completion,
      }),
      execute: async (stage) => {
        try {
          if (stage.id === 'last') await lastStage;
          else if (rejectPeer) throw new Error('fixture stage failed');
          return stage.id;
        } finally { closed.push(stage.id); }
      },
    }).then((result) => { settled = true; return result; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toEqual(['first']);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      closeLast();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(closed).toEqual(['first', 'last']);
      expect(vi.getTimerCount()).toBe(0);
      const wave = await execution;
      expect(wave.parked).toBeNull();
      expect(wave.results.map((entry) => entry.status)).toEqual([rejectPeer ? 'rejected' : 'fulfilled', 'fulfilled']);
    } finally {
      closeLast();
      // Also clean up the polling-only mutation used to prove this regression.
      await vi.advanceTimersByTimeAsync(1000);
      await execution;
      vi.useRealTimers();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
