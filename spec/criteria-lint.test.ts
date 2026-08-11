import { execFileSync } from 'node:child_process';
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

const repositoryRoot = join(import.meta.dirname, '..');
const criteriaCorpusPath = 'spec/fixtures/e8_criteria_lint_corpus.json';
const expectedCriteriaCaseIds = [
  'en-illustrative-list',
  'en-mandatory-bare-module',
  'en-ordinary-import-object',
  'zh-illustrative-not-criterion',
  'zh-mandatory-constructor',
];

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
    const qa = parseYaml(readFileSync(join(repositoryRoot, 'config', 'agents', 'qa.yaml'), 'utf-8')) as {
      prompt: string;
    };
    const scenario = {
      instruction: '证明真实浏览器环境被执行；例如探针可直接导入并实例化库 X。',
      evidence: '产物通过真实 test runner 的环境路径证明了性质，但没有直接导入库 X。',
    };
    expect(scenario.instruction).toContain('例如');
    expect(scenario.evidence).toContain('证明了性质');
    expect(qa.prompt).toContain('split each operator instruction into (a) the observable property');
    expect(qa.prompt).toContain('is illustrative, not a hard assertion');
    expect(qa.prompt).toContain('MUST NOT fail solely because it differs from that example');
    expect(qa.prompt).toContain('property-vs-wording conflict');
    expect(qa.prompt).toContain('Quote or precisely locate the operator sentence');
    expect(qa.prompt).toContain('state the substantive evidence that passed');
  });

  it('keeps explicit exact means and measurable thresholds hard', () => {
    const qa = parseYaml(readFileSync(join(repositoryRoot, 'config', 'agents', 'qa.yaml'), 'utf-8')) as {
      prompt: string;
    };
    expect(qa.prompt).toContain('the exact means itself is an acceptance criterion and alternatives do not count');
    expect(qa.prompt).toContain('Hard numbers, thresholds, required outputs, compatibility constraints');
    expect(qa.prompt).toContain('fail normally and say that equivalent means do not satisfy');
    expect(qa.prompt).toContain('Keep mechanizing acceptance criteria into reproducible assertions');
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

  it('loads a closed, tracked corpus with stable IDs and qualitative classifications', () => {
    const corpus = readCriteriaCorpus();
    const allowedTags = new Set(['positive', 'negative', 'zh', 'example-not-criterion']);

    expect(Object.keys(corpus).sort()).toEqual(['cases', 'version']);
    expect(corpus.version).toBe(1);
    expect(Array.isArray(corpus.cases)).toBe(true);
    expect(corpus.cases.map(({ id }) => id)).toEqual(expectedCriteriaCaseIds);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);

    for (const entry of corpus.cases) {
      expect(Object.keys(entry).sort(), entry.id).toEqual(['id', 'tags', 'text']);
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.text.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.tags, entry.id).toEqual([...new Set(entry.tags)].sort());
      expect(entry.tags.every((tag) => allowedTags.has(tag)), entry.id).toBe(true);
      expect(entry.tags.filter((tag) => tag === 'positive' || tag === 'negative'), entry.id).toHaveLength(1);
    }
    for (const requiredTag of allowedTags) {
      expect(corpus.cases.some(({ tags }) => tags.includes(requiredTag)), requiredTag).toBe(true);
    }

    const trackedPaths = execFileSync(
      'git',
      ['ls-files', '-z', '--', criteriaCorpusPath],
      { cwd: repositoryRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 10_000 },
    ).split('\0').filter(Boolean);
    expect(trackedPaths).toEqual([criteriaCorpusPath]);
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
    // Re-base this pin ONLY after checking the four assertions that follow still hold —
    // they, not the digest, are what keeps #41 closed.
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(
      '707baf7415d51f0ad9092186a3840b588d65aba9fc3156269879ac65d60464ea',
    );
    expect(source).toContain('Vitest experimental');
    expect(source).toContain('createPoolWorker contract');
    expect(source).toContain('maxWorkers: 1');
    expect(source).toContain('437.80s -> 1131.80s');
  });
});
