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
    expect(prompt).toContain('primary-view elements answer a stated user question or goal');
    expect(prompt).toContain('Each violation is a finding');
    expect(prompt).toContain('Reject for critical inaccuracies');
    expect(prompt).toContain('or missing required sections');
    expect(prompt).toContain("Return the scheduler's typed PASS/FAIL verdict");
    expect(prompt).not.toContain('ALWAYS write the verdict file');
    for (const standard of proposalStandards) expect(prompt).toContain(`- ${standard}:`);
  });

  it('does not apply proposal-only dimensions to README reviews', () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain('apply only to proposed designs');
    expect(prompt).toContain('not descriptions of existing systems (READMEs,');
    expect(prompt).toContain('property, not an illustrative means');
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

    expect(prompt).toContain('Metric assertions support these properties; they do not replace them');
    for (const dimension of readThroughDimensions) expect(prompt).toContain(`- ${dimension}:`);
  });
});
