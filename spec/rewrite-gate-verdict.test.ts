import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerSchema, type AnswerContext } from '../dist-rewrite/contract/answers.js';

const context: AnswerContext = {
  purpose: 'gate', criterionIds: ['first', 'last'], resultIds: [], commandIds: [], checkpointIds: [],
  roleIds: ['reviewer'], allowBlocked: true, final: true, revision: 'revision',
  briefTexts: ['Reject trailing input. Preserve existing behaviour.', 'Keep literal punctuation!'],
};
const pass = { status: 'pass', evidence: 'Independent observation.' };
const fail = { status: 'fail', evidence: 'Trailing input was accepted.', briefQuote: 'Reject trailing input.' };
const finding = { id: 'defect', paths: [], reason: 'Observed defect.', criterionIds: ['last'],
  class: 'regression', briefQuote: 'Preserve existing behaviour.' };
const answer = (outcome = 'accepted', criteria = { first: pass, last: pass }, findings: unknown[] = []) =>
  ({ kind: 'gate', answer: { outcome, reason: 'Independent review.', criteria, findings, remainingWork: [] } });

describe('gate verdict slim', () => {
  it.each(['accepted', 'accepted_blocked'])('refuses %s with a fail criterion', outcome => {
    for (const final of [false, true]) for (const quoted of [false, true]) {
      const { briefQuote: _quote, ...unquoted } = fail;
      const schema = answerSchema({ ...context, final });
      const value = answer(outcome, { first: pass, last: quoted ? fail : unquoted });
      expect(schema.parse(value).ok).toBe(false);
      expect(z.fromJSONSchema(schema.json).safeParse(value).success).toBe(false);
    }
  });
  it.each(['accepted', 'accepted_blocked'])('refuses %s with a regression finding', outcome => {
    for (const final of [false, true]) for (const kind of ['regression', 'criterion_unmet']) for (const quoted of [false, true]) {
      const { briefQuote: _quote, ...unquoted } = finding;
      const schema = answerSchema({ ...context, final });
      const value = answer(outcome, undefined, [{ ...(quoted ? finding : unquoted), class: kind }]);
      expect(schema.parse(value).ok).toBe(false);
      expect(z.fromJSONSchema(schema.json).safeParse(value).success).toBe(false);
    }
  });
  it.each(['accepted', 'accepted_blocked'])('admits an advisory finding with %s', outcome => {
    const { briefQuote: _quote, ...advisory } = finding;
    const value = answer(outcome, undefined, [{ ...advisory, class: 'advisory' }]);
    const schema = answerSchema(context);
    expect(schema.parse(value).ok).toBe(true);
    expect(z.fromJSONSchema(schema.json).safeParse(value).success).toBe(true);
  });
  it('refuses a fabricated briefQuote on every failing criterion and blocking finding', () => {
    const schema = answerSchema(context);
    for (const briefQuote of ['Invented requirement.', 'reject trailing input.', 'Keep literal punctuation.', '', ' \n ',
      'existing behaviour. Keep literal punctuation!']) {
      expect(schema.parse(answer('rejected_repairable', { first: fail, last: { ...fail, briefQuote } })).ok).toBe(false);
      for (const kind of ['regression', 'criterion_unmet'])
        expect(schema.parse(answer('rejected_irreparable', undefined,
          [finding, { ...finding, id: 'last', class: kind, briefQuote }])).ok).toBe(false);
    }
  });
  it('requires briefQuote on every failing criterion and blocking finding', () => {
    const { briefQuote: _quote, ...unquoted } = fail;
    expect(answerSchema(context).parse(answer('rejected_repairable', { first: pass, last: unquoted })).ok).toBe(false);
    const { briefQuote: _findingQuote, ...unquotedFinding } = finding;
    expect(answerSchema(context).parse(answer('rejected_irreparable', undefined, [unquotedFinding])).ok).toBe(false);
  });
  it('admits a whitespace-variant quote with verbatim case and punctuation', () => {
    const schema = answerSchema({ ...context, briefTexts: ['\n Reject  trailing\ninput. \t Preserve existing behaviour.'] });
    const value = answer('rejected_repairable', { first: pass, last: { ...fail, briefQuote: ' Reject\ttrailing input.\n' } },
      [{ ...finding, briefQuote: 'Preserve\n existing\tbehaviour.' }]);
    expect(schema.parse(value).ok).toBe(true);
  });
  it('keeps rejection without a violation and final assessment requirements unchanged', () => {
    for (const outcome of ['rejected_repairable', 'rejected_irreparable'])
      expect(answerSchema(context).parse(answer(outcome)).ok).toBe(true);
    const pending = { status: 'not_assessed', evidence: 'Later work remains.', reason: 'pending_work' };
    for (const outcome of ['accepted', 'accepted_blocked']) {
      const value = answer(outcome, { first: pass, last: pending });
      expect(answerSchema(context).parse(value).ok).toBe(false);
      expect(answerSchema({ ...context, final: false }).parse(value).ok).toBe(true);
    }
  });
});
