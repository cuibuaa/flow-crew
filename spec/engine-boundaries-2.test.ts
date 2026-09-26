import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mergePlanRetryPair } from '../src/plan-retry-monotone.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { inspectRealityCheckReachability, runWorkflow, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState } from '../src/store.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

const put = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const stages = (dispatch: string): Array<Record<string, unknown>> =>
  (parseYaml(dispatch) as { stages: Array<Record<string, unknown>> }).stages;

async function scopeBoundaryCase(deliverToolBoundary: boolean): Promise<{
  calls: number[];
  statuses: string[];
  fileExists: boolean;
  fileContent: string;
  runStatus: string;
}> {
  const project = mkdtempSync(join(tmpdir(), 'fc-boundary-a-project-'));
  const stateHome = mkdtempSync(join(tmpdir(), 'fc-boundary-a-state-'));
  const oldHome = fcGlobalDir();
  try {
    setFcGlobalDir(stateHome);
    put(join(project, 'src', 'declared.txt'), 'initial\n');
    put(join(project, 'config', 'defaults.yaml'), 'default_timeout_ms: 10000\n');
    put(join(project, 'config', 'agents', 'coder.yaml'),
      'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: default\ntools: []\nprompt: fixture\n');
    const stage: StageConfig = {
      id: 'work', role: 'coder', depends_on: [], scope: ['src/declared.txt'],
      prompt_template: 'fixture', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = {
      name: 'scope-boundary', defaults: { max_iterations: 1, max_retries: 0 }, stages: [stage],
    };
    const yaml = 'name: scope-boundary\ndefaults:\n  max_iterations: 1\n  max_retries: 0\nstages:\n  - id: work\n    role: coder\n    scope: [src/declared.txt]\n    prompt_template: fixture\n';
    const created = createRun(project, config.name, yaml, ['work']);
    put(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const state = readRunState(project, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(project, created.runId, state);
    const calls: number[] = [];
    const adapter = { async run(_prompt: string, _role: unknown, opts: {
      stageId: string; runDir: string; attemptIndex: number; abortSignal?: AbortSignal;
      onCommandLifecycle?: (event: { phase: 'started' | 'completed'; id: string; command: string; timestamp: string }) => void;
    }) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      calls.push(opts.attemptIndex);
      if (calls.length === 1) {
        const stageDir = join(opts.runDir, 'stages', opts.stageId);
        put(join(stageDir, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: randomBytes(16).toString('hex'),
          runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
          requestedPaths: ['src/shared.txt'], pathDigest: scopePathDigest(['src/shared.txt']),
          reason: 'new output required',
        }));
        const decision = await waitForPathEvent(stageDir, () => {
          const name = readdirSync(stageDir).find((item) => item.startsWith('scope_revision_decision_') && item.endsWith('.json'));
          return name ? JSON.parse(readFileSync(join(stageDir, name), 'utf8')) as { accepted: boolean } : undefined;
        });
        expect(decision.accepted).toBe(true);
        if (deliverToolBoundary) {
          const event = { id: 'tool_1', command: 'fixture command', timestamp: new Date().toISOString() };
          opts.onCommandLifecycle?.({ ...event, phase: 'started' });
          opts.onCommandLifecycle?.({ ...event, phase: 'completed' });
          return { output: 'interrupted at tool boundary', exitCode: 137, duration_ms: 1, writes: [], writeAttribution: 'structured' as const };
        }
        put(join(project, 'src', 'shared.txt'), 'finished legitimate work\n');
        return { output: 'completed current invocation', exitCode: 0, duration_ms: 1,
          writes: ['src/shared.txt'], writeAttribution: 'structured' as const };
      }
      if (!existsSync(join(project, 'src', 'shared.txt'))) {
        put(join(project, 'src', 'shared.txt'), 'completed on re-dispatch\n');
      }
      return { output: 're-dispatched', exitCode: 0, duration_ms: 1,
        writes: deliverToolBoundary ? ['src/shared.txt'] : [], writeAttribution: 'structured' as const };
    } };
    const final = await runWorkflow(config, yaml, project, adapter, new Map(), undefined,
      join(project, 'config', 'agents'), created.runId, 'scope boundary', true);
    const status = readStageStatus(project, created.runId, 'work');
    return { calls, statuses: status.attempts?.map((attempt) => attempt.status) ?? [],
      fileExists: existsSync(join(project, 'src', 'shared.txt')),
      fileContent: readFileSync(join(project, 'src', 'shared.txt'), 'utf8'), runStatus: final.status };
  } finally {
    setFcGlobalDir(oldHome);
    rmSync(project, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
}

async function ignoredFileCase(writeKind: 'none' | 'known-tree' | 'ignored-tree' | 'peer-writes'): Promise<{
  runStatus: string; incidents: string[]; readerIncidents: string[];
  originalBytes: string; escapedExists: boolean;
}> {
  const root = mkdtempSync(join(tmpdir(), 'fc-boundary-d-'));
  const project = join(root, 'project');
  const oldHome = fcGlobalDir();
  try {
    setFcGlobalDir(join(root, 'state'));
    put(join(project, 'README.md'), 'baseline\n');
    put(join(project, '.venv', 'pkg', 'preexisting.dat'), 'preexisting\n');
    put(join(project, 'config', 'defaults.yaml'),
      readFileSync(new URL('../config/defaults.yaml', import.meta.url), 'utf8')
        .replace('live_constraint_fallback_scan_ms: 30000', 'live_constraint_fallback_scan_ms: 20'));
    put(join(project, 'config', 'agents', 'coder.yaml'),
      'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const stage: StageConfig = { id: 'reader', role: 'coder', depends_on: [],
      scope: ['.venv/.build*/**'], prompt_template: 'Read and finish.',
      skills: [], dynamic_dispatch: false, is_gate: false };
    const peer: StageConfig = { id: 'peer', role: 'coder', depends_on: [],
      scope: ['src/peer-owned.ts'], prompt_template: 'Write a fixture file.',
      skills: [], dynamic_dispatch: false, is_gate: false };
    const selectedStages = writeKind === 'peer-writes' ? [stage, peer] : [stage];
    const config: WorkflowConfig = { name: 'ignored-file',
      defaults: { max_iterations: 1, max_retries: 0 }, stages: selectedStages };
    const yaml = 'name: ignored-file\ndefaults:\n  max_iterations: 1\n  max_retries: 0\nstages:\n  - id: reader\n    role: coder\n    scope: [.venv/.build*/**]\n    prompt_template: Read and finish.\n'
      + (writeKind === 'peer-writes'
        ? '  - id: peer\n    role: coder\n    scope: [src/peer-owned.ts]\n    prompt_template: Write a fixture file.\n'
        : '');
    const created = createRun(project, config.name, yaml, selectedStages.map((item) => item.id));
    const state = readRunState(project, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(project, created.runId, state);
    const adapter = { async run(_prompt: string, _role: unknown, opts: { stageId: string }) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      if (opts.stageId === 'peer') {
        put(join(project, 'src', 'escaped.ts'), 'export const escape = true;\n');
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { output: 'peer wrote outside scope', exitCode: 0, duration_ms: 250,
          writes: ['src/escaped.ts'], writeAttribution: 'structured' as const };
      }
      readFileSync(join(project, '.venv', 'pkg', 'preexisting.dat'), 'utf8');
      if (writeKind === 'known-tree') put(join(project, 'src', 'escaped.ts'), 'export const escape = true;\n');
      if (writeKind === 'ignored-tree') put(join(project, '.venv', 'pkg', 'preexisting.dat'), 'changed\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { output: 'finished', exitCode: 0, duration_ms: 250,
        writes: writeKind === 'known-tree' ? ['src/escaped.ts']
          : writeKind === 'ignored-tree' ? ['.venv/pkg/preexisting.dat'] : [],
        writeAttribution: 'structured' as const };
    } };
    const final = await runWorkflow(config, yaml, project, adapter, new Map(), undefined,
      join(project, 'config', 'agents'), created.runId, 'ignored file fixture', true, false);
    const violations = readRunEvents(project, created.runId)
      .filter((event) => event.type === 'live_constraint_violation');
    return { runStatus: final.status,
      incidents: violations.flatMap((event) => event.files ?? []),
      readerIncidents: violations.filter((event) => event.stageId === 'reader')
        .flatMap((event) => event.files ?? []),
      originalBytes: readFileSync(join(project, '.venv', 'pkg', 'preexisting.dat'), 'utf8'),
      escapedExists: existsSync(join(project, 'src', 'escaped.ts')) };
  } finally {
    setFcGlobalDir(oldHome);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('engine boundary promises', () => {
  it('ends an accepted scope attempt at the delivered tool boundary and keeps durable re-dispatch work', async () => {
    expect(await scopeBoundaryCase(true)).toMatchObject({
      calls: [1, 2], statuses: ['suspended', 'complete'], fileExists: true,
      fileContent: 'completed on re-dispatch\n', runStatus: 'complete',
    });
  });

  it('lets an invocation without a delivered tool boundary finish its admitted work', async () => {
    expect(await scopeBoundaryCase(false)).toMatchObject({
      calls: [1, 2], statuses: ['suspended', 'complete'], fileExists: true,
      fileContent: 'finished legitimate work\n', runStatus: 'complete',
    });
  });

  it('unlocks only an exact conditional producer for its own absent hard-check input', () => {
    const incumbent = { dispatch: 'stages:\n  - id: write_report\n    role: coder\n    scope: [docs/report.md]\n    condition: audit_cache.pass == true\n  - id: audit_cache\n    role: qa\n    scope: [docs/cache.json]\n' };
    const proposed = { dispatch: 'stages:\n  - id: write_report\n    role: coder\n    scope: [docs/report.md]\n  - id: audit_cache\n    role: qa\n    scope: [docs/changed.json]\n' };
    const refusal = { id: 'reality-check:report-exists', source: 'admission' as const,
      detail: 'reality check "report-exists" references absent docs/report.md, but every producer is conditional or repair-only' };
    const repaired = stages(mergePlanRetryPair(incumbent, proposed, [refusal]).pair.dispatch);
    expect(repaired[0].condition).toBeUndefined();
    expect(repaired[1].scope).toEqual(['docs/cache.json']);
    const reachabilityRoot = mkdtempSync(join(tmpdir(), 'fc-boundary-b-reachability-'));
    try {
      const markdown = '## Reality checks\n```yaml\nchecks:\n  - name: report-exists\n    type: file-exists-nonempty\n    params:\n      paths: [docs/report.md]\n```\n';
      const asStages = (value: Array<Record<string, unknown>>): StageConfig[] => value.map((entry) => ({
        ...entry, id: String(entry.id), role: String(entry.role),
        scope: entry.scope as string[], condition: entry.condition as string | undefined,
        depends_on: [], is_gate: false,
      }));
      expect(inspectRealityCheckReachability({ markdown, projectDir: reachabilityRoot,
        stages: asStages(stages(incumbent.dispatch)) })).toEqual([expect.stringContaining('every producer is conditional')]);
      expect(inspectRealityCheckReachability({ markdown, projectDir: reachabilityRoot,
        stages: asStages(repaired) })).toEqual([]);
    } finally { rmSync(reachabilityRoot, { recursive: true, force: true }); }
    const unrelated = stages(mergePlanRetryPair(incumbent, proposed, [{ ...refusal,
      detail: 'reality check "report-exists" cites a mutable framework manifest' }]).pair.dispatch);
    expect(unrelated[0].condition).toBe('audit_cache.pass == true');
    expect(unrelated[1].scope).toEqual(['docs/cache.json']);
  });

  it('resolves an expressly run-local prompt file there and keeps ordinary project obligations', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-boundary-c-'));
    try {
      const project = join(root, 'project');
      const runDir = join(root, 'run');
      put(join(runDir, 'validation_final.json'), '{"passed":true}\n');
      const contextual = inspectStageArtifactContract({ stageId: 'write_report',
        template: "Write this run's validation_final.json.", projectDir: project, runDir,
        writes: ['run:validation_final.json'] });
      expect(contextual.violations).toEqual([]);
      expect(contextual.obligations[0].path).toBe(join(runDir, 'validation_final.json'));
      const ordinary = inspectStageArtifactContract({ stageId: 'write_report',
        template: 'Write validation_final.json.', projectDir: project, runDir,
        writes: ['run:validation_final.json'] });
      expect(ordinary.violations).toEqual([expect.objectContaining({
        path: join(project, 'validation_final.json'), reason: expect.stringContaining('no readable file'),
      })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not attribute a preexisting ignored file to a stage that only reads', async () => {
    expect(await ignoredFileCase('none')).toMatchObject({
      runStatus: 'complete', incidents: [], originalBytes: 'preexisting\n', escapedExists: false,
    });
  });

  it('still restores an actual out-of-scope write in a known project tree', async () => {
    const result = await ignoredFileCase('known-tree');
    expect(result.runStatus).toBe('failed');
    expect(result.incidents).toContain('src/escaped.ts');
    expect(result.incidents).not.toContain('.venv/pkg/preexisting.dat');
    expect(result.escapedExists).toBe(false);
  });

  it('still detects and restores a real change to an ignored preexisting file', async () => {
    const result = await ignoredFileCase('ignored-tree');
    expect(result.runStatus).toBe('failed');
    expect(result.incidents).toContain('.venv/pkg/preexisting.dat');
    expect(result.originalBytes).toBe('preexisting\n');
  });

  it('can deliver an incident to a no-write reader when a concurrent peer writes outside both scopes', async () => {
    const result = await ignoredFileCase('peer-writes');
    expect(result.readerIncidents).toContain('src/escaped.ts');
    expect(result.readerIncidents).not.toContain('.venv/pkg/preexisting.dat');
    expect(result.escapedExists).toBe(false);
  });
});
