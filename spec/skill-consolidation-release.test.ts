import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';

const repositoryRoot = join(import.meta.dirname, '..');

function plannerPrompt(): string {
  const parsed = parse(
    readFileSync(join(repositoryRoot, 'config', 'agents', 'planner.yaml'), 'utf-8'),
  ) as { prompt?: unknown };
  if (typeof parsed.prompt !== 'string') throw new Error('planner prompt is not a string');
  return parsed.prompt;
}

function numberedRule(prompt: string, number: number): string {
  const rule = new RegExp(`^${number}\\. (.+)$`, 'm').exec(prompt)?.[1];
  if (!rule) throw new Error(`planner hard rule ${number} is missing`);
  return rule;
}

function structuredBrief(body: string): string {
  return [
    '---',
    'terminal_states:',
    '  complete:',
    '    paths: [docs/release/final.md]',
    '---',
    '# Task',
    body,
  ].join('\n');
}

describe('skill-consolidation release contract', () => {
  it('makes both ground-truth decisions actionable from the planner prompt alone', () => {
    const prompt = plannerPrompt();
    const gateScope = numberedRule(prompt, 6);
    const terminalPaths = numberedRule(prompt, 12);

    expect(gateScope).toContain('For a gate, `scope: []` is valid only');
    expect(gateScope).toContain('strictly read-only');
    expect(gateScope).toContain('tests, probes, snapshots, reports, generated outputs');
    expect(gateScope).toContain('every such project-relative writable path');
    expect(gateScope).toContain('first verification attempt without a scope violation');

    expect(terminalPaths).toContain('`terminal_states.<status>.paths`');
    expect(terminalPaths).toContain('only by the final stage');
    expect(terminalPaths).toContain("non-final stage's `scope`");
    expect(terminalPaths).toContain('create or modify it');
    expect(terminalPaths).toContain('commits the terminal status');
    expect(terminalPaths).toContain('skips every stage still pending, including verification and repair');
  });

  it('retires terminal-path prose inference for level-two sections and declarations', () => {
    const levelTwo = inspectBrief(structuredBrief([
      '## D1 — implementation',
      'Write `docs/release/conclusion.md` as the implementation deliverable.',
      '## D2 — verification',
      'Verify and repair the implementation.',
    ].join('\n')));
    const declaration = inspectBrief(structuredBrief([
      '## D1 — implementation',
      'No earlier stage may write `docs/release/final.md`.',
      '## Terminal',
      'After verification, write `docs/release/final.md`.',
    ].join('\n')));

    for (const report of [levelTwo, declaration]) {
      expect(report.findings.some(({ code }) => code.startsWith('terminal_path_written_early')))
        .toBe(false);
      expect(report.findings.map(({ code }) => code)).toContain('terminal_state_complete');
    }
  });

  it('preserves terminal-floor guards after retiring the ownership heuristic', () => {
    const wallFloor = inspectBrief([
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/final.md]',
      '    floor:',
      '      min_wall_minutes: 11',
      '---',
      '# Goal',
      'Ship the result.',
    ].join('\n'));
    const uncountableFloor = inspectBrief([
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/final.md]',
      '    stage_glob: docs/stages/stage_*_verdict.md',
      '    floor:',
      '      min_attempted_stages: 1',
      '---',
      '# Verification',
      'Inspect the existing `docs/stages/stage_1_verdict.md`.',
    ].join('\n'));

    expect(wallFloor.findings.map(({ code }) => code))
      .toContain('terminal_wall_floor_too_high_complete');
    expect(uncountableFloor.findings.map(({ code }) => code))
      .toContain('terminal_floor_uncountable_complete');
  });

  it('replaces all dormant probes with a collected machine-independent contract', () => {
    for (const file of [
      'verify-ship-gate.mjs',
      'verify-final-stabilization-gate.mjs',
      'verify-autonomous-ship-qa.mjs',
    ]) {
      expect(existsSync(join(repositoryRoot, 'spec', file)), file).toBe(false);
    }

    const vitest = readFileSync(join(repositoryRoot, 'vitest.config.ts'), 'utf-8');
    expect(vitest).toContain('"spec/**/*.test.ts"');
    expect(existsSync(join(repositoryRoot, 'spec', 'ship-docs.test.ts'))).toBe(true);
  });
});
