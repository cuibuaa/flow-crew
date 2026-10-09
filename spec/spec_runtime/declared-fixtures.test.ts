import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseDispatchedStageConfig } from '../../src/scheduler.js';
import { declaredDispatch } from '../test-support/declared-dispatch.js';

describe('declared fixture migration boundary', () => {
  it('adds only authored empty duties and the exact gate verdict', () => {
    const raw = [
      { id: 'worker', role: 'coder', depends_on: [], dependency_reasons: {}, scope: [], prompt_template: 'Write unnamed.md; node --test omitted.test.mjs' },
      { id: 'judge', role: 'qa', depends_on: [], dependency_reasons: {}, scope: [], is_gate: true, prompt_template: 'Judge worker' },
    ];
    expect(parseDispatchedStageConfig(raw[0]).artifact_contract).toMatchObject({produces:[],reads:[],replays:[]});
    const working = (parse(declaredDispatch(stringify(raw))) as unknown[]).map((stage) => parseDispatchedStageConfig(stage));
    expect(working[0].artifact_contract).toMatchObject({ version: 1, produces: [], reads: [], replays: [] });
    expect(working[1].artifact_contract?.produces).toEqual([
      { id: 'verdict', root: 'run', path: 'verdict_judge.json', kind: 'file', nonempty: true },
    ]);
  });

  it.each([
    { version: 2, produces: [], reads: [] },
    { version: 1, produces: [{ id: 'escape', root: 'run', path: '../outside.md' }], reads: [], replays: [] },
    { version: 1, produces: [], reads: [], replays: [{ id: 'shell', runner: 'shell', targets: ['missing'], argv: [] }] },
  ])('preserves a malformed existing declaration for native refusal: %j', (artifact_contract) => {
    const raw = [{ id: 'worker', role: 'coder', depends_on: [], dependency_reasons: {}, scope: [], artifact_contract }];
    const working = parse(declaredDispatch(stringify(raw), {
      worker: { version: 1, produces: [], reads: [], replays: [] },
    })) as unknown[];
    expect(working).toEqual(raw);
    expect(() => parseDispatchedStageConfig(working[0])).toThrow();
  });
});
