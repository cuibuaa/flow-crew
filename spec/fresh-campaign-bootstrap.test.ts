import { stageArtifacts } from './spec_contracts/declared-fixtures.js';
import { inputFile } from './spec_contracts/declared-fixtures.js';
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
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { buildRoleRegistry } from '../src/scheduler/sched_admission/dispatch.js';
import {
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  resolveDispatchDependencies,
  tryAdvanceResearch,
  type StageConfig,
} from '../src/scheduler.js';
import type { ResearchConfig, StoreState, TerminalStatesConfig } from '../src/store.js';

const AGENTS_DIR = fileURLToPath(new URL('../config/agents/', import.meta.url));
const CAMPAIGN_DIR = 'reports/campaign';
const RESULT_FILE = `${CAMPAIGN_DIR}/round_result.json`;
const MANIFEST_FILE = `${CAMPAIGN_DIR}/run_manifest.json`;
const criteria = extractBriefCriteria('# Acceptance criteria\n1. Measure one mechanism and report its independently verified outcome.\n');

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

const terminalOwners = {
  [`${CAMPAIGN_DIR}/ship_report.md`]: 'final_ship',
  [`${CAMPAIGN_DIR}/ceiling_report.md`]: 'final_ceiling',
  [`${CAMPAIGN_DIR}/escalation_note.md`]: 'final_escalate',
};

function campaignStages(): StageConfig[] {
  const measuredScopes = [RESULT_FILE, `${RESULT_FILE}.no_candidate.json`];
  const rows = [
    { id: 'run_round', role: 'coder', scope: measuredScopes,
      prompt_template: 'Measure one research mechanism or emit no-candidate evidence.' },
    { id: 'audit_round', role: 'qa', scope: [], depends_on: ['run_round'], is_gate: true,
      dependency_reasons: { run_round: 'Independently inspect the measured outcome.' },
      prompt_template: 'Verify the research evidence and outcome contract.' },
    { id: 'fix_round', role: 'coder', scope: measuredScopes, depends_on: ['audit_round'], retry_to: ['audit_round'],
      dependency_reasons: { audit_round: 'Repair the rejected research evidence.' },
      prompt_template: 'Fix the defects identified by the rejecting gate.' },
    ...Object.entries(terminalOwners).map(([path, id]) => ({
      id, role: 'doc_writer', scope: [path], depends_on: ['audit_round'],
      dependency_reasons: { audit_round: 'Report the independently accepted research outcome.' },
      condition: `research.terminalPath == ${path}`,
      prompt_template: `Report the research outcome at ${path}.`,
    })),
  ];
  const stages = rows.map((row) => {
    return parseDispatchedStageConfig({ ...row, artifact_contract: stageArtifacts(row.id, 'is_gate' in row && row.is_gate) });
  });
  resolveDispatchDependencies(stages, 'plan');
  return stages;
}

function checksMarkdown(...checks: Array<Record<string, unknown>>): string {
  return ['## Reality checks', '```yaml', stringifyYaml({ checks: checks.map((check) => ({ reads: [], ...check })) }).trimEnd(), '```'].join('\n');
}

function manifestChecks(): string {
  return checksMarkdown(
    { reads: [inputFile('file_0', MANIFEST_FILE)],
      name: 'round_result_and_no_candidate_are_mutually_exclusive',
      type: 'file-exists-nonempty',
      params: { paths: [MANIFEST_FILE] },
    },
    {
      name: 'shipped_result_survives_confirmation',
      reads: [inputFile('manifest', MANIFEST_FILE)],
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
  return checksMarkdown({ reads: [inputFile('file_0', path)], name, type: 'file-exists-nonempty', params: { paths: [path] } });
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
  const state = {
    runId: 'fresh-run',
    workflowName: 'fresh-campaign-bootstrap',
    projectDir,
    status: 'running',
    stages: {},
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    research: config,
  } as StoreState;
  const { beginResearchInputGeneration } = await import('../src/research-candidate.js');
  beginResearchInputGeneration(projectDir, state);
  writeFileSync(`${join(projectDir, resultFile)}.no_candidate.json`, JSON.stringify({
    label: 'no-safe-candidate',
    outcome: 'no_candidate',
    reason: 'every candidate violated a hard constraint',
    evidence: { rejected: 4 },
  }));
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

describe('first research round with generic roles', () => {
  it('refuses manifest-only confirmation checks before the first round is consumed', () => {
    const stages = campaignStages();
    const roles = buildRoleRegistry(AGENTS_DIR);
    expect(stages.every((stage) => roles.has(stage.role))).toBe(true);
    const topology = inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
      research,
      criteria,
    });
    expect(topology).toMatchObject({ pass: true, errors: [], terminalOwners });

    const projectDir = temporaryRoot();
    expect(existsSync(join(projectDir, CAMPAIGN_DIR))).toBe(false);
    expect(inspectRealityCheckReachability({
      markdown: manifestChecks(),
      projectDir,
      stages,
      terminalStates,
      research,
    })).toEqual([
      expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest'),
      expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest'),
    ]);
  });

  it('refuses a wildcard, the optional result, and a never-written sibling', () => {
    const projectDir = temporaryRoot();
    const stages = campaignStages();
    const wildcard = inspectRealityCheckReachability({
      markdown: onePathCheck('bare wildcard', `${CAMPAIGN_DIR}/*`),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(wildcard).toEqual([
      expect.stringContaining('ARTIFACT_INPUT_ABSENT'),
    ]);

    const optional = inspectRealityCheckReachability({
      markdown: onePathCheck('optional measured result', RESULT_FILE),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(optional).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('valid no-candidate round writes only its sidecar')]);

    const neverWritten = `${CAMPAIGN_DIR}/never_written.json`;
    const novel = inspectRealityCheckReachability({
      markdown: onePathCheck('never written sibling', neverWritten),
      projectDir,
      stages,
      terminalStates,
      research,
    });
    expect(novel).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT')]);
    expect(novel[0]).toContain(neverWritten);
  });

  it('keeps manifest scope estimates without turning admission into provenance enforcement', () => {
    const stages = campaignStages();
    const finalShip = stages.find((stage) => stage.id === 'final_ship');
    expect(finalShip).toBeDefined();
    finalShip!.scope = [...finalShip!.scope, MANIFEST_FILE];
    const report = inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
      research,
      criteria,
    });
    expect(report.pass, report.errors.join('\n')).toBe(true);
    expect(finalShip!.scope).toContain(MANIFEST_FILE);
  });
});

describe('single resolved framework output contract', () => {
  it('emits a sibling manifest for a custom result file without report_dir', async () => {
    const { projectDir, runDirPath } = await emitNoCandidate({
      baseline: 10,
      policy: 'greedy_stack',
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
      policy: 'greedy_stack',
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
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest')]);
    expect(inspectRealityCheckReachability({
      markdown: onePathCheck('inferred path loses when explicit wins', 'docs/fresh-campaign/run_manifest.json'),
      projectDir: temporaryRoot(),
      stages: [],
      research: explicit,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT')]);
  });

  it('checks reachability of exact and novel manifest paths', () => {
    const exact = onePathCheck('resolved framework manifest', MANIFEST_FILE);
    const novelPath = 'docs/another-campaign/run_manifest.json';
    const novel = onePathCheck('same basename elsewhere', novelPath);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest')]);
    expect(inspectRealityCheckReachability({
      markdown: novel,
      projectDir,
      stages: [],
      research,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT')]);
  });

  it('keeps an inferred project-root manifest exact instead of granting its basename', () => {
    const rootResearch: ResearchConfig = {
      baseline: 0,
      policy: 'greedy_stack',
      resultFile: 'round.json',
    };
    const exactPath = 'run_manifest.json';
    const novelPath = 'other/run_manifest.json';
    const exact = onePathCheck('root framework manifest', exactPath);
    const novel = onePathCheck('nested same basename', novelPath);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research: rootResearch,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest')]);
    expect(inspectRealityCheckReachability({
      markdown: novel,
      projectDir,
      stages: [],
      research: rootResearch,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT')]);
  });

  it('checks reachability with an explicit project-root report_dir', () => {
    const explicitRoot: ResearchConfig = {
      baseline: 0,
      policy: 'greedy_stack',
      resultFile: 'docs/campaign/round.json',
      reportDir: '.',
    };
    const exactPath = 'run_manifest.json';
    const inferredPath = 'docs/campaign/run_manifest.json';
    const exact = onePathCheck('explicit root manifest', exactPath);
    const inferred = onePathCheck('superseded inferred manifest', inferredPath);

    const projectDir = temporaryRoot();
    expect(inspectRealityCheckReachability({
      markdown: exact,
      projectDir,
      stages: [],
      research: explicitRoot,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT'), expect.stringContaining('references post-consumption framework manifest')]);
    expect(inspectRealityCheckReachability({
      markdown: inferred,
      projectDir,
      stages: [],
      research: explicitRoot,
    })).toEqual([expect.stringContaining('ARTIFACT_INPUT_ABSENT')]);
  });
});
