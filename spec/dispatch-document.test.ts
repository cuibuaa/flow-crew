import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDispatchDocument } from '../src/dispatch-document.js';
import { collectStageAuthoredChecks } from '../src/verdict-controls.js';
import { renderGuidanceEnvelope } from '../src/guidance.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('dispatch transport and gate-control readers', () => {
  it('retains bare and wrapped stage lists through the same reader', () => {
    const stages = [{ id: 'work', role: 'coder' }];
    expect(readDispatchDocument(JSON.stringify(stages)).stages).toEqual(stages);
    expect(readDispatchDocument(JSON.stringify({ stages, scope_negotiation: { defer: ['known'] } })).document).toEqual({ stages, scope_negotiation: { defer: ['known'] } });
    for (const text of ['', 'stages: false', 'scalar', 'stages: [']) expect(() => readDispatchDocument(text)).toThrow();
  });
  it('finds attributed criterion checks for both recorded transport shapes', () => {
    const run = mkdtempSync(join(tmpdir(), 'fc-dispatch-reader-')); roots.push(run);
    mkdirSync(join(run, 'stages/work'), { recursive: true });
    writeFileSync(join(run, 'stages/work/status.json'), JSON.stringify({ status: 'complete', writeAttribution: 'structured', writes: ['spec/current.test.ts'] }));
    writeFileSync(join(run, 'supervisor_guidance.md'), renderGuidanceEnvelope({ version: 1, id: 'ruling', target: '*', source: 'operator', createdAt: '2026-10-06T00:00:00.000Z', criterionIds: ['C1'], body: 'Account for C1.' }));
    const stages = [{ id: 'work', criterion_refs: ['C1'] }, { id: 'audit', is_gate: true, depends_on: ['work'] }];
    for (const document of [stages, { stages }]) {
      writeFileSync(join(run, 'dispatch.yaml'), JSON.stringify(document));
      expect(collectStageAuthoredChecks(run, 'audit', ['C1'])).toEqual([{ criterionId: 'C1', authorStageId: 'work', path: 'spec/current.test.ts' }]);
    }
    writeFileSync(join(run, 'stages/work/status.json'), JSON.stringify({ status: 'pending', writeAttribution: 'structured', writes: ['spec/current.test.ts'] }));
    expect(collectStageAuthoredChecks(run, 'audit', ['C1'])).toEqual([]);
  });
});
