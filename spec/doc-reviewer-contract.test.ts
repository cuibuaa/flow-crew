import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';

const reviewerPath = new URL('../config/agents/doc_reviewer.yaml', import.meta.url);

function reviewerPrompt(): string {
  const parsed = parseYaml(readFileSync(reviewerPath, 'utf-8')) as { prompt?: unknown };
  expect(typeof parsed.prompt).toBe('string');
  return parseAgent(parsed).prompt;
}

describe('doc reviewer design contract', () => {
  it('requires assigned outcomes and delegates design findings to the injected policy', () => {
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

    expect(prompt).toContain('primary-view elements answer a stated user question or goal');
    expect(prompt.replace(/\s+/g, ' ')).toContain('Unassigned dimensions guide investigation under the injected finding policy');
    expect(prompt.replace(/\s+/g, ' ')).toContain('Use these dimensions to test the assigned outcome using the injected verdict contract');
    expect(prompt).toContain('Pass only when all meet their acceptance lines');
    expect(prompt.replace(/\s+/g, ' ')).toContain('Code references must exist and be accurate; examples must be correct and runnable; required sections and links must be complete and live');
    expect(prompt).toContain("Return the scheduler's typed PASS/FAIL verdict");
    expect(prompt).not.toContain('ALWAYS write the verdict file');
    for (const standard of proposalStandards) expect(prompt).toContain(`- ${standard}:`);
  });

  it('does not apply proposal-only dimensions to README reviews', () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain('apply only to proposed designs');
    expect(prompt).toContain('not descriptions of existing systems (READMEs,');
    expect(prompt).toContain('Examples do not exclude equivalent property evidence');
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
    expect(prompt).toContain('The same acceptance authority applies to these dimensions');
    for (const dimension of readThroughDimensions) expect(prompt).toContain(`- ${dimension}:`);
  });
});
