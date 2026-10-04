import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { inspectDispatchAdmission, StageConfigSchema } from '../src/scheduler.js';

const repositoryRoot = join(import.meta.dirname, '..');

function plannerPrompt(): string {
  const parsed = parse(
    readFileSync(join(repositoryRoot, 'config', 'agents', 'planner.yaml'), 'utf-8'),
  ) as { prompt?: unknown };
  if (typeof parsed.prompt !== 'string') throw new Error('planner prompt is not a string');
  return parsed.prompt;
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
  it('enforces write, ownership, criterion and routing protections without numbered planner rules', () => {
    expect(plannerPrompt()).not.toContain('Hard rules (gate will reject otherwise)');
    const stage = (id: string, extra = {}) => StageConfigSchema.parse({
      id,role:'coder',scope:['docs/**'],depends_on:[],dependency_reasons:{},prompt_template:'Declared work.',
      artifact_contract:{version:1,produces:[],reads:[]},...extra,
    });
    const admit = (stages: ReturnType<typeof stage>[], extra = {}) => inspectDispatchAdmission({dispatched:stages,baseStages:[],dispatchStageId:'plan',...extra});
    const writableGate = stage('gate',{role:'qa',is_gate:true,scope:[],artifact_contract:{version:1,produces:[
      {id:'verdict',root:'run',path:'verdict_gate.json'},{id:'probe',root:'project',path:'spec/probe.test.ts'},
    ],reads:[]}});
    expect(admit([writableGate]).errors.join(';')).toContain('ARTIFACT_OUTPUT_OUTSIDE_SCOPE');
    const terminalStates = {complete:{paths:['docs/final.md']}};
    expect(admit([stage('first'),stage('second')],{terminalStates}).errors.join(';')).toContain('expected exactly one scoped owner, found 2');
    const criteria = extractBriefCriteria('# Task\n## Acceptance Criteria\n1. The report must preserve independently verified evidence.\n');
    expect(criteria.criteria.length).toBeGreaterThan(0);
    const work = stage('work',{criterion_refs:criteria.criteria.map((criterion)=>criterion.id)});
    const uncovered = admit([work],{criteria});
    expect(uncovered.pass).toBe(false);
    expect(uncovered.errors.join(';')).toContain('not assigned to a gate');
    expect(admit([stage('owner',{condition:'research.decision == continue'})],{terminalStates}).errors.join(';')).toContain('non-research run');
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
