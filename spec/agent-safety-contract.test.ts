import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASE_PROMPT_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', '_base.md');

function safetySection(): string {
  const prompt = readFileSync(BASE_PROMPT_PATH, 'utf-8');
  const match = prompt.match(/^## Safety\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  expect(match, 'the base prompt must contain a Safety section').not.toBeNull();
  return match![1];
}

describe('agent run-directory safety contract', () => {
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
});
