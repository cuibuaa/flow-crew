import { it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public replacement plan from status resumes the next author, command and independent gate', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'resume-guide' });
  onTestFinished(async () => { await running.catch(() => {}); });
  await running;
}, publicTestTimeoutMs);
