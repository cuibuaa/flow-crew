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
} from '../src/scheduler.js';

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

  const dispatched = (rawStages as unknown[]).map((stage) => parseDispatchedStageConfig(stage));
  const baseStages = context.baseStages.map((stage) => parseDispatchedStageConfig(stage));
  return {
    context,
    criteria,
    recorded,
    checks: checksBytes.toString('utf8'),
    projectDir,
    dispatched,
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

function markdownFor(type: string, params: Record<string, unknown>): string {
  return [
    '## Reality checks',
    '```yaml',
    stringifyYaml({ checks: [{ name: 'path boundary probe', type, params }] }).trimEnd(),
    '```',
  ].join('\n');
}

function reachabilityErrors(type: string, params: Record<string, unknown>): string[] {
  return inspectRealityCheckReachability({
    markdown: markdownFor(type, params),
    projectDir: temporaryProject(),
    stages: [],
  });
}

function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    prompt_template: 'bounded path-extraction probe',
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

describe('literal reality-check path extraction', () => {
  const recordedFalsePositives = {
    research: [
      'console.error',
      'ship_report.md',
      'run_manifest.json',
      'process.exit',
      'JSON.parse',
      'fs.readFileSync',
      'manifest.rounds',
      'manifest.rounds.length',
      'latest.result',
      '0.05',
    ],
    diagram: [
      'fs.readFileSync',
      'html.match',
      'content.replace',
      '.trim',
      'fs.readFileSync',
      'report.match',
      'images.length',
      'JSON.parse',
      'fs.readFileSync',
      'baseline.branch',
      'path.resolve',
      'baseline.targetDir',
      'process.cwd',
      'baseline.validationBaseline.results.find',
      'entry.role',
      'recorded.failureIdentifiers.length',
      'process.execPath',
      '.map',
      '.replace',
      'run.status',
      'JSON.stringify',
    ],
  } as const;

  it.each(['research', 'diagram'] as const)(
    'replays the byte-identical %s quarantine and removes only code-token path errors',
    (name) => {
      const subject = fixture(name);
      expect(subject.recorded.pass).toBe(false);
      expect(subject.recorded.errors.map((error) => (
        / references absent (.*), but no admitted stage or framework emitter owns it$/.exec(error)?.[1]
      ))).toEqual(recordedFalsePositives[name]);

      const topology = inspectDispatchAdmission(subject.admission);
      expect(topology.pass, topology.errors.join('\n')).toBe(true);

      const afterErrors = inspectRealityCheckReachability({
        markdown: subject.checks,
        projectDir: subject.projectDir,
        stages: subject.dispatched,
        terminalStates: subject.context.terminalStates,
        research: subject.context.research,
      });
      expect(afterErrors).toEqual([]);
    },
  );

  it.each([
    {
      name: 'structured dotted filename',
      type: 'json-schema-match',
      params: { file: 'report.json', schema: { type: 'object' } },
      path: 'report.json',
    },
    {
      name: 'structured extensionless filename',
      type: 'file-exists-nonempty',
      params: { paths: ['Makefile'] },
      path: 'Makefile',
    },
    {
      name: 'unquoted shell file operand',
      type: 'exec-script-exit-zero',
      params: { script: 'test -s unquoted.json' },
      path: 'unquoted.json',
    },
    {
      name: 'quoted shell file operand',
      type: 'exec-script-exit-zero',
      params: { script: 'test -s "quoted.json"' },
      path: 'quoted.json',
    },
    {
      name: 'quoted static file-API argument',
      type: 'exec-script-exit-zero',
      params: {
        script: [
          "node <<'NODE'",
          "const fs = require('fs');",
          "fs.readFileSync('api.json', 'utf8');",
          'NODE',
        ].join('\n'),
      },
      path: 'api.json',
    },
    {
      name: 'interpreter file operand',
      type: 'exec-script-exit-zero',
      params: { script: 'node check.js' },
      path: 'check.js',
    },
    {
      name: 'quoted direct file-command operand',
      type: 'exec-script-exit-zero',
      params: { script: 'cat "capture.json"' },
      path: 'capture.json',
    },
    {
      name: 'extensionless relative path',
      type: 'exec-script-exit-zero',
      params: { script: 'test -s docs/report' },
      path: 'docs/report',
    },
  ])('treats $name as a required path', ({ type, params, path }) => {
    expect(reachabilityErrors(type, params).join('\n')).toContain(`references absent ${path}`);
  });

  it.each([
    {
      name: 'JavaScript identifiers, property access, methods, and a bare number',
      type: 'exec-script-exit-zero',
      params: {
        script: [
          "node <<'NODE'",
          "const fs = require('fs');",
          'const parsed = JSON.parse(payload);',
          'const latest = manifest.rounds[manifest.rounds.length - 1];',
          'const match = html.match(pattern);',
          'const clean = content.replace(pattern, value).trim();',
          'if (images.length === 0 || latest.result <= 0.05) process.exit(1);',
          "console.error('diagnostic only');",
          'void fs.readFileSync;',
          'NODE',
        ].join('\n'),
      },
    },
    {
      name: 'structured JSON field selector',
      type: 'variance-floor',
      params: { field_path: 'manifest.rounds', min_stddev: 0.05 },
    },
    {
      name: 'quoted dotted diagnostic outside file context',
      type: 'exec-script-exit-zero',
      params: { script: "node -e \"console.error('report.json')\"" },
    },
  ])('does not treat $name as a project path', ({ type, params }) => {
    expect(reachabilityErrors(type, params)).toEqual([]);
  });

  it('checks every file operand while ignoring code identifiers in the same script', () => {
    const projectDir = temporaryProject();
    writeFileSync(join(projectDir, 'present.json'), '{}\n', 'utf8');
    const errors = inspectRealityCheckReachability({
      markdown: markdownFor('exec-script-exit-zero', {
        script: [
          'cat present.json future.json',
          "node <<'NODE'",
          'console.error(manifest.rounds);',
          'NODE',
        ].join('\n'),
      }),
      projectDir,
      stages: [],
    });

    expect(errors).toEqual([
      'reality check "path boundary probe" references absent future.json, but no admitted stage or framework emitter owns it',
    ]);
  });

  it('ignores static file API syntax inside an embedded-code comment', () => {
    expect(reachabilityErrors('exec-script-exit-zero', {
      script: [
        "node <<'NODE'",
        "// fs.readFileSync('commented.json', 'utf8');",
        'NODE',
      ].join('\n'),
    })).toEqual([]);
  });

  it('still rejects a terminal report whose writer runs after the declared terminal owner', () => {
    const work = stage({
      id: 'work', role: 'coder', scope: ['src/**'], depends_on: [], dependency_reasons: {},
    });
    const finalize = stage({
      id: 'finalize', role: 'writer', scope: ['docs/outcome.md'], depends_on: ['work'],
      dependency_reasons: { work: 'Consumes the completed work.' },
    });
    const lateReport = stage({
      id: 'write_report', role: 'writer', scope: ['docs/final_verification.md'], depends_on: ['finalize'],
      dependency_reasons: { finalize: 'Runs only after terminalization.' },
    });
    const errors = inspectRealityCheckReachability({
      markdown: markdownFor('json-schema-match', {
        file: 'docs/final_verification.md', schema: { type: 'object' },
      }),
      projectDir: temporaryProject(),
      stages: [work, finalize, lateReport],
      terminalStates: { complete: { paths: ['docs/outcome.md'] } },
    });

    expect(errors.join('\n')).toContain(
      'docs/final_verification.md, but no producer is an ancestor of every terminal owner',
    );
  });

  it('still rejects a hard check on the optional research result', () => {
    const measure = stage({
      id: 'measure', role: 'researcher', scope: ['docs/round.json'],
      depends_on: [], dependency_reasons: {},
    });
    const errors = inspectRealityCheckReachability({
      markdown: markdownFor('json-schema-match', {
        file: 'docs/round.json', schema: { type: 'object' },
      }),
      projectDir: temporaryProject(),
      stages: [measure],
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
    });

    expect(errors.join('\n')).toContain('valid no-candidate round writes only its sidecar');
  });

  it('keeps the measurement-owner and continue-predicate admission probes red', () => {
    const measuringOwner = stage({
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

    const continueOwner = stage({
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
