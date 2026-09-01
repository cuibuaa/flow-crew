import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectDispatchAdmission,
  parseDispatchedStageConfig,
  resolveDispatchDependencies,
  type StageConfig,
} from '../src/scheduler.js';
import {
  mergePlanRetryPair,
  planRetryRequirement,
  preparePlanRetryCandidate,
  recordPlanRetryRefusal,
  type PlanRetryRequirement,
} from '../src/plan-retry-monotone.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fc-verify-ratchet-'));
  temporaryRoots.push(root);
  return root;
}

function stage(id: string, scope: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    role: 'coder',
    prompt_template: `execute ${id}`,
    scope,
    depends_on: [],
    dependency_reasons: {},
    criterion_refs: [],
    ...extra,
  };
}

function dispatch(stages: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return stringifyYaml({ stages, ...extra });
}

function parsedStages(markdown: string): StageConfig[] {
  const parsed = parseYaml(markdown) as { stages?: unknown[] } | unknown[];
  const items = Array.isArray(parsed) ? parsed : parsed.stages ?? [];
  const stages = items.map((item) => parseDispatchedStageConfig(item));
  resolveDispatchDependencies(stages, 'plan');
  return stages;
}

function terminalAdmission(markdown: string) {
  return inspectDispatchAdmission({
    dispatched: parsedStages(markdown),
    baseStages: [],
    dispatchStageId: 'plan',
    terminalStates: { complete: { paths: ['docs/final.md'] } },
  });
}

function prepare(runDirPath: string, attemptIndex: number, markdown: string) {
  writeFileSync(join(runDirPath, 'dispatch.yaml'), markdown, 'utf8');
  return preparePlanRetryCandidate({
    runDirPath,
    stageId: 'plan',
    iteration: 1,
    attemptIndex,
  });
}

function refuse(input: {
  runDirPath: string;
  attemptIndex: number;
  markdown: string;
  maxAttempts: number;
  requirement: PlanRetryRequirement;
}) {
  return recordPlanRetryRefusal({
    runDirPath: input.runDirPath,
    prepared: prepare(input.runDirPath, input.attemptIndex, input.markdown),
    maxAttempts: input.maxAttempts,
    unsatisfied: [input.requirement],
  });
}

describe('independent QA: monotone plan-retry safety and liveness', () => {
  it('allows a duplicate-owner refusal to be repaired by removing one implicated owner', () => {
    const incumbent = dispatch([
      stage('first_owner', ['docs/final.md']),
      stage('second_owner', ['docs/final.md']),
    ]);
    const proposed = dispatch(
      [stage('first_owner', ['docs/final.md'])],
      { retry_remove_stages: ['second_owner'] },
    );
    const requirement = planRetryRequirement(
      'terminal_states path docs/final.md: expected exactly one scoped owner, found 2 (first_owner, second_owner)',
    );

    expect(terminalAdmission(incumbent).errors.join('\n')).toContain(
      'expected exactly one scoped owner, found 2',
    );
    expect(terminalAdmission(proposed)).toMatchObject({ pass: true, errors: [] });

    const merged = mergePlanRetryPair({ dispatch: incumbent }, { dispatch: proposed }, [requirement]);
    expect(parsedStages(merged.pair.dispatch).map((item) => item.id)).toEqual(['first_owner']);
    expect(terminalAdmission(merged.pair.dispatch)).toMatchObject({ pass: true, errors: [] });
  });

  it('does not let a later caller enlarge the bound persisted by the first refusal', () => {
    const root = temporaryRoot();
    const impossible = planRetryRequirement(
      'work.scope: impossible requirement remains unsatisfied',
      'admission',
      'stage:work:scope',
    );

    expect(refuse({
      runDirPath: root,
      attemptIndex: 1,
      markdown: dispatch([stage('work', ['docs/a.md'])]),
      maxAttempts: 2,
      requirement: impossible,
    }).stop).toBe(false);

    const second = refuse({
      runDirPath: root,
      attemptIndex: 2,
      markdown: dispatch([stage('work', ['docs/b.md'])]),
      maxAttempts: 99,
      requirement: impossible,
    });
    expect(second.stop).toBe(true);
    expect(second.state.maxAttempts).toBe(2);
    expect(second.state.terminal?.disposition).toBe('attempts_exhausted');
  });

  it('stops the same pair and stable requirement even when diagnostic prose changes', () => {
    const root = temporaryRoot();
    const markdown = dispatch([stage('work', ['docs/a.md'])]);
    const firstRequirement = planRetryRequirement(
      'work.scope: first rendering of the refusal',
      'admission',
      'stage:work:scope',
    );
    const secondRequirement = planRetryRequirement(
      'work.scope: semantically identical refusal with refreshed prose',
      'admission',
      'stage:work:scope',
    );

    expect(refuse({
      runDirPath: root,
      attemptIndex: 1,
      markdown,
      maxAttempts: 3,
      requirement: firstRequirement,
    }).stop).toBe(false);
    const repeated = refuse({
      runDirPath: root,
      attemptIndex: 2,
      markdown,
      maxAttempts: 3,
      requirement: secondRequirement,
    });

    expect(repeated).toMatchObject({ stop: true, disposition: 'identical_refusal' });
    expect(repeated.reason).toContain('stage:work:scope');
  });

  it('advances when a repair exposes a different latent defect on the same never-admitted stage', () => {
    const root = temporaryRoot();
    const firstFailure = planRetryRequirement('work.scope.0: invalid scope syntax');
    expect(refuse({
      runDirPath: root,
      attemptIndex: 1,
      markdown: dispatch([stage('work', ['bad scope'])]),
      maxAttempts: 3,
      requirement: firstFailure,
    }).stop).toBe(false);

    const secondFailure = planRetryRequirement('work.depends_on: unknown stage "missing"');
    const second = refuse({
      runDirPath: root,
      attemptIndex: 2,
      markdown: dispatch([stage('work', ['docs/work.md'], {
        depends_on: ['missing'],
        dependency_reasons: { missing: 'latent topology defect' },
      })]),
      maxAttempts: 3,
      requirement: secondFailure,
    });

    expect(second).toMatchObject({ stop: false, disposition: 'incumbent_advanced' });
    expect(second.state.unsatisfied).toEqual([secondFailure]);
  });

  it('retains a passing provisional check while an independent check is repaired', () => {
    const passingScript = String.raw`sed -n 's/^\([a-z][a-z]*\)$/\1/p' docs/input.txt`;
    const incumbentChecks = stringifyYaml({
      checks: [
        { name: 'broken', type: 'file-exists-nonempty', params: { paths: ['docs/optional.json'] } },
        { name: 'passing', type: 'exec-script-exit-zero', params: { script: passingScript } },
      ],
    });
    const proposalChecks = stringifyYaml({
      checks: [
        { name: 'broken', type: 'file-exists-nonempty', params: { paths: ['docs/stable.json'] } },
        { name: 'passing', type: 'exec-script-exit-zero', params: { script: 'regressed bytes' } },
      ],
    });
    const merged = mergePlanRetryPair(
      { dispatch: dispatch([stage('work', ['docs/stable.json'])]), realityChecks: incumbentChecks },
      { dispatch: dispatch([stage('work', ['docs/stable.json'])]), realityChecks: proposalChecks },
      [planRetryRequirement('reality check "broken" references mutable optional result path')],
    );
    const document = parseYaml(merged.pair.realityChecks!) as {
      checks: Array<{ name: string; params: { paths?: string[]; script?: string } }>;
    };

    expect(document.checks[0].params.paths).toEqual(['docs/stable.json']);
    expect(document.checks[1].params.script).toBe(passingScript);
  });

  it('fails closed when scheduler-owned incumbent evidence bytes are modified', () => {
    const root = temporaryRoot();
    const failure = planRetryRequirement('work.scope: remains invalid');
    const first = refuse({
      runDirPath: root,
      attemptIndex: 1,
      markdown: dispatch([stage('work', ['docs/a.md'])]),
      maxAttempts: 3,
      requirement: failure,
    });
    const incumbentPath = join(root, first.state.incumbent.dispatchPath);
    writeFileSync(incumbentPath, `${readFileSync(incumbentPath, 'utf8')}# tampered\n`, 'utf8');
    writeFileSync(join(root, 'dispatch.yaml'), dispatch([stage('work', ['docs/b.md'])]), 'utf8');

    expect(() => preparePlanRetryCandidate({
      runDirPath: root,
      stageId: 'plan',
      iteration: 1,
      attemptIndex: 2,
    })).toThrow(/incumbent dispatch digest mismatch/);
  });
});
