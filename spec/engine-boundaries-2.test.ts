import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { runWorkflow, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState } from '../src/store.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

const put = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

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
    put(join(project, 'config', 'agents', 'coder.yaml'),
      'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const stage: StageConfig = { id: 'reader', role: 'coder', depends_on: [],
      scope: ['.venv/.build*/**'], prompt_template: 'Read and finish.',
      skills: [], dynamic_dispatch: false, is_gate: false,
      artifact_contract: { version: 1, produces: [], reads: [] } };
    const peer: StageConfig = { id: 'peer', role: 'coder', depends_on: [],
      scope: ['src/peer-owned.ts'], prompt_template: 'Write a fixture file.',
      skills: [], dynamic_dispatch: false, is_gate: false,
      artifact_contract: { version: 1, produces: [], reads: [] } };
    const selectedStages = writeKind === 'peer-writes' ? [stage, peer] : [stage];
    const config: WorkflowConfig = { name: 'ignored-file',
      defaults: { max_iterations: 1, max_retries: 0 }, stages: selectedStages };
    const yaml = 'name: ignored-file\ndefaults:\n  max_iterations: 1\n  max_retries: 0\nstages:\n  - id: reader\n    role: coder\n    scope: [.venv/.build*/**]\n    prompt_template: Read and finish.\n    artifact_contract: {version: 1, produces: [], reads: []}\n'
      + (writeKind === 'peer-writes'
        ? '  - id: peer\n    role: coder\n    scope: [src/peer-owned.ts]\n    prompt_template: Write a fixture file.\n    artifact_contract: {version: 1, produces: [], reads: []}\n'
        : '');
    const created = createRun(project, config.name, yaml, selectedStages.map((item) => item.id));
    const state = readRunState(project, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(project, created.runId, state);
    const adapter = { async run(_prompt: string, _role: unknown, opts: { stageId: string }) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      if (opts.stageId === 'peer') {
        put(join(project, 'src', 'escaped.ts'), 'export const escape = true;\n');
        await new Promise((resolve) => setTimeout(resolve, 250));
        return fixtureResult({ output: 'peer wrote outside scope', exitCode: 0, duration_ms: 250,
          writes: ['src/escaped.ts'], writeAttribution: 'structured' as const }, opts);
      }
      readFileSync(join(project, '.venv', 'pkg', 'preexisting.dat'), 'utf8');
      if (writeKind === 'known-tree') put(join(project, 'src', 'escaped.ts'), 'export const escape = true;\n');
      if (writeKind === 'ignored-tree') put(join(project, '.venv', 'pkg', 'preexisting.dat'), 'changed\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
      return fixtureResult({ output: 'finished', exitCode: 0, duration_ms: 250,
        writes: writeKind === 'known-tree' ? ['src/escaped.ts']
          : writeKind === 'ignored-tree' ? ['.venv/pkg/preexisting.dat'] : [],
        writeAttribution: 'structured' as const }, opts);
    } };
    const final = await runWorkflow(config, yaml, project, adapter, new Map(), undefined,
      join(project, 'config', 'agents'), created.runId, 'ignored file fixture', true);
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
  it('binds declared run and project outputs independently of prompt wording', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-boundary-c-'));
    try {
      const project = join(root, 'project');
      const runDir = join(root, 'run');
      mkdirSync(project);
      put(join(runDir, 'validation_final.json'), '{"passed":true}\n');
      const contextual = inspectStageArtifactContract({ stageId: 'write_report',
        template: "Write this run's validation_final.json.", projectDir: project, runDir,
        writes: ['run:validation_final.json'],
        artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'validation', root: 'run', path: 'validation_final.json' }], reads: [] }) });
      expect(contextual.violations).toEqual([]);
      expect(contextual.producedPromptArtifacts).toEqual([join(runDir, 'validation_final.json')]);
      expect(contextual.obligations).toEqual([expect.objectContaining({ path: join(runDir, 'validation_final.json'), source: 'declaration' })]);
      const ordinary = inspectStageArtifactContract({ stageId: 'write_report',
        template: 'Write validation_final.json.', projectDir: project, runDir,
        writes: ['run:validation_final.json'],
        artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'validation', root: 'project', path: 'validation_final.json' }], reads: [] }) });
      expect(ordinary.violations).toEqual([expect.objectContaining({ reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT') })]);
      expect(ordinary.producedPromptArtifacts).toEqual([]);
      const missing = inspectStageArtifactContract({ stageId: 'write_report', template: "Write this run's validation_final.json.", projectDir: project, runDir, writes: ['run:validation_final.json'] });
      expect(missing.violations[0].reason).toContain('ARTIFACT_DECLARATION_REQUIRED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not attribute a preexisting ignored file to a stage that only reads', async () => {
    expect(await ignoredFileCase('none')).toMatchObject({
      runStatus: 'complete', incidents: [], originalBytes: 'preexisting\n', escapedExists: false,
    });
  });

  it('accepts legitimate work in a known project tree outside the estimate', async () => {
    const result = await ignoredFileCase('known-tree');
    expect(result.runStatus).toBe('complete');
    expect(result.incidents).toEqual([]);
    expect(result.incidents).not.toContain('.venv/pkg/preexisting.dat');
    expect(result.escapedExists).toBe(true);
  });

  it('accepts a legitimate change to a locator-only preexisting file', async () => {
    const result = await ignoredFileCase('ignored-tree');
    expect(result.runStatus).toBe('complete');
    expect(result.incidents).toEqual([]);
    expect(result.originalBytes).toBe('changed\n');
  });

  it('never blames an innocent reader for a later serialized peer write', async () => {
    const result = await ignoredFileCase('peer-writes');
    expect(result.readerIncidents).toEqual([]);
    expect(result.readerIncidents).not.toContain('.venv/pkg/preexisting.dat');
    expect(result.escapedExists).toBe(true);
  });
});
