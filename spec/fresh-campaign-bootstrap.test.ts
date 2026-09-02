import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import type { BriefCriteriaArtifact } from '../src/brief-criteria.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import {
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  resolveDispatchDependencies,
  tryAdvanceResearch,
  type StageConfig,
} from '../src/scheduler.js';
import type { ResearchConfig, StoreState, TerminalStatesConfig } from '../src/store.js';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/fresh-campaign-bootstrap/', import.meta.url));
const CAMPAIGN_DIR = 'docs/happymj_explore7';
const RESULT_FILE = `${CAMPAIGN_DIR}/round_result.json`;
const MANIFEST_FILE = `${CAMPAIGN_DIR}/run_manifest.json`;

const terminalStates: TerminalStatesConfig = {
  shipped: { paths: [`${CAMPAIGN_DIR}/ship_report.md`] },
  ceiling_hit: { paths: [`${CAMPAIGN_DIR}/ceiling_report.md`] },
  escalated: { paths: [`${CAMPAIGN_DIR}/escalation_note.md`] },
};
const research: ResearchConfig = {
  baseline: 0,
  higherIsBetter: true,
  policy: 'greedy_stack',
  resultFile: RESULT_FILE,
  stop: { beat: 0.05, maxRounds: 6, haltAfterNoImprovement: 4 },
};
const inertAdapter: Adapter = {
  run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }),
};
const temporaryRoots: string[] = [];

interface ArchivedAdmission {
  version: 1;
  pass: false;
  errors: string[];
  terminalOwners: Record<string, string>;
  criterionGateRefs: Record<string, string[]>;
  criteriaDigest: string;
  proposalDigest: string;
}

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_ROOT, name));
}

function stagesFromFixture(): StageConfig[] {
  const parsed = parseYaml(fixture('dispatch.yaml').toString('utf8')) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [];
  const stages = rows.map((row) => parseDispatchedStageConfig(row));
  resolveDispatchDependencies(stages, 'plan');
  return stages;
}

function archivedAdmission(): ArchivedAdmission {
  return JSON.parse(fixture('dispatch_admission.json').toString('utf8')) as ArchivedAdmission;
}

function evidenceCriteria(archived: ArchivedAdmission): BriefCriteriaArtifact {
  return {
    version: 1,
    briefDigest: archived.criteriaDigest,
    criteria: archived.criterionGateRefs.audit_round.map((id, index) => ({
      id,
      text: `quarantined criterion ${index + 1}`,
      line: index + 1,
      section: 'What each round report must show',
    })),
  };
}

function checksMarkdown(...checks: Array<Record<string, unknown>>): string {
  return ['## Reality checks', '```yaml', stringifyYaml({ checks }).trimEnd(), '```'].join('\n');
}

function manifestChecks(): string {
  return checksMarkdown(
    {
      name: 'round_result_and_no_candidate_are_mutually_exclusive',
      type: 'file-exists-nonempty',
      params: { paths: [MANIFEST_FILE] },
    },
    {
      name: 'shipped_result_survives_confirmation',
      type: 'exec-script-exit-zero',
      params: {
        script: [
          "node - <<'NODE'",
          "const fs = require('node:fs');",
          `const rows = JSON.parse(fs.readFileSync('${MANIFEST_FILE}', 'utf8')).rounds;`,
          "if (!Array.isArray(rows) || rows.some((row) => typeof row.label !== 'string' || !['measured', 'no_candidate'].includes(row.outcome))) process.exit(1);",
          'NODE',
        ].join('\n'),
      },
    },
  );
}

function onePathCheck(name: string, path: string): string {
  return checksMarkdown({ name, type: 'file-exists-nonempty', params: { paths: [path] } });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fc-fresh-campaign-'));
  temporaryRoots.push(root);
  return root;
}

async function emitNoCandidate(config: ResearchConfig): Promise<{ projectDir: string; runDirPath: string }> {
  const projectDir = temporaryRoot();
  const runDirPath = join(projectDir, 'run');
  const resultFile = config.resultFile ?? 'docs/research_round_result.json';
  mkdirSync(dirname(join(projectDir, resultFile)), { recursive: true });
  mkdirSync(runDirPath, { recursive: true });
  writeFileSync(`${join(projectDir, resultFile)}.no_candidate.json`, JSON.stringify({
    label: 'no-safe-candidate',
    outcome: 'no_candidate',
    reason: 'every candidate violated a hard constraint',
    evidence: { rejected: 4 },
  }));
  const state = {
    runId: 'fresh-run',
    workflowName: 'fresh-campaign-bootstrap',
    projectDir,
    status: 'running',
    stages: {},
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    research: config,
  } as StoreState;
  await tryAdvanceResearch(state, {
    projectDir,
    runId: 'fresh-run',
    runDirPath,
    iteration: 1,
    adapter: inertAdapter,
  });
  return { projectDir, runDirPath };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('quarantined attempt-2 replay', () => {
  it('pins the exact proposal, admission, and rejection bytes', () => {
    const expected = {
      'dispatch.yaml': [9_106, 'dde0e6a7c148b4be5c3fe22e32ac9b85434d9df234b7fb1d296445f1df1ab97b'],
      'dispatch_admission.json': [2_403, '4f46108932c301864ae99b670714c819e463a3d563ee133125c32c42b628d692'],
      'rejection.json': [868, 'ea2b3a77c7015fab0c192b9e1cf0f08a6752a0457b6492b66d23266531e52fd4'],
    } as const;
    for (const [name, [bytes, sha256]] of Object.entries(expected)) {
      const content = fixture(name);
      expect(content.byteLength, name).toBe(bytes);
      expect(createHash('sha256').update(content).digest('hex'), name).toBe(sha256);
    }

    const archived = archivedAdmission();
    expect(archived).toMatchObject({
      pass: false,
      proposalDigest: expected['dispatch.yaml'][1],
      errors: [
        expect.stringContaining(`references absent ${MANIFEST_FILE}`),
        expect.stringContaining(`references absent ${MANIFEST_FILE}`),
        expect.stringContaining(`references absent ${CAMPAIGN_DIR}/*`),
      ],
    });
    expect(JSON.parse(fixture('rejection.json').toString('utf8'))).toMatchObject({
      attemptIndex: 2,
      proposalDigest: expected['dispatch.yaml'][1],
      errors: archived.errors,
    });
  });

  it('admits the unchanged dispatch with repaired manifest-only checks in a fresh project', () => {
    const archived = archivedAdmission();
    const stages = stagesFromFixture();
    const topology = inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
      research,
      criteria: evidenceCriteria(archived),
    });
    expect(topology).toMatchObject({ pass: true, errors: [], terminalOwners: archived.terminalOwners });

    const projectDir = temporaryRoot();
    expect(existsSync(join(projectDir, CAMPAIGN_DIR))).toBe(false);
    expect(inspectRealityCheckReachability({
      markdown: manifestChecks(),
      projectDir,
      stages,
      terminalStates,
      research,
    })).toEqual([]);
  });

  it('still refuses the recorded wildcard, the optional result, and a never-written sibling', () => {
    const projectDir = temporaryRoot();
    const stages = stagesFromFixture();
    const wildcard = inspectRealityCheckReachability({
      markdown: onePathCheck('recorded bare wildcard', `${CAMPAIGN_DIR}/*`),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(wildcard).toEqual([expect.stringContaining(`references absent ${CAMPAIGN_DIR}/*`)]);

    const optional = inspectRealityCheckReachability({
      markdown: onePathCheck('optional measured result', RESULT_FILE),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(optional).toEqual([expect.stringContaining('valid no-candidate round writes only its sidecar')]);

    const neverWritten = `${CAMPAIGN_DIR}/never_written.json`;
    const novel = inspectRealityCheckReachability({
      markdown: onePathCheck('never written sibling', neverWritten),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(novel).toEqual([expect.stringContaining(`references absent ${neverWritten}`)]);
  });

  it('keeps the resolved manifest framework-owned instead of assigning it to a terminal writer', () => {
    const archived = archivedAdmission();
    const stages = stagesFromFixture();
    const finalShip = stages.find((stage) => stage.id === 'final_ship');
    expect(finalShip).toBeDefined();
    finalShip!.scope = [...finalShip!.scope, MANIFEST_FILE];
    const report = inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
      research,
      criteria: evidenceCriteria(archived),
    });
    expect(report.errors).toContain(
      `terminal owner final_ship.scope: research result producer path ${MANIFEST_FILE} cannot be owned by a terminal writer; separate measurement from terminalization`,
    );
  });
});

describe('single resolved framework output contract', () => {
  it('emits a sibling manifest for a custom result file without report_dir', async () => {
    const { projectDir, runDirPath } = await emitNoCandidate({
      baseline: 10,
      policy: 'best_of_n',
      resultFile: 'docs/fresh-campaign/round.json',
      stop: { maxRounds: 2 },
    });
    const manifestPath = join(projectDir, 'docs/fresh-campaign/run_manifest.json');
    expect(existsSync(join(projectDir, 'docs/run_manifest.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      runId: string;
      rounds: Array<Record<string, unknown>>;
    };
    expect(manifest.runId).toBe('fresh-run');
    expect(manifest.rounds).toHaveLength(1);
    expect(manifest.rounds[0]).toMatchObject({
      label: 'no-safe-candidate',
      outcome: 'no_candidate',
      reason: 'every candidate violated a hard constraint',
      evidence: { rejected: 4 },
      wallHoursCumulative: expect.any(Number),
    });
    expect(manifest.rounds[0]).not.toHaveProperty('result');
    const journal = JSON.parse(readFileSync(join(runDirPath, 'research_journal.json'), 'utf8')) as {
      rounds: Array<Record<string, unknown>>;
    };
    expect(journal.rounds).toEqual(manifest.rounds);
  });

  it('keeps an explicit report_dir authoritative for emission and admission', async () => {
    const explicit: ResearchConfig = {
      baseline: 10,
      policy: 'best_of_n',
      resultFile: 'docs/fresh-campaign/round.json',
      reportDir: 'reports/explicit-campaign',
      stop: { maxRounds: 2 },
    };
    const { projectDir } = await emitNoCandidate(explicit);
    expect(existsSync(join(projectDir, 'reports/explicit-campaign/run_manifest.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'docs/fresh-campaign/run_manifest.json'))).toBe(false);
    expect(inspectRealityCheckReachability({
      markdown: onePathCheck('explicit manifest', 'reports/explicit-campaign/run_manifest.json'),
      projectDir: temporaryRoot(),
      stages: [],
      research: explicit,
    })).toEqual([]);
    expect(inspectRealityCheckReachability({
      markdown: onePathCheck('inferred path loses when explicit wins', 'docs/fresh-campaign/run_manifest.json'),
      projectDir: temporaryRoot(),
      stages: [],
      research: explicit,
    })).toEqual([expect.stringContaining('no admitted stage or framework emitter owns it')]);
  });

  it('makes static preflight and reachability agree on exact and novel manifest paths', () => {
    const brief = [
      '---',
      'research:',
      '  baseline: 0',
      `  result_file: ${RESULT_FILE}`,
      '---',
      '# Research contract',
    ].join('\n');
    const exact = onePathCheck('resolved framework manifest', MANIFEST_FILE);
    const novelPath = 'docs/another-campaign/run_manifest.json';
    const novel = onePathCheck('same basename elsewhere', novelPath);
    expect(inspectRealityChecks(brief, exact).findings).toEqual([]);
    expect(inspectRealityChecks(brief, novel).findings).toEqual([
      expect.objectContaining({ code: 'undeclared_artifact_existence' }),
    ]);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research,
    })).toEqual([]);
    expect(inspectRealityCheckReachability({
      markdown: novel,
      projectDir,
      stages: [],
      research,
    })).toEqual([expect.stringContaining(`references absent ${novelPath}`)]);
  });

  it('keeps an inferred project-root manifest exact instead of granting its basename', () => {
    const rootResearch: ResearchConfig = {
      baseline: 0,
      policy: 'greedy_stack',
      resultFile: 'round.json',
    };
    const brief = [
      '---',
      'research:',
      '  baseline: 0',
      '  result_file: round.json',
      '---',
      '# Root research contract',
    ].join('\n');
    const exactPath = 'run_manifest.json';
    const novelPath = 'other/run_manifest.json';
    const exact = onePathCheck('root framework manifest', exactPath);
    const novel = onePathCheck('nested same basename', novelPath);

    expect(inspectRealityChecks(brief, exact).findings).toEqual([]);
    expect(inspectRealityChecks(brief, novel).findings).toEqual([
      expect.objectContaining({ code: 'undeclared_artifact_existence' }),
    ]);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research: rootResearch,
    })).toEqual([]);
    expect(inspectRealityCheckReachability({
      markdown: novel,
      projectDir,
      stages: [],
      research: rootResearch,
    })).toEqual([expect.stringContaining(`references absent ${novelPath}`)]);
  });

  it('credits an explicit project-root report_dir on both admission sides', () => {
    const explicitRoot: ResearchConfig = {
      baseline: 0,
      policy: 'greedy_stack',
      resultFile: 'docs/campaign/round.json',
      reportDir: '.',
    };
    const brief = [
      '---',
      'research:',
      '  baseline: 0',
      '  result_file: docs/campaign/round.json',
      '  report_dir: .',
      '---',
      '# Explicit root research contract',
    ].join('\n');
    const exactPath = 'run_manifest.json';
    const inferredPath = 'docs/campaign/run_manifest.json';
    const exact = onePathCheck('explicit root manifest', exactPath);
    const inferred = onePathCheck('superseded inferred manifest', inferredPath);

    expect(inspectRealityChecks(brief, exact).findings).toEqual([]);
    expect(inspectRealityChecks(brief, inferred).findings).toEqual([
      expect.objectContaining({ code: 'undeclared_artifact_existence' }),
    ]);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research: explicitRoot,
    })).toEqual([]);
    expect(inspectRealityCheckReachability({
      markdown: inferred,
      projectDir,
      stages: [],
      research: explicitRoot,
    })).toEqual([expect.stringContaining(`references absent ${inferredPath}`)]);
  });
});
