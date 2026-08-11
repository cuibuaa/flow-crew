import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const PLANNER_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml');
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
] as const;

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
  return REALITY_CHECK_CLAUSES
    .filter(({ pattern }) => !pattern.test(prompt))
    .map(({ id }) => `missing:${id}`);
}

function referenceExamples(prompt: string): string {
  const examples = prompt.split('# Reference Examples', 2)[1];
  if (!examples) throw new Error('planner prompt must contain reference examples');
  return examples.split('# Runtime Context Handlers', 1)[0];
}

describe('planner dispatch contract', () => {
  it('requires safe parallel scope, real dependency reasons, and TMPDIR placement', () => {
    expect(contractViolations(readPlannerPrompt())).toEqual([]);
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
  it('uses structural documentation evidence and treats terminology matching as advisory', () => {
    expect(realityCheckContractViolations(readPlannerPrompt())).toEqual([]);
  });

  it.each(REALITY_CHECK_CLAUSES)('rejects omission of $id', ({ id, pattern }) => {
    const prompt = readPlannerPrompt();
    const match = prompt.match(pattern);
    expect(match, `fixture setup must find ${id}`).not.toBeNull();
    const withoutClause = prompt.replace(match![0], '');
    expect(realityCheckContractViolations(withoutClause)).toContain(`missing:${id}`);
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

  it('keeps the moving ownership boundary explicit and under twenty lines', () => {
    const skill = readShipSkill();
    const section = skill.match(/### 2\.5 Divide ownership by whether failure announces itself\n([\s\S]*?)(?=\n### 2\.6)/)?.[0];
    expect(section).toBeDefined();
    expect(section!.split(/\r?\n/).length).toBeLessThan(20);
    expect(section).toMatch(/research loop explores within the question[\s\S]*operator changes the question/);
    expect(section).toMatch(/failure announces itself or returns\s+a plausible value/);
    expect(section).toMatch(/boundary moves/);
    expect(readShipSkill().split(/\r?\n/).length - 1).toBeLessThanOrEqual(300);
  });
});
