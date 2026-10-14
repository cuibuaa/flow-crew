import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from '../src/store.js';
import { StageConfigSchema } from '../src/scheduler.js';
import { runStageWave } from '../src/scheduler/stage-wave.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';
import { createScopeRevisionMonitor } from '../src/scheduler/sched_scope/revision-monitor.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';

// Completion must work on platforms without filesystem notifications as well.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  watch: () => { throw new Error('fixture has no filesystem notifications'); },
}));

afterEach(() => vi.useRealTimers());

describe('stage wave completion', () => {
  it.each([false, true])('releases both monitors after all stages settle, with rejected peer = %s', async (rejectPeer) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-wave-'));
    const selected = ['first', 'last'].map((id) => StageConfigSchema.parse({ id, role: 'coder', scope: [] }));
    const created = createRun(projectDir, 'wave', 'name: wave', selected.map((stage) => stage.id));
    const context = createScopeBatchContext(projectDir, selected, undefined, created.runId);
    const { monitorScopeRevisionRequests } = createScopeRevisionMonitor({ readRunValidationBaseline: () => undefined });
    const { monitorApprovalRequests } = createApprovalMonitor({ writeCampaignEntryUnlessPaused: () => {} });
    let closeLast!: () => void;
    const lastStage = new Promise<void>((resolve) => { closeLast = resolve; });
    let settled = false;
    // Hold polling timers still: only a completion notification can release
    // the monitors. setImmediate continues to drain ordinary event-loop work.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const execution = runStageWave(selected, {
      activeStageIds: context.activeStageIds,
      monitorScope: (completion) => monitorScopeRevisionRequests({
        selected, activeStageIds: context.activeStageIds, projectDir, runId: created.runId, context, completion,
      }),
      monitorApproval: (completion) => monitorApprovalRequests({
        selected, projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1, completion,
      }),
      execute: async (stage) => {
        if (stage.id === 'last') await lastStage;
        else if (rejectPeer) throw new Error('fixture stage failed');
        return stage.id;
      },
    }).then((result) => { settled = true; return result; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(context.activeStageIds).toEqual(new Set(['last']));
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(2);
      closeLast();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(context.activeStageIds.size).toBe(0);
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
