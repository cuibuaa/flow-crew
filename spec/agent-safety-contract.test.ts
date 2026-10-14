import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { applyBasePrompt } from '../src/scheduler/sched_admission/dispatch.js';

const BASE_PROMPT_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', '_base.md');
const directory = resolve(BASE_PROMPT_PATH, '..');
const prompt = (role: string, withBase = true): string => {
  const agent = parseAgent(parse(readFileSync(resolve(directory, `${role}.yaml`), 'utf8')));
  return withBase ? applyBasePrompt(agent, readFileSync(BASE_PROMPT_PATH, 'utf8')).prompt : agent.prompt;
};

describe('agent run-directory safety contract', () => {
  it('keeps the external write boundary while allowing authorized run records and invocation-private evidence', () => {
    const safety = prompt('coder');

    expect(safety).toMatch(/Never modify files outside the project directory except/i);
    expect(safety).toMatch(/explicitly authorized task-local run paths/i);
    expect(safety).toContain("invocation's private $TMPDIR for ephemeral evidence");
    expect(safety).toMatch(/All other external paths remain read-only/i);
  });

  it.each([false, true])('keeps run mutation absolutely prohibited with base=%s', (withBase) => {
    const safety = prompt('coder', withBase);

    expect(safety).toMatch(
      /never write, move, delete, or otherwise modify any run directory other than this task's own run directory/i,
    );
    expect(safety).toMatch(/this prohibition is absolute/i);
    expect(safety).toMatch(/read authorization never grants mutation authority/i);
  });

  it.each([false, true])('allows only bounded brief authorization to govern sibling-run reads with base=%s', (withBase) => {
    const safety = prompt('coder', withBase);

    expect(safety).toMatch(/by default, do not read, browse, or list other `?\.fc\/runs\/?`? directories/i);
    expect(safety).toMatch(
      /explicit brief authorization allows a bounded set as read-only evidence/i,
    );
    expect(safety).toMatch(
      /governs default read restrictions for that evidence only/i,
    );
    expect(safety).toMatch(/grants no permission to modify those runs/i);
  });

  it('allows explained test changes while retaining required coverage and honest expectations', () => {
    const base = readFileSync(BASE_PROMPT_PATH, 'utf-8');
    expect(base).toContain('Explain test changes and preserve brief-required coverage and honest expectations');
  });

  it('accepts invocation deadlines and necessary local setup while retaining execution and installation bounds', () => {
    const base = readFileSync(BASE_PROMPT_PATH, 'utf-8').replace(/\s+/g, ' ');
    expect(base).toContain('You run unattended');
    expect(base).toContain('Supply all required command input, including scripted interactive input');
    expect(base).toContain('bounded by their own limit or the invocation deadline');
    expect(base).toContain('leave no background processes');
    expect(base).toContain('Use a shorter command limit when recovery needs it');
    expect(base).toContain('Necessary project-local dependency setup is allowed within admitted capabilities');
    expect(base).toContain('respect lockfiles');
    expect(base).toContain('Global or external installation needs explicit authorization');
    expect(base).toContain('write terminal deliverables at declared paths and supporting documents at admitted evidence paths');
  });
});

describe('shipped role outcome contracts', () => {
  it('ships all nine configured roles', () => {
    const roles = readdirSync(directory).filter(file => file.endsWith('.yaml')).map(file => file.slice(0, -5)).sort();
    expect(roles).toEqual(['ai_detector', 'coder', 'doc_reviewer', 'doc_writer', 'paper_reviewer', 'paper_writer', 'planner', 'qa', 'researcher']);
  });

  it('retains paper scores and sourced claims while applying stylistic acceptance only when assigned', () => {
    for (const role of ['paper_reviewer', 'ai_detector']) {
      const text = prompt(role);
      for (const score of ['Novelty', 'Rigor', 'Clarity', 'Soundness']) expect(text).toContain(score);
      expect(text).toContain('1–10 score');
      expect(text).toContain('Disclose missing or ambiguous lines');
      expect(text).toContain('never invent a threshold or waive a supplied one');
    }
    expect(prompt('paper_reviewer')).toContain('Reproducibility');
    expect(prompt('paper_reviewer')).toContain('no minimum count');
    expect(prompt('ai_detector')).toContain('Stylistic flags guide improvements; they fail acceptance only when the brief');
    expect(prompt('ai_detector')).toContain('zero flagged sections when explicitly required');
    expect(prompt('ai_detector')).toContain('Every quantitative claim must have a source');
  });

  it('gives criteria and required scores their own results through the shared acceptance owner', () => {
    const loaded = prompt('qa');
    expect(loaded).toContain('every assigned criterion and every score');
    expect(loaded).toContain('Pass only when all meet their acceptance lines');
    expect(loaded).toContain('never invent a threshold or waive a supplied one');
    expect(loaded).toContain('Examples do not exclude equivalent property evidence');
  });

  it('preserves independent review inputs while allowing isolated probes and contextual evidence', () => {
    for (const role of ['qa', 'doc_reviewer', 'paper_reviewer', 'ai_detector']) {
      expect(prompt(role)).toContain('must not durably modify the reviewed target or authoritative inputs');
      expect(prompt(role)).toContain('isolated temporary probes and declared evidence generation are allowed within admitted capabilities');
      expect(prompt(role)).toContain('Target repairs belong to an author');
    }
    expect(prompt('ai_detector')).toContain('cited sources, comparator papers and experiment records within read authorization');
  });

  it('uses relevant post-change baseline evidence and retains exact rejected repair checks', () => {
    const loaded = prompt('coder').replace(/\s+/g, ' ');
    expect(loaded).toContain('After the last change, supply relevant evidence covering the change under the admitted baseline comparison');
    expect(loaded).toContain('existing failures may remain when the admitted rule is no new regression');
    expect(loaded).toContain('Repairs include the exact rejected check');
  });

  it('grounds research claims in verified retrievable evidence with sufficient authority', () => {
    const loaded = prompt('researcher').replace(/\s+/g, ' ');
    expect(loaded).toContain('verified retrievable evidence locator (URL, file or record identifier), the verification method');
    expect(loaded).toContain('Load-bearing claims need sufficient authoritative evidence; one primary source may suffice');
    expect(loaded).toContain('Disclose uncertainty');
    for (const role of ['researcher', 'paper_writer']) {
      const text = prompt(role).replace(/\s+/g, ' ');
      expect(text).toContain('Clearly label task-requested synthetic examples');
      expect(text).toContain('never present them or invented sources as observed evidence');
    }
    expect(prompt('paper_writer')).toContain('Factual claims require citations or experimental results');
    expect(prompt('paper_writer')).toContain('disclose missing evidence and measurements');
  });

  it('permits justified asset replacement in ordinary research planning', () => {
    const loaded = prompt('planner').replace(/\s+/g, ' ');
    expect(loaded).toContain('Reuse assets fit for the task');
    expect(loaded).toContain('justify refresh or replacement by identity, freshness, license or coverage gaps');
  });
});
