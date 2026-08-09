/**
 * Phase-0 safety net — Context primitive contract.
 *
 * The world-model digest must enumerate on-disk assets (so the loop never signposts "acquire"
 * data it already has), group by directory, respect caps, and return 'none' when empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { summarizeContext } from '../../src/context-inventory.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), `fc-ctx-${randomBytes(4).toString('hex')}-`)); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function touch(rel: string, bytes = 10): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x'.repeat(bytes));
}

describe('Context primitive — summarizeContext', () => {
  it('returns "none" when the roots are absent or empty', () => {
    expect(summarizeContext(dir, ['data'])).toBe('none');
  });

  it('enumerates files grouped by directory (so on-disk assets are visible to the proposer)', () => {
    touch('data/btc/btc_hourly.parquet');
    touch('data/l2_orderbook/historical/btc_cvd_hourly.parquet');
    const out = summarizeContext(dir, ['data']);
    expect(out).toMatch(/data\/btc\/: btc_hourly\.parquet/);
    expect(out).toMatch(/data\/l2_orderbook\/historical\/: btc_cvd_hourly\.parquet/);
  });

  it('collapses directories with many files to "… +N more" (stays compact)', () => {
    for (let i = 0; i < 25; i++) touch(`data/cache/cvd-2022-01-${String(i).padStart(2, '0')}.parquet`);
    const out = summarizeContext(dir, ['data'], { perDirFiles: 10 });
    expect(out).toMatch(/\+15 more/);
  });

  it('skips noise dirs (node_modules/.git/__pycache__)', () => {
    touch('data/real.parquet');
    touch('data/__pycache__/junk.pyc');
    const out = summarizeContext(dir, ['data']);
    expect(out).toMatch(/real\.parquet/);
    expect(out).not.toMatch(/__pycache__/);
  });

  it('honors multiple roots (e.g. data + src for engineering objectives)', () => {
    touch('data/d.parquet');
    touch('src/main.ts');
    const out = summarizeContext(dir, ['data', 'src']);
    expect(out).toMatch(/data\/: d\.parquet/);
    expect(out).toMatch(/src\/: main\.ts/);
  });
});
