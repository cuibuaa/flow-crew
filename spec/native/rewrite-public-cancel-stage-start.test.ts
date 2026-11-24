import { it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public cancel fences the author while its stage-start command is current', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'cancel-stage-start' });
  onTestFinished(async () => { await running.catch(() => {}); });
  await running;
}, publicTestTimeoutMs);
