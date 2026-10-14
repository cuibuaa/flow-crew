import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  lintInstrumentCriteria,
  rehearsalExitCode,
  type Finding,
} from '../src/rehearse.js';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { applyBasePrompt, loadBasePrompt } from '../src/scheduler/sched_admission/dispatch.js';

const repositoryRoot = join(import.meta.dirname, '..');

function reviewerPrompt(): string {
  const directory = join(repositoryRoot, 'config', 'agents');
  const role = parseAgent(parseYaml(readFileSync(join(directory, 'qa.yaml'), 'utf8')));
  return applyBasePrompt(role, loadBasePrompt(directory)).prompt;
}
const criteriaCorpusPath = 'spec/fixtures/e8_criteria_lint_corpus.json';
interface CriteriaCorpusCase {
  id: string;
  text: string;
  tags: string[];
}

interface CriteriaCorpus {
  version: number;
  cases: CriteriaCorpusCase[];
}

function readCriteriaCorpus(): CriteriaCorpus {
  return JSON.parse(readFileSync(join(repositoryRoot, criteriaCorpusPath), 'utf-8')) as CriteriaCorpus;
}

describe('QA property-versus-means contract', () => {
  it('accepts alternate evidence for an illustrative means and exposes a wording conflict', () => {
    const prompt = reviewerPrompt();
    const scenario = {
      instruction: '证明真实浏览器环境被执行；例如探针可直接导入并实例化库 X。',
      evidence: '产物通过真实 test runner 的环境路径证明了性质，但没有直接导入库 X。',
    };
    expect(scenario.instruction).toContain('例如');
    expect(scenario.evidence).toContain('证明了性质');
    expect(prompt).toContain('Examples do not exclude equivalent property evidence');
    expect(prompt).toContain('A wording/property conflict identifies its originating');
    expect(prompt).toContain('sentence');
    expect(prompt).toContain('reproducible evidence');
  });

  it('keeps exact means and thresholds hard, and compatibility binding unless the brief allows documentation', () => {
    const prompt = reviewerPrompt();
    expect(prompt).toContain('unless the criterion explicitly requires that means');
    expect(prompt).toContain(
      'a confirmed compatibility requirement remains binding unless the brief itself allows that incompatibility to be documented instead, in which case documenting it with its cause and evidence satisfies it',
    );
    expect(prompt).toContain('never invent a threshold or waive a supplied one');
    expect(prompt).toContain('reproducible evidence');
  });
});

describe('criterion wording lint', () => {
  it('warns with source, risk, and rewrite advice for a broken instrument criterion', () => {
    const source = '# 验收判据\n\n源码里必须出现 `new JSDOM(...)`。\n';
    const warnings = lintInstrumentCriteria(source);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      line: 3,
      excerpt: '源码里必须出现 `new JSDOM(...)`。',
    });
    expect(warnings[0].risk).toContain('hard assertion');
    expect(warnings[0].risk).toContain('target property');
    expect(warnings[0].suggestion).toContain('observable property');
    expect(warnings[0].suggestion).toContain('example rather than a criterion');
  });

  it('recognizes concrete bare module names bound to mandatory import wording', () => {
    const cases = [
      '探针源码里必须出现 jsdom 的 import 与实例化。',
      'The probe must import jsdom.',
      'must import @scope/runtime-pool.',
    ];

    for (const source of cases) {
      const warnings = lintInstrumentCriteria(source);
      expect(warnings, source).toHaveLength(1);
      expect(warnings[0].excerpt).toBe(source);
      expect(warnings[0].risk).toContain('hard assertion');
    }
  });

  it('does not promote an explicitly illustrative means into a warning', () => {
    expect(lintInstrumentCriteria([
      '# 要求',
      '证明真实环境路径，例如源码里可以调用 `createEnvironment()`；这是例子，不是判据。',
      '',
      '可采用以下手段，例如:',
      '- 源码里必须导入 `library-x`',
      '- must call `createLibraryX()`',
    ].join('\n'))).toEqual([]);
  });

  it('does not treat an ordinary prose object of import as a bare module name', () => {
    expect(lintInstrumentCriteria(
      'The probe must import the configuration produced by the operator.',
    )).toEqual([]);
  });

  it('keeps criterion findings advisory in the rehearsal exit contract', () => {
    const warnings: Finding[] = lintInstrumentCriteria('源码里必须出现 `new JSDOM(...)`。')
      .map((warning) => ({ level: 'warn', text: warning.excerpt }));
    expect(rehearsalExitCode(warnings)).toBe(0);
    expect(rehearsalExitCode([...warnings, { level: 'fail', text: 'broken frontmatter' }])).toBe(1);
  });

  it('matches every committed corpus case to its independently authored classification', () => {
    for (const entry of readCriteriaCorpus().cases) {
      const warnings = lintInstrumentCriteria(entry.text);
      if (entry.tags.includes('positive')) expect(warnings.length, entry.id).toBeGreaterThan(0);
      else expect(warnings, entry.id).toEqual([]);
    }
  });
});

describe('Vitest experimental API upgrade guard', () => {
  it('keeps the ready-aware worker contract stable across unrelated config edits', () => {
    const source = readFileSync(join(repositoryRoot, 'vitest.config.ts'), 'utf-8');
    const normalized = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        removeComments: true,
      },
    }).outputText;
    // The pin below is deliberately re-based on 2026-08-05. An `esbuild: { jsx: "automatic" }`
    // block was added because vite was pinned to 7.3.6 (via a root `overrides` entry) to route
    // around a rolldown native-binding load failure that reproduced deterministically on
    // GitHub Actions but not locally under a matching npm version or a cold cache. Vite 7 uses
    // rollup + esbuild, not rolldown, and its default esbuild JSX handling left `React` out of
    // scope for every `spec/**/*.test.tsx` file (`ReferenceError: React is not defined`) until
    // this explicit automatic-runtime setting was added. The change is additive with respect
    // to #41: nothing in the experimental pool/worker block below was touched.
    // Re-based again on 2026-08-10 after the published config stopped collecting the
    // private machine-local suite. That include-scope change did not touch the #41
    // worker implementation, and every mitigation asserted below was verified first.
    // Re-based on 2026-09-03 after permanent UX/performance replays rejoined the
    // current full suite while the frozen baseline population received its own
    // explicit timing command. This changes discovery only, not worker startup.
    // Re-base this pin ONLY after checking the four assertions that follow still hold —
    // they, not the digest, are what keeps #41 closed.
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(
      '81fde17f2c63efe8dccfd2544c6c9fa19cee2d7c51244a9029e503cfea757035',
    );
    expect(source).toContain('Vitest experimental');
    expect(source).toContain('createPoolWorker contract');
    expect(source).toContain('maxWorkers: 1');
    expect(source).toContain('437.80s -> 1131.80s');
  });
});
