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
const expectedCriteriaCorpusSha256 = '3b7f6221a359201f34d47c77e70229f40c21436ad76599c803833b0c2b9fb352';

interface CriteriaCorpusCase {
  id: string;
  text: string;
  expectedWarnings: number;
  tags: string[];
}

interface CriteriaCorpus {
  version: number;
  cases: CriteriaCorpusCase[];
}

function readCriteriaCorpus(): CriteriaCorpus {
  return JSON.parse(readFileSync(join(repositoryRoot, criteriaCorpusPath), 'utf-8')) as CriteriaCorpus;
}

function criteriaCorpusDigest(cases: readonly CriteriaCorpusCase[]): string {
  const canonicalCases = cases.map((entry) => ({
    id: entry.id,
    text: entry.text.replace(/\r\n?|\n/g, '\n'),
    expectedWarnings: entry.expectedWarnings,
    tags: [...entry.tags].sort(),
  }));
  return createHash('sha256').update(JSON.stringify(canonicalCases), 'utf8').digest('hex');
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

  it('loads a closed, tracked corpus with stable IDs and a canonical digest', () => {
    const corpus = readCriteriaCorpus();
    const allowedTags = new Set(['positive', 'negative', 'zh', 'example-not-criterion']);

    expect(Object.keys(corpus).sort()).toEqual(['cases', 'version']);
    expect(corpus.version).toBe(1);
    expect(Array.isArray(corpus.cases)).toBe(true);
    expect(corpus.cases.map(({ id }) => id)).toEqual(expectedCriteriaCaseIds);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);

    for (const entry of corpus.cases) {
      expect(Object.keys(entry).sort(), entry.id).toEqual(['expectedWarnings', 'id', 'tags', 'text']);
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.text.trim().length, entry.id).toBeGreaterThan(0);
      expect(Number.isInteger(entry.expectedWarnings), entry.id).toBe(true);
      expect(entry.expectedWarnings, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.tags, entry.id).toEqual([...new Set(entry.tags)].sort());
      expect(entry.tags.every((tag) => allowedTags.has(tag)), entry.id).toBe(true);
      expect(entry.tags, entry.id).toContain(entry.expectedWarnings > 0 ? 'positive' : 'negative');
      expect(entry.tags, entry.id).not.toContain(entry.expectedWarnings > 0 ? 'negative' : 'positive');
    }
    for (const requiredTag of allowedTags) {
      expect(corpus.cases.some(({ tags }) => tags.includes(requiredTag)), requiredTag).toBe(true);
    }

    expect(criteriaCorpusDigest(corpus.cases)).toBe(expectedCriteriaCorpusSha256);
    const trackedPaths = execFileSync(
      'git',
      ['ls-files', '-z', '--', criteriaCorpusPath],
      { cwd: repositoryRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 10_000 },
    ).split('\0').filter(Boolean);
    expect(trackedPaths).toEqual([criteriaCorpusPath]);
  });

  it('matches every committed corpus case to its exact warning outcome', () => {
    for (const entry of readCriteriaCorpus().cases) {
      expect(lintInstrumentCriteria(entry.text), entry.id).toHaveLength(entry.expectedWarnings);
    }
  });
});

describe('Vitest experimental API upgrade guard', () => {
  it('changes comments only in vitest.config.ts', () => {
    const source = readFileSync(join(repositoryRoot, 'vitest.config.ts'), 'utf-8');
    const normalized = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        removeComments: true,
      },
    }).outputText;
    // The pin below is deliberately re-based on 2026-08-04. `65503e8` (M7 delivery truth
    // table) added react-dom / @testing-library aliases and a jest-dom setup entry so the
    // root suite can resolve the UI tests it had just moved from `tests/` into `spec/`.
    // That change is additive with respect to #41: the only removed line was
    // `setupFiles: ["./vitest.setup.ts"]`, replaced by a list that still contains it.
    // Every #41 mitigation asserted below was verified present before re-basing the pin.
    // Re-base this pin ONLY after checking the four assertions that follow still hold —
    // they, not the digest, are what keeps #41 closed.
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(
      'e535bd61603e29edcada1824f43a86af09e4270930c0d9d0547fee3ccd81d166',
    );
    expect(source).toContain('Vitest experimental');
    expect(source).toContain('createPoolWorker contract');
    expect(source).toContain('maxWorkers: 1');
    expect(source).toContain('437.80s -> 1131.80s');
  });
});
