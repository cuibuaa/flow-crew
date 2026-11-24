import { expect, it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

// Briefs that declare no decomposition run work then the gate through the public CLI with no planner call;
// a rejection routes to repair work that receives the findings, and the same gate reviews again.
it.for(['fixed-graph', 'fixed-repair'])('public %s run needs no planner and no gate instruction', async (scenario, { signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario });
  onTestFinished(async () => { await running.catch(() => {}); });
  expect((await running).status).toBe('complete');
}, publicTestTimeoutMs);
