import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const BASE_PROMPT_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', '_base.md');

function safetySection(): string {
  const prompt = readFileSync(BASE_PROMPT_PATH, 'utf-8');
  const match = prompt.match(/^## Safety\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  expect(match, 'the base prompt must contain a Safety section').not.toBeNull();
  return match![1];
}

describe('agent run-directory safety contract', () => {
  it('keeps the project boundary reachable for explicitly authorized run records and OS-temporary evidence', () => {
    const safety = safetySection();

    expect(safety).toMatch(/Never modify files outside the project directory except/i);
    expect(safety).toMatch(/explicitly authorized task-local run paths/i);
    expect(safety).toMatch(/operating system temporary root/i);
    expect(safety).toMatch(/All other external paths remain read-only/i);
  });

  it('absolutely prohibits mutation outside this task\'s own run directory', () => {
    const safety = safetySection();

    expect(safety).toMatch(
      /never write, move, delete, or otherwise modify any run directory other than this task's own run directory/i,
    );
    expect(safety).toMatch(/this prohibition is absolute/i);
    expect(safety).toMatch(/read authorization never grants mutation authority/i);
  });

  it('lets an explicit bounded brief authorization govern reads only', () => {
    const safety = safetySection();

    expect(safety).toMatch(/by default, do not read, browse, or list other `?\.fc\/runs\/?`? directories/i);
    expect(safety).toMatch(
      /task brief explicitly authorizes a bounded set of other runs as read-only evidence/i,
    );
    expect(safety).toMatch(
      /task-specific authorization governs all default read, browse, and list restrictions elsewhere in this agent prompt for that evidence only/i,
    );
    expect(safety).toMatch(/grants no permission to write, move, delete, or modify those runs/i);
  });

  it('does not conflate harmless reads with state-changing mutation', () => {
    expect(safetySection()).not.toMatch(/never browse, list, or modify run directories/i);
  });

  it('lets a stage change a test the intended behaviour contradicts, never weaken one to make a change pass', () => {
    // A blanket "never change tests" kept candidates passing the old expectation instead of the behaviour the task asked
    // for (SWE-bench django-12325 and sphinx-9229 resolve only when an existing expectation is changed).
    const base = readFileSync(BASE_PROMPT_PATH, 'utf-8');
    expect(base).toMatch(/Change an existing test only where the behaviour the task intends contradicts it, and say which and why/);
    expect(base).toMatch(/never weaken a test to make a change pass/);
    expect(base).not.toMatch(/Never change tests unless/);
  });
});

describe('shipped role outcome contracts', () => {
  const directory = resolve(BASE_PROMPT_PATH, '..');
  const prompt = (role: string): string => parse(readFileSync(resolve(directory, `${role}.yaml`), 'utf8')).prompt;

  it('retains all eleven roles, including the unused paper roles, without permanent parallel rules', () => {
    const roles = readdirSync(directory).filter(file => file.endsWith('.yaml')).map(file => file.slice(0, -5)).sort();
    expect(roles).toEqual(['ai_detector', 'campaign_planner', 'campaign_scout', 'coder', 'doc_reviewer', 'doc_writer', 'paper_reviewer', 'paper_writer', 'planner', 'qa', 'researcher']);
    for (const text of [readFileSync(BASE_PROMPT_PATH, 'utf8'), ...roles.map(prompt)]) {
      expect(text).not.toMatch(/git add \.|git commit -a|Keep diffs minimal|ONLY scope|at least 3 weaknesses/);
    }
  });

  it('retains every paper review score and the zero-flag line without inventing score thresholds or findings', () => {
    for (const role of ['paper_reviewer', 'ai_detector']) {
      const text = prompt(role);
      for (const score of ['Novelty', 'Rigor', 'Clarity', 'Soundness']) expect(text).toContain(score);
      expect(text).toContain('1–10 score');
      expect(text).toMatch(/no numerical[\s\S]*threshold/);
      expect(text).toContain('missing or ambiguous thresholds');
    }
    expect(prompt('paper_reviewer')).toContain('Reproducibility');
    expect(prompt('paper_reviewer')).toContain('no minimum count');
    expect(prompt('ai_detector')).toContain('zero flagged sections');
    expect(prompt('ai_detector')).toContain('Every quantitative claim must have a source');
  });

  it('gives criteria and required scores their own results and limits re-review rejection', () => {
    const base = readFileSync(BASE_PROMPT_PATH, 'utf8');
    expect(base).toContain('every assigned criterion and every score');
    expect(base).toContain('Pass only when all meet their acceptance lines');
    expect(base).toContain('never invent a threshold or waive a supplied one');
    expect(base).toContain('regression introduced by the repair');
    expect(base).toContain("failure a user of the brief's outcome would meet");
    expect(base).toContain('other differences are stated limitations');
  });
});
