import { expect, it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public delivery reruns A after an a/ repair and reuses B with visible provenance', async ({signal,onTestFinished}) => {
  const running = publicAcceptance({signal,packageRoot:process.cwd(),scenario:'dependency-reuse'});
  onTestFinished(async () => { await running.catch(() => {}); });
  const result = await running;
  expect(result.status).toBe('complete');
  expect(result.reuseStatus.find(command=>command.command==='B').reused).toMatch(/^reused from review\//);
}, publicTestTimeoutMs);
