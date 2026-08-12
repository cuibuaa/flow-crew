import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import {
  demoteRealityCheckAdvisories,
  inspectRealityChecks,
  type RealityCheckPreflightCode,
} from '../src/reality-check-preflight.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const AGENTS_DIR = join(PROJECT_ROOT, 'config', 'agents');

const CONTRACT_BRIEF = [
  '---',
  'terminal_states:',
  '  complete:',
  '    paths: [docs/final.md]',
  '---',
  '# Contract',
  'The final stage must write `docs/final.md` with all required evidence.',
  'Historical entries in `CHANGELOG.md` containing `legacy/private-area/` must be preserved.',
  'Validation succeeds when the project validation command exits zero.',
  'The report count must equal the number independently recomputed from the data.',
].join('\n');

interface CheckFixture {
  name: string;
  type: string;
  params: Record<string, unknown>;
  advisory?: boolean;
}

function checksMarkdown(...checks: CheckFixture[]): string {
  return ['## Reality checks', '```yaml', stringify({ checks }).trimEnd(), '```'].join('\n');
}

function findingCodes(check: CheckFixture, brief = CONTRACT_BRIEF): RealityCheckPreflightCode[] {
  return inspectRealityChecks(brief, checksMarkdown(check)).findings.map(({ code }) => code);
}

function tierCodes(check: CheckFixture, brief = CONTRACT_BRIEF): {
  blocking: RealityCheckPreflightCode[];
  advisory: RealityCheckPreflightCode[];
} {
  const report = inspectRealityChecks(brief, checksMarkdown(check));
  return {
    blocking: report.blockingTierFindings.map(({ code }) => code),
    advisory: report.advisoryFindings.map(({ code }) => code),
  };
}

const BAD_CHECKS: Array<{
  label: string;
  check: CheckFixture;
  code: RealityCheckPreflightCode;
  tier: 'blocking' | 'advisory';
}> = [
  {
    label: 'an exact Markdown heading used as a proxy for required evidence',
    check: {
      name: 'report contains validation evidence',
      type: 'exec-script-exit-zero',
      params: { script: "grep -q '## Validation' docs/final.md" },
    },
    code: 'presentation_proxy_heading_literal',
    tier: 'advisory',
  },
  {
    label: 'a forbidden-pattern scan that contradicts an explicit preservation exception',
    check: {
      name: 'published sources omit the former private area',
      type: 'static-ast-scan',
      params: { glob: 'CHANGELOG.md', language: 'markdown', forbid_pattern: 'legacy/private-area/' },
    },
    code: 'contract_exception_conflict',
    tier: 'advisory',
  },
  {
    label: 'existence of an artifact the contract never requires',
    check: {
      name: 'archive copy exists',
      type: 'file-exists-nonempty',
      params: { paths: ['docs/archive-copy.md'] },
    },
    code: 'undeclared_artifact_existence',
    tier: 'advisory',
  },
  {
    label: 'byte equality between two copies',
    check: {
      name: 'archive copy exactly matches report',
      type: 'exec-script-exit-zero',
      params: { script: 'cmp -s docs/final.md docs/archive-copy.md' },
    },
    code: 'copy_byte_equivalence',
    tier: 'blocking',
  },
];

const GOOD_CHECKS: Array<{ label: string; check: CheckFixture }> = [
  {
    label: 'a declared terminal artifact exists and is non-empty',
    check: {
      name: 'terminal report exists',
      type: 'file-exists-nonempty',
      params: { paths: ['docs/final.md'] },
    },
  },
  {
    label: 'a validation command exits zero',
    check: {
      name: 'project validation passes',
      type: 'exec-script-exit-zero',
      params: { script: 'npm run test' },
    },
  },
  {
    label: 'a report number equals an independently recomputed number',
    check: {
      name: 'reported count matches source data',
      type: 'exec-script-exit-zero',
      params: {
        script: 'node -e "const report=require(\'./docs/report.json\');const data=require(\'./data.json\');if(report.count!==data.items.length)process.exit(1)"',
      },
    },
  },
];

describe('planner Reality-Gate check preflight', () => {
  it.each(BAD_CHECKS)('flags $label', ({ check, code }) => {
    expect(findingCodes(check)).toEqual([code]);
  });

  it.each(GOOD_CHECKS)('accepts $label', ({ check }) => {
    expect(findingCodes(check)).toEqual([]);
  });

  it.each(BAD_CHECKS)('assigns $label to the $tier tier', ({ check, code, tier }) => {
    expect(tierCodes(check)).toEqual({
      blocking: tier === 'blocking' ? [code] : [],
      advisory: tier === 'advisory' ? [code] : [],
    });
  });

  it('blocks a hard command that is mechanically incapable of failing', () => {
    expect(tierCodes({
      name: 'validation always passes',
      type: 'exec-script-exit-zero',
      params: { script: 'true' },
    })).toEqual({ blocking: ['hard_check_cannot_fail'], advisory: [] });
  });

  it('rewrites only intent-dependent findings as runtime-advisory declarations', () => {
    const markdown = checksMarkdown(...BAD_CHECKS.map(({ check }) => check));
    const report = inspectRealityChecks(CONTRACT_BRIEF, markdown);
    const rewrite = demoteRealityCheckAdvisories(markdown, report.advisoryFindings);
    expect(rewrite.demotedCheckIndexes).toEqual([1, 2, 3]);
    expect(parseChecksFromMarkdown(rewrite.markdown).map((declaration) =>
      declaration.kind === 'invalid' ? undefined : declaration.advisory === true))
      .toEqual([true, true, true, false]);
  });

  it('does not turn an explicitly advisory wording check into a blocking finding', () => {
    expect(findingCodes({ ...BAD_CHECKS[0].check, advisory: true })).toEqual([]);
  });
});

describe('historical planner syntax regressions', () => {
  const requiredArtifactCases: Array<{
    label: string;
    brief: string;
    paths: string[];
  }> = [
    {
      label: 'absolute outputs matched to required templated relative paths',
      brief: [
        '# Deliverable',
        'Per-round output (where to write results): `reports/v<n>/summary.md`.',
        'Record the operator-facing verdict in `RETURN_REPORT.md`.',
      ].join('\n'),
      paths: ['/workspace/reports/v17/summary.md', '/workspace/state/RETURN_REPORT.md'],
    },
    {
      label: 'the framework knowledge graph required by the brief',
      brief: '# Deliverable\nUpdate the run-local knowledge graph (KG) with the result.',
      paths: ['/workspace/run/knowledge_graph.json'],
    },
    {
      label: 'a result_file key in a legacy metadata block',
      brief: '# Contract\nresult_file: docs/round/round_result.json',
      paths: ['docs/round/round_result.json'],
    },
    {
      label: 'an imperative production sentence continued on the next line',
      brief: 'Deliverable:\n`paper/PAPER.md` and a short `paper/verification_report.md`.',
      paths: ['paper/PAPER.md', 'paper/verification_report.md'],
    },
    {
      label: 'a Chinese unique-deliverable sentence',
      brief: '**唯一交付物：`docs/design_systemic_review.md`。**',
      paths: ['docs/design_systemic_review.md'],
    },
    {
      label: 'Chinese content obligations on a concrete result path',
      brief: '`research/direction/d2/result.json` 须含完整结果。',
      paths: ['research/direction/d2/result.json'],
    },
    {
      label: 'numbered artifacts introduced by an obligation',
      brief: [
        'The required artifacts are:',
        '1. `docs/review/stage_<N>_verdict.md`',
        '2. `research/review/stage_<N>/round_result.json`',
      ].join('\n'),
      paths: ['docs/review/stage_1_verdict.md', 'research/review/stage_1/round_result.json'],
    },
    {
      label: 'an implementation path in an explicit one-implementation constraint',
      brief: '上述检查只有一个实现，全部入口共用 `src/brief-preflight.ts`。',
      paths: ['src/brief-preflight.ts'],
    },
    {
      label: 'relocated files whose destination preserves the declared basenames',
      brief: [
        '### Files to migrate',
        'Candidates under `private-specs/*.test.ts` include `status-guard` and `engine-scenarios`.',
        'Move the accepted files into `spec/`, preserving each filename.',
      ].join('\n'),
      paths: ['spec/status-guard.test.ts', 'spec/engine-scenarios.test.ts'],
    },
    {
      label: 'a whole document set migrated while preserving filenames',
      brief: [
        '### Public-document migration',
        'The existing public set includes `private-docs/reality-gate.md`.',
        'Move all public documents into `guide/`, preserving filenames.',
      ].join('\n'),
      paths: ['guide/architecture.md', 'guide/configuration.md', 'guide/reality-gate.md'],
    },
    {
      label: 'a quantified Markdown migration declared in Chinese',
      brief: [
        '### 公开文档迁移',
        '把 `private-docs/` 中的全部 Markdown 文档移动到 `guide/`，保持文件名。',
      ].join('\n'),
      paths: ['guide/architecture.md', 'guide/configuration.md', 'guide/skills.md'],
    },
    {
      label: 'a numbered figure heading that specifies its output path',
      brief: '### Figure 1 — `docs/assets/authority.svg`: completion authority',
      paths: ['docs/assets/authority.svg'],
    },
    {
      label: 'a research ceiling report when a rigorous negative is a valid deliverable',
      brief: [
        '---',
        'research:',
        '  baseline: 1',
        '  report_dir: docs/research',
        '---',
        '# Contract',
        'A rigorous negative at the ceiling is a valid deliverable.',
      ].join('\n'),
      paths: ['docs/research/ceiling_report.md'],
    },
  ];

  it.each(requiredArtifactCases)('accepts $label', ({ brief, paths }) => {
    expect(findingCodes({
      name: 'required artifacts exist',
      type: 'file-exists-nonempty',
      params: { paths },
    }, brief)).toEqual([]);
  });

  it('recovers readable output declarations without treating malformed frontmatter as empty', () => {
    const brief = [
      '---',
      'research:',
      '  result_file: docs/round/round_result.json',
      '  result_schema:',
      '    properties:',
      '      result: { type: number }# malformed adjacent comment',
      '---',
      '# Contract',
      'Produce the research result described by the metadata.',
    ].join('\n');
    expect(findingCodes({
      name: 'research outputs exist',
      type: 'file-exists-nonempty',
      params: { paths: ['docs/round/round_result.json', 'docs/round/supporting-result.json'] },
    }, brief)).toEqual([]);
  });

  it('accepts every member of a cardinality-declared git-mv artifact set', () => {
    const brief = [
      '# Public documentation migration',
      'Move the existing six tracked reference documents with `git mv` from `docs/` into `guide/`.',
      'The reference set is Markdown documentation whose filenames remain unchanged by the move.',
    ].join('\n');
    expect(findingCodes({
      name: 'migrated reference documents exist',
      type: 'file-exists-nonempty',
      params: {
        paths: [
          'guide/architecture.md',
          'guide/campaigns.md',
          'guide/cli.md',
          'guide/configuration.md',
          'guide/reality-gate.md',
          'guide/skills.md',
        ],
      },
    }, brief)).toEqual([]);
  });

  it('demotes planner-chosen behavioral-test filenames that the brief never contracts', () => {
    const brief = [
      '# Refactor contract',
      'Run the migration gate over `local-suite/*.test.ts` and move accepted existing tests into `spec/`.',
      'Add behavioral tests for the status guard, JSONL reader, and campaign context.',
      'The brief deliberately leaves their filenames to the implementer.',
      '> 参考实现（operator 的原型，可直接借鉴思路，不必照抄）：对每行做',
      '> `/(===|!==|includes\\(|\\bcase\\s+)\\s*[\'\"]<status>[\'\"]/` 匹配，跳过以 `//`/`*` 开头的行。',
    ].join('\n');
    const markdown = checksMarkdown({
      name: 'planner-selected behavioral test files exist',
      type: 'file-exists-nonempty',
      params: {
        paths: [
          'local-suite/status-literal-guard.test.ts',
          'local-suite/jsonl-reader.test.ts',
          'local-suite/campaign-context.test.ts',
        ],
      },
    });
    const report = inspectRealityChecks(brief, markdown);
    expect(report.blockingTierFindings).toEqual([]);
    expect(report.advisoryFindings.map(({ code }) => code))
      .toEqual([
        'undeclared_artifact_existence',
        'undeclared_artifact_existence',
        'undeclared_artifact_existence',
      ]);
    expect(demoteRealityCheckAdvisories(markdown, report.advisoryFindings).demotedCheckIndexes)
      .toEqual([1]);
  });

  const presentationCases: Array<{ label: string; script: string }> = [
    {
      label: 'a Python heading marker used as a required section boundary',
      script: [
        'report = Path("docs/final.md").read_text()',
        'marker = "## 3-line summary"',
        'assert marker in report',
        'tail = report.split(marker, 1)[1]',
      ].join('\n'),
    },
    {
      label: 'a Python list of Markdown headings asserted into documents',
      script: [
        'sections = ["## Abstract", "## Results", "## Conclusion"]',
        'for token in sections:',
        '    assert token in report',
      ].join('\n'),
    },
    {
      label: 'a Node search for an exact heading regex',
      script: [
        "const start = summary.search(/^# E10\\b/m);",
        "if (start < 0) throw new Error('missing section');",
      ].join('\n'),
    },
    {
      label: 'a Node findIndex over an exact heading regex',
      script: [
        "const start = lines.findIndex((line) => /^##\\s+Attribution matrix\\s*$/.test(line));",
        "if (start < 0) throw new Error('missing attribution section');",
      ].join('\n'),
    },
    {
      label: 'a Node array of exact heading regexes',
      script: [
        'const headings = [/^##\\s+Goal\\s*$/m, /^##\\s+Boundaries\\s*$/m];',
        "for (const heading of headings) if (!heading.test(body)) process.exit(1);",
      ].join('\n'),
    },
    {
      label: 'a numbered heading capture used as the evidence map',
      script: [
        'for (const line of lines) {',
        '  const match = /^## A([1-8])\\b/.exec(line);',
        '  if (match) sections.set(Number(match[1]), []);',
        '}',
        "for (let i = 1; i <= 8; i += 1) if (!sections.has(i)) throw new Error('missing section');",
      ].join('\n'),
    },
    {
      label: 'direct calls that slice a document by literal heading pairs',
      script: [
        'const section = (start, end) => {',
        '  const from = source.indexOf(start);',
        '  const to = source.indexOf(end, from + start.length);',
        "  if (from < 0 || to < 0) throw new Error('missing boundary');",
        '  return source.slice(from, to);',
        '};',
        "section('## Prior handoff', '## Extract the brief');",
      ].join('\n'),
    },
    {
      label: 'dynamic exact heading regular expressions',
      script: [
        "const headings = ['Baseline', 'Validation'];",
        'for (const heading of headings) {',
        '  if (!new RegExp(`^## ${heading}\\\\s*$`, \'m\').test(text)) process.exit(1);',
        '}',
      ].join('\n'),
    },
  ];

  it.each(presentationCases)('flags $label', ({ script }) => {
    expect(findingCodes({
      name: 'report contains the required evidence',
      type: 'exec-script-exit-zero',
      params: { script },
    }, '# Contract\nThe report must contain the required evidence.'))
      .toContain('presentation_proxy_heading_literal');
  });

  it('flags the historical blog check that hardens a suggested title into an exact H1', () => {
    const brief = [
      '# Writing contract',
      'Suggested title: **Building something that tells me the truth when I\'m not watching**',
      '(You may propose a better title, but the thesis must not change.)',
      'All six chapters, the starting point, and the close must exist in the supplied order.',
    ].join('\n');
    const script = [
      'const failures = [];',
      'const expectedTitle = "# Building something that tells me the truth when I\'m not watching";',
      'if (text.split(/\\r?\\n/u)[0] !== expectedTitle) {',
      "  failures.push('the planned H1 title is missing or changed');",
      '}',
      'if (failures.length) process.exit(1);',
    ].join('\n');
    expect(findingCodes({
      name: 'Article structure, length, numbers, and forbidden literals',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toContain('presentation_proxy_heading_literal');
  });

  it('accepts the same exact-H1 check when the brief makes that heading literal contractual', () => {
    const script = [
      'const failures = [];',
      'const expectedTitle = "# Contracted title";',
      'if (text.split(/\\r?\\n/u)[0] !== expectedTitle) {',
      "  failures.push('the contracted H1 is missing');",
      '}',
      'if (failures.length) process.exit(1);',
    ].join('\n');
    expect(findingCodes({
      name: 'contracted title remains exact',
      type: 'exec-script-exit-zero',
      params: { script },
    }, '# Contract\nThe exact Markdown heading `# Contracted title` is required.'))
      .not.toContain('presentation_proxy_heading_literal');
  });

  it('flags the historical E9 check that uses a heading as a commit-hash locator', () => {
    const brief = [
      '# E9 contract',
      '`docs/task_summary.md` records the implementation commit\'s 40-character hash.',
    ].join('\n');
    const script = [
      "const heading = [...summary.matchAll(/^#{1,3}\\s+E9\\b.*$/gmi)].at(-1);",
      "if (!heading || heading.index === undefined) throw new Error('docs/task_summary.md has no E9 section');",
      'const section = summary.slice(heading.index);',
      "if (!/\\b[0-9a-f]{40}\\b/.test(section)) throw new Error('E9 section has no implementation SHA');",
    ].join('\n');
    expect(findingCodes({
      name: 'e9-tracked-commit-integrity',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toContain('presentation_proxy_heading_literal');
  });

  it.each([
    {
      label: 'a file buffer compared with git-show output',
      script: [
        "const path = 'private/fixture.json';",
        "const head = execFileSync('git', ['show', `HEAD:${path}`]);",
        "if (!readFileSync(path).equals(head)) throw new Error('changed');",
      ].join('\n'),
    },
    {
      label: 'a file buffer compared with spawn stdout',
      script: [
        "const path = 'private/fixture.json';",
        'const actual = readFileSync(path);',
        "const expected = spawnSync('git', ['show', `HEAD:${path}`]);",
        'if (expected.status !== 0 || !actual.equals(expected.stdout)) process.exit(1);',
      ].join('\n'),
    },
  ])('flags $label', ({ script }) => {
    expect(findingCodes({
      name: 'working copy preserves source bytes',
      type: 'exec-script-exit-zero',
      params: { script },
    }, '# Contract\nThe source files must remain available.')).toContain('copy_byte_equivalence');
  });

  it('flags an exception conflict inside a scan over enumerated files', () => {
    const brief = [
      '# Contract',
      'Published files must not name `private-area/`, except a document that genuinely explains the private area may retain it.',
    ].join('\n');
    const script = [
      "const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });",
      'const bad = [];',
      "for (const file of listed.stdout.split('\\0').filter(Boolean)) {",
      "  const lines = readFileSync(file, 'utf8').split(/\\r?\\n/);",
      '  lines.forEach((line, index) => {',
      "    const forbidden = line.includes('private-area/');",
      '    if (forbidden) bad.push(`${file}:${index + 1}`);',
      '  });',
      '}',
      "if (bad.length) throw new Error(bad.join('\\n'));",
    ].join('\n');
    expect(findingCodes({
      name: 'published files omit the private area',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toContain('contract_exception_conflict');
  });

  it('accepts an enumerated scan that excludes every location allowed by the brief', () => {
    const brief = [
      '# Contract',
      'Published files must not name `private-area/`.',
      'Configuration has an explicit exception: the ignore file may retain its exact `private-area/` rule.',
      'The final report may explain that private area.',
    ].join('\n');
    const script = [
      "const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });",
      "const allowedReport = 'docs/final-report.md';",
      'const bad = [];',
      "for (const file of listed.stdout.split('\\0').filter(Boolean)) {",
      '  if (file === allowedReport) continue;',
      "  const lines = readFileSync(file, 'utf8').split(/\\r?\\n/);",
      '  lines.forEach((line, index) => {',
      "    const allowedIgnore = file === '.gitignore' && line.trim() === 'private-area/';",
      "    const forbidden = line.includes('private-area/');",
      '    if (forbidden && !allowedIgnore) bad.push(`${file}:${index + 1}`);',
      '  });',
      '}',
      "if (bad.length) throw new Error(bad.join('\\n'));",
    ].join('\n');
    expect(findingCodes({
      name: 'published files omit the private area except at contracted locations',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toEqual([]);
  });

  it('does not treat an instruction to delete an exception as permission', () => {
    const brief = [
      '# Contract',
      'Published files must not name `private-area/`.',
      'Configuration currently carves an exception for `private-area/`. Delete the exception.',
    ].join('\n');
    const script = [
      'const bad = [];',
      "for (const file of listed.stdout.split('\\0').filter(Boolean)) {",
      "  for (const line of readFileSync(file, 'utf8').split(/\\r?\\n/)) {",
      "    const forbidden = line.includes('private-area/');",
      '    if (forbidden) bad.push(file);',
      '  }',
      '}',
      "if (bad.length) throw new Error(bad.join('\\n'));",
    ].join('\n');
    expect(findingCodes({
      name: 'published files omit the private area',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toEqual([]);
  });

  it('still flags an enumerated scan whose allowance does not cover the preserved location', () => {
    const brief = [
      '# Contract',
      'Historical entries in `CHANGELOG.md` containing `private-area/` must be preserved.',
    ].join('\n');
    const script = [
      "const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });",
      'const bad = [];',
      "for (const file of listed.stdout.split('\\0').filter(Boolean)) {",
      "  const lines = readFileSync(file, 'utf8').split(/\\r?\\n/);",
      '  lines.forEach((line, index) => {',
      "    const allowedIgnore = file === '.gitignore' && line.trim() === 'private-area/';",
      "    const forbidden = line.includes('private-area/');",
      '    if (!allowedIgnore && forbidden) bad.push(`${file}:${index + 1}`);',
      '  });',
      '}',
      "if (bad.length) throw new Error(bad.join('\\n'));",
    ].join('\n');
    expect(findingCodes({
      name: 'published files omit the private area except in ignore configuration',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toContain('contract_exception_conflict');
  });

  it('accepts a full-buffer comparison when byte identity is the explicit contract', () => {
    const brief = '# Contract\nThe worktree artifact must be byte-identical to the committed artifact.';
    const script = [
      "const actual = readFileSync('fixtures/corpus.json');",
      "const expected = spawnSync('git', ['show', 'HEAD:fixtures/corpus.json']);",
      'if (!actual.equals(expected.stdout)) process.exit(1);',
    ].join('\n');
    expect(findingCodes({
      name: 'contracted byte identity holds',
      type: 'exec-script-exit-zero',
      params: { script },
    }, brief)).toEqual([]);
  });
});

function workflow(): { config: WorkflowConfig; yaml: string } {
  const yaml = [
    'name: reality-check-preflight-fixture',
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: plan',
    '    role: planner',
    '    scope: []',
    '    dynamic_dispatch: true',
  ].join('\n');
  return {
    yaml,
    config: {
      name: 'reality-check-preflight-fixture',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'plan',
        role: 'planner',
        depends_on: [],
        scope: [],
        prompt_template: 'Write the dispatch and Reality-Gate declarations.',
        dynamic_dispatch: true,
        is_gate: false,
        skills: [],
      }],
    },
  };
}

const WORK_DISPATCH = [
  '- id: work',
  '  role: coder',
  '  scope: [docs/final.md]',
  '  prompt_template: Write the declared terminal report.',
].join('\n');

const BAD_CHECK_MARKDOWN = checksMarkdown(BAD_CHECKS[0].check);
const BLOCKING_BAD_CHECK_MARKDOWN = checksMarkdown({
  name: 'validation always passes',
  type: 'exec-script-exit-zero',
  params: { script: 'true' },
});
const GOOD_CHECK_MARKDOWN = checksMarkdown(GOOD_CHECKS[0].check);

describe('planner check admission boundary', () => {
  let originalFcHome: string;
  let isolatedFcHome: string;
  let projectDir: string;

  beforeEach(() => {
    originalFcHome = fcGlobalDir();
    isolatedFcHome = mkdtempSync(join(tmpdir(), `fc-check-admission-${randomBytes(4).toString('hex')}-`));
    projectDir = mkdtempSync(join(tmpdir(), `fc-check-project-${randomBytes(4).toString('hex')}-`));
    setFcGlobalDir(isolatedFcHome);
  });

  afterEach(() => {
    setFcGlobalDir(originalFcHome);
    rmSync(isolatedFcHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('demotes an intent-dependent finding, surfaces it, and proceeds without a re-plan', async () => {
    const adapter = new ScriptedAdapter({
      plan: { runFiles: { 'dispatch.yaml': WORK_DISPATCH, 'reality_checks.md': BAD_CHECK_MARKDOWN } },
      work: { projectFiles: { 'docs/final.md': '# Final\n\nEvidence is present.\n' } },
      _summary: { output: '# Summary\n' },
    });
    const fixture = workflow();

    const final = await runWorkflow(
      fixture.config,
      fixture.yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      AGENTS_DIR,
      undefined,
      CONTRACT_BRIEF,
      true,
    );

    const executionCalls = adapter.calls
      .map(({ stageId }) => stageId)
      .filter((stageId) => stageId === 'plan' || stageId === 'work');
    expect(executionCalls).toEqual(['plan', 'work']);
    const runPath = runDir(projectDir, final.runId);
    expect(readFileSync(join(runPath, 'reality_checks.md'), 'utf-8')).toContain('advisory: true');
    const preflight = JSON.parse(readFileSync(join(runPath, 'reality_check_preflight.json'), 'utf-8')) as {
      disposition: string;
      advisoryFindings: Array<{ code: string }>;
      demotedCheckIndexes: number[];
    };
    expect(preflight).toMatchObject({
      disposition: 'admitted_with_advisories',
      advisoryFindings: [{ code: 'presentation_proxy_heading_literal' }],
      demotedCheckIndexes: [1],
    });
    expect(readFileSync(join(runPath, 'events.jsonl'), 'utf-8'))
      .toContain('Pre-dispatch lint demoted check indexes 1 to advisory');
    expect(final.status).not.toBe('reality_gate_failed');
    expect(final.realityGate?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'report contains validation evidence', pass: false, advisory: true }),
    ]));
  });

  it('re-plans a mechanically decidable blocking finding before work', async () => {
    const adapter = new ScriptedAdapter({
      plan: [
        { runFiles: { 'dispatch.yaml': WORK_DISPATCH, 'reality_checks.md': BLOCKING_BAD_CHECK_MARKDOWN } },
        { runFiles: { 'dispatch.yaml': WORK_DISPATCH, 'reality_checks.md': GOOD_CHECK_MARKDOWN } },
      ],
      work: { projectFiles: { 'docs/final.md': '# Final\n\nEvidence is present.\n' } },
      _summary: { output: '# Summary\n' },
    });
    const fixture = workflow();

    const final = await runWorkflow(
      fixture.config,
      fixture.yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      AGENTS_DIR,
      undefined,
      CONTRACT_BRIEF,
      true,
    );

    const executionCalls = adapter.calls
      .map(({ stageId }) => stageId)
      .filter((stageId) => stageId === 'plan' || stageId === 'work');
    expect(executionCalls).toEqual(['plan', 'plan', 'work']);
    expect(adapter.calls.filter(({ stageId }) => stageId === 'plan')[1].prompt)
      .toContain('hard_check_cannot_fail');
    expect(adapter.calls.filter(({ stageId }) => stageId === 'plan')[1].prompt)
      .toContain('reality_check_preflight.json');
    expect(final.status).not.toBe('failed');
  });

  it('exhausts the bounded planner retry with the lint reason and never runs work', async () => {
    const adapter = new ScriptedAdapter({
      plan: { runFiles: { 'dispatch.yaml': WORK_DISPATCH, 'reality_checks.md': BLOCKING_BAD_CHECK_MARKDOWN } },
      work: { projectFiles: { 'docs/final.md': '# Final\n' } },
      _summary: { output: '# Summary\n' },
    });
    const fixture = workflow();

    const final = await runWorkflow(
      fixture.config,
      fixture.yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      AGENTS_DIR,
      undefined,
      CONTRACT_BRIEF,
      true,
    );

    expect(adapter.calls.filter(({ stageId }) => stageId === 'plan')).toHaveLength(3);
    expect(adapter.calls.some(({ stageId }) => stageId === 'work')).toBe(false);
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('hard_check_cannot_fail');
  });
});
