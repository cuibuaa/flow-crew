import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideResearchComparison, numericResearchGuard, type Observation, type GuardObservation, type Metric } from '../src/research-measurement.js';

// Only this replay adapter knows the historical evaluator's wire format. It
// validates evidence and projects observations; the production rule owns keep.
type Row = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/research-rsi-parity.json', import.meta.url), 'utf8')) as Row;
const fields = { pooled_wall: 'host_wall_seconds', pooled_output_tokens: 'output_tokens', hidden_passes: 'hidden_passes', complete_terminal_outcomes: 'complete' };
const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function project(entry: Row): Parameters<typeof decideResearchComparison> {
  const { summary: s, noise: n } = entry;
  let valid = s.complete === true && typeof s.set === 'string' && Array.isArray(s.tasks) && s.tasks.length > 0 && new Set(s.tasks).size === s.tasks.length
    && s.expected_cells === s.published_cells && s.expected_cells === s.tasks.length * Object.keys(s.engines).length;
  const observations: Observation[] = [];
  for (const arm of ['main', 'cand']) {
    const e = s.engines[arm];
    const statuses = e?.terminal_statuses;
    valid &&= !!e && e.cells === s.tasks.length && e.expected_cells === s.tasks.length && e.hidden_results_available === s.tasks.length
      && !!statuses && JSON.stringify(Object.keys(statuses).sort()) === JSON.stringify(['clock', 'complete', 'failed', 'incomplete', 'parked'])
      && Object.values(statuses).every(v => numeric(v) && Number.isInteger(v)) && Object.values(statuses).reduce((a: number, b) => a + Number(b), 0) === s.tasks.length
      && Number.isInteger(e.hidden_passes) && e.hidden_passes <= s.tasks.length && numeric(e.host_wall_seconds) && numeric(e.output_tokens)
      && !(e.token_unknown_attempts?.output_tokens);
    const cells = entry.cells?.filter((c: Row) => c.arm === arm);
    const items = cells ? cells.map((c: Row) => ({ id: c.task, metrics: { pooled_wall: c.host_wall_seconds, pooled_output_tokens: c.output_tokens, hidden_passes: Number(c.resolved), complete_terminal_outcomes: Number(c.terminal === 'complete') } }))
      : s.tasks.map((id: string) => ({ id, metrics: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, (name === 'complete_terminal_outcomes' ? statuses?.complete : e?.[field]) / s.tasks.length])) }));
    observations.push({ status: 'measured', fingerprint: s.evaluator_sha256, candidate: e?.commit ?? '', items });
  }
  valid &&= n.set === s.set && JSON.stringify(n.tasks) === JSON.stringify(s.tasks) && JSON.stringify(n.source_arms) === '["main","main2"]';
  if (!valid) observations[0].status = 'unmeasured';
  const guards: GuardObservation[] = [];
  const pair = ['main', 'cand'].map(arm => s.engines[arm]?.review_guard);
  if (pair.some(g => !g || Array.isArray(g))) guards.push({ passes: false, reason: 'input_invalid' });
  else {
    const program = s.review_guard_program_sha256 ?? pair.find(g => g.program_sha256)?.program_sha256;
    const expected = JSON.stringify([program, s.evaluator_sha256]);
    for (const g of pair) {
      const fingerprint = JSON.stringify([g.program_sha256 ?? program, g.evaluator_sha256 ?? s.evaluator_sha256]);
      guards.push({ passes: true, fingerprint, expectedFingerprint: expected });
    }
    const failures = pair.filter(g => ['guard_error', 'guard_unavailable'].includes(g.status));
    if (failures.length) guards.push({ passes: false, reason: failures.some(g => g.status === 'guard_error') ? 'guard_error' : 'guard_unavailable' });
    else {
      const identities: string[] = [], rejects: number[] = [];
      for (const [index, g] of pair.entries()) {
        let good = g.complete === true && typeof g.program_sha256 === 'string' && /^[a-f0-9]{64}$/.test(g.program_sha256) && !!g.evaluator_sha256
          && g.engine?.commit === s.engines[index ? 'cand' : 'main'].commit && /^[a-f0-9]{64}$/.test(g.case_set_sha256) && Array.isArray(g.cases) && g.cases.length >= 8 && g.cases.length <= 12;
        const members = (g.cases ?? []).map((c: Row) => {
          good &&= typeof c.id === 'string' && !!c.id && typeof c.task === 'string' && !!c.task && typeof c.pass === 'boolean' && ['review', 'review_full'].includes(c.review_stage)
            && Array.isArray(c.sessions) && c.sessions.length > 0;
          const settings = ['assess', c.review_stage].map(stage => {
            const sessions = (c.sessions ?? []).filter((t: Row) => t.stage === stage);
            good &&= sessions.length > 0 && sessions.every((t: Row) => ['model', 'reasoning_effort', 'source'].every(k => typeof t[k] === 'string' && !!t[k]));
            const values = [...new Set(sessions.map((t: Row) => JSON.stringify([t.model, t.reasoning_effort])))];
            good &&= values.length === 1;
            return values;
          });
          return [c.id, c.task, settings];
        });
        good &&= new Set((g.cases ?? []).map((c: Row) => c.id)).size === g.cases?.length;
        const count = (g.cases ?? []).filter((c: Row) => c.pass === false).length;
        good &&= Number.isInteger(g.reject_count) && g.reject_count === count;
        if (!good) guards.push({ passes: false, reason: 'input_invalid' });
        rejects.push(count); identities.push(JSON.stringify([g.case_set_sha256, members.sort()]));
      }
      if (identities[0] !== identities[1]) guards.push({ passes: false, reason: 'input_invalid' });
      guards.push(numericResearchGuard(rejects[0], rejects[1]));
    }
    const [a, b] = ['main', 'cand'].map(arm => s.engines[arm]);
    guards.push(numericResearchGuard(a.hidden_passes, b.hidden_passes), numericResearchGuard(a.terminal_statuses.complete, b.terminal_statuses.complete));
  }
  return [observations[0], observations[1], fixture.metrics as Record<string, Metric>, Object.keys(fixture.metrics), { fingerprint: n.evaluator_sha256, items: n.tasks, metrics: n.metrics }, guards];
}

describe('recorded Python decide parity through the production keep rule', () => {
  it.each(fixture.comparisons as Row[])('$id', entry => {
    const actual = decideResearchComparison(...project(entry));
    expect({ keep: actual.keep, reason: actual.reason }).toEqual({ keep: entry.expected.keep, reason: entry.expected.reason });
  });
  it('retains the complete guard-round inventory and portable projections', () => {
    expect(fixture.inventory).toHaveLength(15);
    expect(fixture.comparisons).toHaveLength(7);
    expect(JSON.stringify(fixture)).not.toMatch(/\/(?:home|Users)\//);
  });
});
