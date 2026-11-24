import { it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public crash recovery retains the uncertain effect and completes new work without replay', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'dead-controller' });
  onTestFinished(async () => { await running.catch(() => {}); });
  await running;
}, publicTestTimeoutMs);
