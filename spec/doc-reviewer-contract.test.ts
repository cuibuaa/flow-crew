import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const reviewerPath = new URL('../config/agents/doc_reviewer.yaml', import.meta.url);

function reviewerPrompt(): string {
  const parsed = parseYaml(readFileSync(reviewerPath, 'utf-8')) as { prompt?: unknown };
  expect(typeof parsed.prompt).toBe('string');
  return parsed.prompt as string;
}

describe('doc reviewer design contract', () => {
  it('returns findings and a rejecting typed verdict for a deliberately weak design proposal', () => {
    const prompt = reviewerPrompt();
    const proposalStandards = [
      'Purpose traceability',
      'Data-driven distinctions',
      'No normalisation of meaningful states',
      'No hiding of failure',
      'Localised failure',
      'Cost that does not scale with the data',
      'Retention is not presentation',
      'Information must not be hover-only',
      'Falsifiable success criteria',
      'Redesign vs. patch list',
    ];

    // A proposal that puts an unmotivated internal score in the primary view is
    // explicitly a finding, and every finding remains in the independently returned verdict.
    expect(prompt).toContain('every element the design places in the primary view must be traceable');
    expect(prompt).toContain('Include each violation below in the findings');
    expect(prompt).toContain('Reject when critical inaccuracies or missing required sections remain');
    expect(prompt).toContain("Return the scheduler's typed verdict");
    expect(prompt).not.toContain('ALWAYS write the verdict file');
    for (const standard of proposalStandards) expect(prompt).toContain(`- ${standard}:`);
  });

  it('does not apply proposal-only dimensions to README reviews', () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain('Apply ONLY when the document under review');
    expect(prompt).toContain('Do NOT apply these to READMEs,');
    expect(prompt).toContain('parenthetical examples above are ILLUSTRATIVE, not criteria');
  });

  it('keeps the seven operator read-through dimensions aligned with the UI self-check', () => {
    const prompt = reviewerPrompt();
    const readThroughDimensions = [
      'Purpose/question traceability',
      'Near-duplicate entries',
      'Identifier consistency',
      'Self-explaining language',
      'Scan-length/readability',
      'Label-content truthfulness',
      'Uninterrupted primary reading flow',
    ];

    expect(prompt).toContain('metric assertions are supporting evidence, never a substitute');
    for (const dimension of readThroughDimensions) expect(prompt).toContain(`- ${dimension}:`);
  });
});
