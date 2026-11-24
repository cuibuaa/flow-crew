import { expect, it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

// A reviewing gate accepts and its tools leave a byproduct in the project: the run completes and delivers the tree the gate reviewed.
it('public run completes when an accepting gate leaves bytes in the project, and delivers the reviewed tree', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'gate-tree' });
  onTestFinished(async () => { await running.catch(() => {}); });
  expect((await running).status).toBe('complete');
}, publicTestTimeoutMs);
