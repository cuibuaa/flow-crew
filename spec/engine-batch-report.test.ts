import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(project, 'guide/engine-batch-settlement.md');

it('R3 binds the portable settlement report to available repository evidence', () => {
  const report = readFileSync(reportPath, 'utf8');
  const links = [...report.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link, 'evidence must use repository-relative links').not.toMatch(/^(?:[a-z]+:|\/)/i);
    const target = resolve(dirname(reportPath), link.split('#')[0]);
    const repoPath = relative(project, target).replaceAll('\\', '/');
    expect(repoPath, 'evidence must stay within the public repository').toMatch(/^(?:src|spec|guide)\//);
    expect(existsSync(target), `missing evidence: ${link}`).toBe(true);
  }
  expect(report).not.toMatch(/stages\/|\.fc\/|\/home\/|\b(?:r\d+-final-validation|run[_-]id)\b/);
});

it('R4 keeps the 19 original dispositions separate from the watchdog progress repair', () => {
  const report = readFileSync(reportPath, 'utf8');
  const rows = [...report.matchAll(/^\| (E\d{2}) \| (fixed|already fixed|declined) \|/gm)];
  const expected = {
    E01: 'already fixed', E02: 'already fixed', E03: 'already fixed',
    E04: 'already fixed', E05: 'already fixed', E06: 'already fixed',
    E07: 'declined', E08: 'already fixed', E09: 'already fixed',
    E10: 'fixed', E11: 'fixed', E12: 'already fixed', E13: 'already fixed',
    E14: 'already fixed', E15: 'fixed', E16: 'declined', E17: 'declined',
    E18: 'declined', E19: 'fixed',
  };
  expect(rows).toHaveLength(19);
  expect(Object.fromEntries(rows.map(row => [row[1], row[2]]))).toEqual(expected);
  expect(rows.filter(row => row[2] === 'fixed')).toHaveLength(4);
  expect(rows.filter(row => row[2] === 'already fixed')).toHaveLength(11);
  expect(rows.filter(row => row[2] === 'declined')).toHaveLength(4);
  expect(report).toContain('4 fixed, 11 already fixed, 4 declined');
  expect(report).toMatch(/\| E12 \| already fixed \|[^\n]*did not reproduce on the base/);
  expect(report).toMatch(/E12-progress is a separately repaired backward-clock progress defect, outside the\n19 original dispositions/);
});
