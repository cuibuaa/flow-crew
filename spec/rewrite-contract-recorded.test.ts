import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseBrief } from '../rewrite-src/contract/brief.js';
import { parsePlan } from '../rewrite-src/contract/plan.js';
import { firstPlanRefusals, recordedShapes } from './fixtures/rewrite-contract-recorded.js';

function context(shape: typeof recordedShapes[number], final: boolean) {
  return {
    purpose: 'gate' as const, criterionIds: shape.brief.criteria.map(criterion => criterion.id),
    commandIds: shape.brief.commands.map(command => command.id), resultIds: [], checkpointIds: [],
    roleIds: ['coder', 'qa'], allowBlocked: shape.brief.allowBlocked, final, revision: 'revision-current',
  };
}

describe('public benchmark and synthetic contract shapes', () => {
  it.each(recordedShapes)('$source admits its criteria and stages', shape => {
    const { body, ...metadata } = shape.brief;
    expect(parseBrief(new TextEncoder().encode(`---\n${stringify(metadata)}---\n${body}`)))
      .toEqual({ ok: true, value: shape.brief });
    if (shape.plan) expect(parsePlan(shape.plan, context(shape, false))).toEqual({ ok: true, value: withoutSkills(shape.plan) });
  });



  it.each(firstPlanRefusals)('$source re-expresses its own archived two-stage first proposal as admitted', refusal => {
    const shape = recordedShapes.find(row => row.source === refusal.source)!;
    expect(refusal.proposal.stages).toHaveLength(2);
    expect(parsePlan(refusal.proposal, context(shape, false))).toEqual({ ok: true, value: withoutSkills(refusal.proposal) });
  });


});

function withoutSkills(plan: any) { return { ...plan, stages: plan.stages.map(({ skills: _skills, ...stage }: any) => stage) }; }
