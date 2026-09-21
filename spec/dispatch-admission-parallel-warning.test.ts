import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectDispatchAdmission,
  parseDispatchedStageConfig,
  type StageConfig,
} from '../src/scheduler.js';

function stage(id: string, scope: string[], dependsOn: string[] = []): StageConfig {
  return parseDispatchedStageConfig({
    id,
    role: 'coder',
    scope,
    depends_on: dependsOn,
    dependency_reasons: Object.fromEntries(dependsOn.map((dependency) => [dependency, `Consumes ${dependency}.`])),
    criterion_refs: [],
    prompt_template: 'work',
  });
}

function warningsFor(stages: StageConfig[]): string[] | undefined {
  return (inspectDispatchAdmission({
    dispatched: stages,
    baseStages: [],
    dispatchStageId: 'plan',
  }) as ReturnType<typeof inspectDispatchAdmission> & { warnings?: string[] }).warnings;
}

describe('parallel scope dispatch admission', () => {
  it('A4 admits but warns for a runnable frontier whose scopes are not provably disjoint', () => {
    const overlapping = inspectDispatchAdmission({
      dispatched: [
        stage('left', ['src/shared/**']),
        stage('right', ['src/shared/file.ts']),
      ],
      baseStages: [],
      dispatchStageId: 'plan',
    }) as ReturnType<typeof inspectDispatchAdmission> & { warnings?: string[] };

    expect(overlapping.pass).toBe(true);
    expect(overlapping.errors).toEqual([]);
    expect(overlapping.warnings).toHaveLength(1);
    expect(overlapping.warnings?.[0]).toContain('left');
    expect(overlapping.warnings?.[0]).toContain('right');
    expect(overlapping.warnings?.[0]).toContain('will be serialized');
    expect(warningsFor([
      stage('left', ['src/left.ts']),
      stage('right', ['spec/right.ts']),
    ])).toEqual([]);
    expect(warningsFor([
      stage('left', ['src/shared/**']),
      stage('right', ['src/shared/file.ts'], ['left']),
    ])).toEqual([]);

    const plannerPrompt = readFileSync(join(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml'), 'utf-8');
    expect(plannerPrompt).toContain('Stages eligible to run together MUST have disjoint `scope` entries.');
  });
});
