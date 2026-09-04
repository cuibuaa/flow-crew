import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { formatDispatchStageSchemaFailure, StageConfigSchema } from '../src/scheduler.js';

const PLANNER_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml');
const BRIEF_CONTRACT_PATH = resolve(import.meta.dirname, '..', 'guide', 'brief-contract.md');
const SHIP_SKILL_PATH = resolve(import.meta.dirname, '..', 'skills', 'ship.md');
const LAUNCH_WRAP_UP_SENTENCE = 'FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.';

interface PlannerConfig {
  prompt?: unknown;
}

const REQUIRED_CLAUSES = [
  {
    id: 'project-relative-scope',
    pattern: /scope: \[<project-relative paths or globs>\]/,
  },
  {
    id: 'scope-required-for-every-stage',
    pattern: /Every stage MUST declare `scope`/,
  },
  {
    id: 'writable-gate-scope',
    pattern: /For a gate, `scope: \[\]` is valid only when its verification is strictly read-only\. If a gate may create or update tests, probes, snapshots, reports, generated outputs, or any other project artifact while verifying, include every such project-relative writable path in that gate's `scope`, so it can complete its first verification attempt without a scope violation\./,
  },
  {
    id: 'terminal-path-final-stage-only',
    pattern: /Every path declared by the task frontmatter under `terminal_states\.<status>\.paths` MUST be scoped to and written only by the final stage whose success commits that status\. Never put a declared terminal path in a non-final stage's `scope` or instruct a non-final stage to create or modify it: a fresh write commits the terminal status and skips every stage still pending, including verification and repair\./,
  },
  {
    id: 'raw-validation-exit-forbidden',
    pattern: /A hard Reality-Gate check MUST NOT make its verdict the unprocessed exit status of a project build, test, or lint command\. Compare current failure identities with the recorded validation baseline and its gate criterion, or omit the redundant validation check\./,
  },
  {
    id: 'gate-metric-optional-unless-contracted',
    pattern: /A numeric gate metric is OPTIONAL unless an authoritative project acceptance contract supplies a headline metric for that gate\./,
  },
  {
    id: 'missing-contracted-metric-refuses-before-repair',
    pattern: /A missing required value is an engine refusal before product repair or re-planning, not a defect for a repair stage to chase\./,
  },
  {
    id: 'metric-verdict-consistency-remains-strict',
    pattern: /The engine rejects `pass:true` when the same attempt's metric says fail; never weaken or route around that self-deception guard\./,
  },
  {
    id: 'durable-gate-report-citation',
    pattern: /Gate reports MUST cite the scheduler-injected durable rejected-verdict path under `gate_reevaluation\/iteration_<n>\/round_<n>\/`/,
  },
  {
    id: 'headline-distribution',
    pattern: /A requested headline or quoted statistic MUST require its mean, median, and where the reported value sits in its own distribution\./,
  },
  {
    id: 'preregistration-feasibility',
    pattern: /A rule frozen or pre-registered before outcome measurement MUST require an expected qualifying-member count computed from structural quantities, a numeric feasibility floor, and revision below that floor before any outcome is seen\./,
  },
  {
    id: 'operator-figure-anti-anchoring',
    pattern: /An operator-supplied numeric expectation MUST require both exact result fields `within_expected_range` and `method_was_not_adjusted_to_match_expectation`\./,
  },
  {
    id: 'default-parallelism',
    pattern: /Default to parallel execution\./,
  },
  {
    id: 'genuine-data-dependencies-only',
    pattern: /add an edge ONLY when the downstream stage has a genuine data dependency/,
  },
  {
    id: 'one-reason-per-dependency',
    pattern: /For every explicit `depends_on` entry, `dependency_reasons` MUST contain exactly one matching key whose value is one sentence/,
  },
  {
    id: 'temporary-work-under-os-root',
    pattern: /temporary or one-off work product[\s\S]*`os\.tmpdir\(\)` \/ `\$TMPDIR`/,
  },
  {
    id: 'drvfs-rationale',
    pattern: /WSL2 drvfs mount[\s\S]*more than 6× slower/,
  },
  {
    id: 'project-output-exceptions',
    pattern: /Normal project outputs `dist\/`, `ui\/dist\/`, and the project's own `node_modules` are explicit exceptions/,
  },
] as const;

const GROUND_TRUTH_MUTATIONS = [
  {
    id: 'writable-gate-scope',
    original: 'include every such project-relative writable path',
    weakened: 'include whichever project-relative writable paths are convenient',
  },
  {
    id: 'terminal-path-final-stage-only',
    original: 'written only by the final stage',
    weakened: 'written by any stage',
  },
  {
    id: 'raw-validation-exit-forbidden',
    original: 'MUST NOT make its verdict the unprocessed exit status',
    weakened: 'may make its verdict the unprocessed exit status',
  },
] as const;

const LINEAR_BY_DEFAULT = [
  /(?:stages|workflow) (?:must|should) (?:form|follow|use) (?:a )?(?:strictly )?linear chain by default/i,
  /each stage (?:must|should) depend on (?:the )?previous stage/i,
];

const REALITY_CHECK_CLAUSES = [
  {
    id: 'ban-whole-document-single-literal',
    pattern: /Documentation-completeness checks MUST NOT use a single literal match across an\s+entire document\./,
  },
  {
    id: 'prefer-structure-or-omit',
    pattern: /Prefer a heading anchor, a structure or non-empty\/length assertion,\s+or omit the deterministic check/,
  },
  {
    id: 'leave-content-quality-to-human-review',
    pattern: /content quality belongs to human review, not `grep`/,
  },
  {
    id: 'accept-equivalent-terminology',
    pattern: /MUST accept common\s+equivalent spellings and phrasings[\s\S]*both `risk=external` and\s+`` `risk` is exactly `external` ``/,
  },
  {
    id: 'terminology-is-advisory',
    pattern: /It MUST set `advisory: true`/,
  },
  {
    id: 'warn-about-wording-false-negatives',
    pattern: /failure\s+message MUST explicitly say `wording check; possible false negative`/,
  },
  {
    id: 'objective-evidence-remains-hard',
    pattern: /Evidence checks \(file existence, command exit code,\s+numeric thresholds, schema\/integrity constraints\) MUST stay hard/,
  },
  {
    id: 'planner-reads-preflight-feedback',
    pattern: /if \{run_dir\}\/reality_check_preflight\.json exists,\s+read it before writing new checks/,
  },
  {
    id: 'advisories-have-explicit-delivery',
    pattern: /marks intent-dependent findings advisory in `reality_checks\.md` before\s+dispatch[\s\S]*emits an operator-visible\s+`reality_gate_advisory` run event/,
  },
] as const;

const REALITY_CHECK_ADMISSIBILITY_CLAUSES = [
  {
    id: 'check-can-fail',
    pattern: /A hard Reality-Gate\s+check is admissible only if it is capable of failing/,
  },
  {
    id: 'failure-set-matches-claimed-property',
    pattern: /every state in which it fails must be\s+one where the contract property named by the check is false/,
  },
  {
    id: 'derive-property-with-exceptions',
    pattern: /Derive that property from the brief,\s+including every explicit exception/,
  },
] as const;

const MOTIVATING_FALSE_BLOCK = /observed: a clean gated-0 round was wrongly\s+`reality_gate_failed` because a self-authored archived-copy path was absent/;
const FORMER_INSTANCE_ONLY_RULE = [
  'ROBUST checks only — verify INTEGRITY INVARIANTS, not your own bookkeeping.',
  'A reality check may reference ONLY required files.',
  'Do NOT require EXTRA self-created archive/copy files or assert byte-equality between copies.',
].join(' ');

function readPlannerPrompt(): string {
  const parsed = parse(readFileSync(PLANNER_PATH, 'utf-8')) as PlannerConfig;
  if (typeof parsed.prompt !== 'string') throw new Error('planner.yaml must contain a string prompt');
  return parsed.prompt;
}

function readShipSkill(): string {
  return readFileSync(SHIP_SKILL_PATH, 'utf-8');
}

function contractViolations(prompt: string): string[] {
  const missing = REQUIRED_CLAUSES
    .filter(({ pattern }) => !pattern.test(prompt))
    .map(({ id }) => `missing:${id}`);
  const unsafe = LINEAR_BY_DEFAULT
    .filter((pattern) => pattern.test(prompt))
    .map(() => 'forbidden:linear-by-default');
  return [...missing, ...unsafe];
}

function realityCheckContractViolations(prompt: string): string[] {
  const missing = [...REALITY_CHECK_CLAUSES, ...REALITY_CHECK_ADMISSIBILITY_CLAUSES]
    .filter(({ pattern }) => !pattern.test(prompt))
    .map(({ id }) => `missing:${id}`);
  const instanceOnly = /self-created archive\/copy files/i.test(prompt)
    && /byte-equality between copies/i.test(prompt)
    && REALITY_CHECK_ADMISSIBILITY_CLAUSES.some(({ pattern }) => !pattern.test(prompt));
  return [...missing, ...(instanceOnly ? ['forbidden:instance-only-enumeration'] : [])];
}

function referenceExamples(prompt: string): string {
  const examples = prompt.split('# Reference Examples', 2)[1];
  if (!examples) throw new Error('planner prompt must contain reference examples');
  return examples.split('# Runtime Context Handlers', 1)[0];
}

describe('planner dispatch contract', () => {
  it('names the invalid dispatch field and a repair action', () => {
    const parsed = StageConfigSchema.safeParse({ id: 'work', role: 'coder', scope: 'src/**' });
    if (parsed.success) throw new Error('invalid dispatch fixture unexpectedly parsed');

    const message = formatDispatchStageSchemaFailure(parsed.error);
    expect(message).toContain('scope:');
    expect(message).toMatch(/fix the named fields.*regenerate dispatch\.yaml/i);
    expect(() => StageConfigSchema.parse({ id: 'work', role: 'coder', timeout_ms: 1_000 }))
      .toThrow('config/defaults.yaml::default_timeout_ms');
    expect(readPlannerPrompt()).not.toMatch(/^\s+timeout_(?:total_)?ms:/m);
  });

  it('requires safe parallel scope, real dependency reasons, and TMPDIR placement', () => {
    expect(contractViolations(readPlannerPrompt())).toEqual([]);
    expect(readPlannerPrompt()).toMatch(/\n\s*13\. A hard Reality-Gate check MUST NOT make its verdict/);
  });

  it.each(REQUIRED_CLAUSES)('rejects omission of $id', ({ id, pattern }) => {
    const prompt = readPlannerPrompt();
    const match = prompt.match(pattern);
    expect(match, `fixture setup must find ${id}`).not.toBeNull();
    const withoutClause = prompt.replace(match![0], '');
    expect(contractViolations(withoutClause)).toContain(`missing:${id}`);
  });

  it.each(GROUND_TRUTH_MUTATIONS)('rejects weakening of $id', ({ id, original, weakened }) => {
    const prompt = readPlannerPrompt();
    expect(prompt, `fixture setup must find ${id}`).toContain(original);
    expect(contractViolations(prompt.replace(original, weakened))).toContain(`missing:${id}`);
  });

  it.each([
    'Stages should form a linear chain by default.',
    'Each stage must depend on the previous stage.',
  ])('rejects linear-by-default guidance: %s', (unsafeGuidance) => {
    expect(contractViolations(`${readPlannerPrompt()}\n${unsafeGuidance}`))
      .toContain('forbidden:linear-by-default');
  });

  it('keeps reference examples free of task-brief reinjection', () => {
    const examples = referenceExamples(readPlannerPrompt());
    expect(examples).not.toContain('{task_description}');
    expect(examples).not.toMatch(/^\s*Task:/m);
  });
});

describe('planner reality-check contract', () => {
  it('uses a general failure-set criterion alongside structural and advisory guidance', () => {
    expect(realityCheckContractViolations(readPlannerPrompt())).toEqual([]);
  });

  it.each([...REALITY_CHECK_CLAUSES, ...REALITY_CHECK_ADMISSIBILITY_CLAUSES])('rejects omission of $id', ({ id, pattern }) => {
    const prompt = readPlannerPrompt();
    const match = prompt.match(pattern);
    expect(match, `fixture setup must find ${id}`).not.toBeNull();
    const withoutClause = prompt.replace(match![0], '');
    expect(realityCheckContractViolations(withoutClause)).toContain(`missing:${id}`);
  });

  it('rejects the former two-instance enumeration as a substitute for the criterion', () => {
    expect(realityCheckContractViolations(FORMER_INSTANCE_ONLY_RULE)).toEqual(expect.arrayContaining([
      'missing:check-can-fail',
      'missing:failure-set-matches-claimed-property',
      'missing:derive-property-with-exceptions',
      'forbidden:instance-only-enumeration',
    ]));
  });

  it('preserves the incident that explains why the criterion exists', () => {
    expect(readPlannerPrompt()).toMatch(MOTIVATING_FALSE_BLOCK);
  });
});

describe('public gate and launch-workspace contract', () => {
  it('documents attempt-fresh metrics, durable verdicts, recursive overlays, and population parity', () => {
    const guide = readFileSync(BRIEF_CONTRACT_PATH, 'utf-8');
    expect(guide).toMatch(/Before each execution, the scheduler replaces any older metric artifact\s+with an engine-owned `hasMetric:false` marker/);
    expect(guide).toMatch(/omission fails the run at that first gate\s+evaluation[\s\S]*before any product repair\s+or outer re-plan is dispatched/);
    expect(guide).toMatch(/Gate prompts\s+receive the exact durable path where a rejection will be archived/);
    expect(guide).toMatch(/setup walks the source directory, materializes missing subdirectories, and\s+copies their files into the target/);
    expect(guide).toMatch(/compares the normalized source and target\s+identity sets—not\s+just their counts—and refuses setup/);
    expect(guide).toMatch(/whether or not the brief remembered to declare the ignored test\s+directory/);
  });
});

describe('ship authoring and operator bookkeeping contract', () => {
  it('requires leading input declarations rather than prose or table references', () => {
    expect(readShipSkill()).toMatch(/Declare every source input in a leading frontmatter `inputs:` block\.[\s\S]*A path in prose or a table is\s+only a reference, not a declaration/);
  });

  it('specifies one exact post-launch wrap-up sentence and lifecycle updates', () => {
    const skill = readShipSkill();
    expect(skill).toContain(LAUNCH_WRAP_UP_SENTENCE);
    expect(skill).toMatch(/After cancellation, update or remove that entry\. After re-shipping, replace its id with the new one\./);
  });

  it('keeps the moving ownership boundary explicit', () => {
    const skill = readShipSkill();
    const section = skill.match(/### 2\.\d+ Divide ownership by whether failure announces itself\n([\s\S]*?)(?=\n### 2\.\d+ )/)?.[0];
    expect(section).toBeDefined();
    expect(section).toMatch(/research loop explores within the question[\s\S]*operator changes the question/);
    expect(section).toMatch(/failure announces itself or returns\s+a plausible value/);
    expect(section).toMatch(/boundary moves/);
  });
});
