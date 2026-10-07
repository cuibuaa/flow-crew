import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  StageConfigSchema,
} from '../src/scheduler.js';

import type { ArtifactRead } from '../src/artifact-declarations.js';
import { artifacts, producedRead, stageArtifacts } from './spec_contracts/declared-fixtures.js';

type AdmissionInput = Parameters<typeof inspectDispatchAdmission>[0];
type ReachabilityInput = Parameters<typeof inspectRealityCheckReachability>[0];

interface FixtureContext {
  source: {
    runId: string;
    rejectionAttempt: string;
    dispatchBytes: number;
    dispatchSha256: string;
    recordedAdmissionBytes: number;
    recordedAdmissionSha256: string;
    realityChecksBytes: number;
    realityChecksSha256: string;
  };
  dispatchStageId: string;
  baseStages: unknown[];
  terminalStates?: AdmissionInput['terminalStates'];
  research?: AdmissionInput['research'];
  existingPaths: string[];
}

interface RecordedAdmission {
  pass: boolean;
  proposalDigest: string;
  errors: string[];
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-path-extraction-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(name: 'research' | 'diagram') {
  const root = join(import.meta.dirname, 'fixtures', 'path-extraction', name);
  const dispatchBytes = readFileSync(join(root, 'dispatch.yaml'));
  const admissionBytes = readFileSync(join(root, 'recorded_admission.json'));
  const checksBytes = readFileSync(join(root, 'reality_checks.md'));
  const context = JSON.parse(readFileSync(join(root, 'context.json'), 'utf8')) as FixtureContext;
  const criteria = JSON.parse(readFileSync(join(root, 'brief_criteria.json'), 'utf8')) as AdmissionInput['criteria'];
  const recorded = JSON.parse(admissionBytes.toString('utf8')) as RecordedAdmission;
  const parsed = parseYaml(dispatchBytes.toString('utf8')) as unknown;
  const rawStages = Array.isArray(parsed)
    ? parsed
    : (parsed as { stages?: unknown[] } | undefined)?.stages;

  expect(rawStages).toBeInstanceOf(Array);
  expect(dispatchBytes.byteLength).toBe(context.source.dispatchBytes);
  expect(sha256(dispatchBytes)).toBe(context.source.dispatchSha256);
  expect(admissionBytes.byteLength).toBe(context.source.recordedAdmissionBytes);
  expect(sha256(admissionBytes)).toBe(context.source.recordedAdmissionSha256);
  expect(checksBytes.byteLength).toBe(context.source.realityChecksBytes);
  expect(sha256(checksBytes)).toBe(context.source.realityChecksSha256);
  expect(recorded.proposalDigest).toBe(context.source.dispatchSha256);

  const projectDir = temporaryProject();
  for (const relativePath of context.existingPaths) {
    const absolutePath = join(projectDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'recorded admission context\n', 'utf8');
  }

  const dispatched = (rawStages as unknown[]).map((stage) => {
    const parsedStage = StageConfigSchema.parse(stage);
    // This fixture predates the closed stage-status domain. Keep the path
    // extraction subject reachable with the real completion literal.
    if (parsedStage.condition === 'verify_diagram.status == passed') {
      parsedStage.condition = 'verify_diagram.status == complete';
    }
    return parsedStage;
  });
  const baseStages = context.baseStages.map((stage) => StageConfigSchema.parse(stage));
  return {
    context,
    criteria,
    recorded,
    checks: checksBytes.toString('utf8'),
    projectDir,
    dispatched,
    rawStages: rawStages as unknown[],
    admission: {
      dispatched,
      baseStages,
      dispatchStageId: context.dispatchStageId,
      terminalStates: context.terminalStates,
      research: context.research,
      criteria,
    } satisfies AdmissionInput,
  };
}

function markdownFor(type: string, params: Record<string, unknown>, reads: ArtifactRead[] = []): string {
  return ['## Reality checks', '```yaml', stringifyYaml({ checks: [{ name: 'path boundary probe', type, params, reads }] }).trimEnd(), '```'].join('\n');
}
function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true), prompt_template: 'exact declaration probe', skills: [],
    is_gate: false, criterion_refs: [], ...raw,
  });
}

describe('declared reality-check reads replace lexical path inference', () => {
  it('requires an exact output declaration even when a parent write scope covers the path', () => {
    const projectDir = temporaryProject(), path = 'docs/honest_plan/evidence.json';
    const writer = stage({ criterion_refs: [], id: 'evidence_writer', role: 'coder', scope: ['docs/honest_plan'], depends_on: [], dependency_reasons: {} });
    const markdown = markdownFor('file-exists-nonempty', { paths: [path] }, [producedRead('evidence', path, writer.id)]);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [writer] }).join('\n')).toContain('ARTIFACT_READ_UNREACHABLE');
    writer.artifact_contract = artifacts([{ id: 'evidence', root: 'project', path }]);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [writer] })).toEqual([]);
  });
  it.each(['research', 'diagram'] as const)('reads the byte-identical %s quarantine and refuses its old execution format', (name) => {
    const subject = fixture(name);
    expect(subject.recorded.pass).toBe(false);
    expect(subject.dispatched.length).toBeGreaterThan(0);
    expect(() => parseDispatchedStageConfig(subject.rawStages[0])).toThrow('ARTIFACT_DECLARATION_REQUIRED');
    const report = inspectDispatchAdmission(subject.admission);
    expect(report.errors.some((error) => error.includes('ARTIFACT_DECLARATION_REQUIRED'))).toBe(true);
    const errors = inspectRealityCheckReachability({ markdown: subject.checks, projectDir: subject.projectDir, stages: subject.dispatched,
      terminalStates: subject.context.terminalStates, research: subject.context.research });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.includes('REALITY_READ_DECLARATION_REQUIRED'))).toBe(true);
    expect(subject.recorded.errors.length).toBeGreaterThan(0);
  });
  it.each([
    ['json-schema-match', { file: 'report.json', schema: { type: 'object' } }, 'report.json'],
    ['file-exists-nonempty', { paths: ['Makefile'] }, 'Makefile'],
  ] as const)('requires the declared handler input for %s', (type, params, path) => {
    const projectDir = temporaryProject(), markdown = markdownFor(type, params);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [] }).join('\n')).toContain('ARTIFACT_HANDLER_READ_UNDECLARED');
    const read = producedRead('input', path, 'absent');
    const errors = inspectRealityCheckReachability({ markdown: markdownFor(type, params, [read]), projectDir, stages: [] });
    expect(errors.join('\n')).toContain('ARTIFACT_READ_UNREACHABLE');
    expect(errors.join('\n')).toContain(`references absent ${path}`);
  });
  it.each([
    'test -s docs/report.json',
    "cat present.json future.json; node -e 'console.error(manifest.rounds)'",
    "node -e \"require('fs').readFileSync('api.json')\"",
    'node check.js',
    'sed -f scripts/filter.sed data/input.json > out/result.txt',
    String.raw`sed -n 's/^\([a-z]*\)$/\1/p' docs/input.json`,
    String.raw`grep -E 'round_result\.json(\.no_candidate\.json)?'`,
    "node -e \"// fs.readFileSync('commented.json')\"",
  ])('does not infer obligations from script text: %s', (script) => {
    expect(inspectRealityCheckReachability({ markdown: markdownFor('exec-script-exit-zero', { script }, []), projectDir: temporaryProject(), stages: [] })).toEqual([]);
  });
  it('checks every declared read independently of incidental operands in the same script', () => {
    const projectDir = temporaryProject(); writeFileSync(join(projectDir, 'present.json'), '{}\n');
    const reads: ArtifactRead[] = [
      { id: 'present', root: 'project', path: 'present.json', kind: 'file', source: { kind: 'input' } },
      producedRead('future', 'future.json', 'absent'),
    ];
    const errors = inspectRealityCheckReachability({ markdown: markdownFor('exec-script-exit-zero', { script: 'cat present.json future.json; console.error(manifest.rounds)' }, reads), projectDir, stages: [] });
    expect(errors).toEqual([
      expect.stringContaining('ARTIFACT_READ_UNREACHABLE'),
      'reality check "path boundary probe" references absent future.json, but no admitted stage or framework emitter owns it',
    ]);
  });
  it('still rejects a declared report whose producer is downstream of the terminal owner', () => {
    const work = stage({ criterion_refs: [], id: 'work', role: 'coder', scope: ['src/**'], depends_on: [], dependency_reasons: {} });
    const finalize = stage({ criterion_refs: [], id: 'finalize', role: 'writer', scope: ['docs/outcome.md'], depends_on: ['work'], dependency_reasons: { work: 'Uses completed work.' } });
    const path = 'docs/final_verification.md';
    const late = stage({ criterion_refs: [], id: 'write_report', role: 'writer', scope: [path], depends_on: ['finalize'], dependency_reasons: { finalize: 'Runs too late.' }, artifact_contract: artifacts([{ id: 'report', root: 'project', path }]) });
    const errors = inspectRealityCheckReachability({ markdown: markdownFor('json-schema-match', { file: path, schema: { type: 'object' } }, [producedRead('report', path, late.id)]), projectDir: temporaryProject(), stages: [work, finalize, late], terminalStates: { complete: { paths: ['docs/outcome.md'] } } });
    expect(errors.join('\n')).toContain('no producer is an ancestor of every terminal owner');
  });
  it('still rejects an explicitly declared read of the mutable optional research result', () => {
    const path = 'docs/round.json';
    const measure = stage({ criterion_refs: [], id: 'measure', role: 'researcher', scope: [path], depends_on: [], dependency_reasons: {}, artifact_contract: artifacts([{ id: 'result', root: 'project', path }]) });
    const errors = inspectRealityCheckReachability({ markdown: markdownFor('json-schema-match', { file: path, schema: { type: 'object' } }, [producedRead('result', path, measure.id)]), projectDir: temporaryProject(), stages: [measure], research: { baseline: 0, policy: 'best_of_n', resultFile: path } });
    expect(errors.join('\n')).toContain('valid no-candidate round writes only its sidecar');
  });
  it('keeps the measurement-owner and continue-predicate admission probes red', () => {
    const measuringOwner = stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []),
      id: 'measure', role: 'researcher', scope: ['docs/round.json', 'docs/final.md'],
      depends_on: [], dependency_reasons: {}, condition: 'research.decision != continue',
    });
    const measuringReport = inspectDispatchAdmission({
      dispatched: [measuringOwner], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
    });
    expect(measuringReport.pass).toBe(false);
    expect(measuringReport.errors.join('\n')).toContain(
      'research result producer path docs/round.json cannot be owned by a terminal writer',
    );

    const continueOwner = stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []),
      id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
      dependency_reasons: {}, condition: 'research.decision == continue',
    });
    const continueReport = inspectDispatchAdmission({
      dispatched: [continueOwner], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n' },
    });
    expect(continueReport.pass).toBe(false);
    expect(continueReport.errors.join('\n')).toContain(
      'must be mechanically false when research.decision is continue',
    );
  });
});
