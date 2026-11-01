import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { evaluateCondition } from '../src/condition.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { readRunEvents } from '../src/run-events.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const stageId = 'verify_v3';
const carrier = `verdict_${stageId}.json`;
const legacyInstruction = `Write ${carrier} as the gate verdict {pass:boolean,reason:string}`;
const delivered = JSON.stringify({ status: 'delivered', summary: 'Finished assigned work.', checks: [], caveats: [], remaining_work: [] });
const role: AgentConfig = { name: 'fixture', description: 'Fixture role', tools: [], prompt: 'Perform the assigned stage.' };
const planner: AgentConfig = { ...role, name: 'planner',
  prompt: parse(readFileSync(join(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml'), 'utf8')).prompt };
let root: string, project: string, agentsDir: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-own-verdict-'));
  project = join(root, 'project');
  agentsDir = join(project, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of [role, planner]) writeFileSync(join(agentsDir, `${agent.name}.yaml`), stringify(agent));
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ gate_retry_loops: 0, stage_technical_retries: 0 });
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

function verdict(pass = true) {
  return { pass, reason: pass ? 'Independent review accepted the work.' : 'Independent review rejected the work.',
    criteria: {}, audit_findings: { version: 1, findings: [] }, remaining_work: [],
    ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'The reported defect can be repaired.' } } : {}),
  };
}

async function launch(options: { pass?: boolean; noAnswer?: boolean; correctAnswer?: boolean; otherCarrier?: boolean; writeOwn?: boolean } = {}) {
  // The planner really authors and dispatches the conflicting template. The
  // adapter writes with node:fs, without an engine publication acknowledgement.
  const plan = { stages: [
    { id: stageId, role: 'fixture', is_gate: true, scope: [], prompt_template: legacyInstruction,
      artifact_contract: fixtureArtifactContract(stageId, true) },
    { id: 'dependent', role: 'fixture', scope: [], depends_on: [stageId], condition: `${stageId}.pass == true`,
      prompt_template: 'Continue only after accepted review.', artifact_contract: fixtureArtifactContract('dependent') },
    { id: 'repair', role: 'fixture', scope: [], depends_on: [stageId], retry_to: [stageId],
      prompt_template: 'Repair rejected work.', artifact_contract: fixtureArtifactContract('repair') },
  ] };
  const workflow = WorkflowConfigSchema.parse({ name: 'gate-own-verdict', defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{ id: 'plan', role: 'planner', scope: [], dynamic_dispatch: true,
      prompt_template: 'Write the execution plan.', artifact_contract: {
        version: 1, produces: [{ id: 'dispatch', root: 'run', path: 'dispatch.yaml' }], reads: [],
      } }],
  });
  const yaml = stringify(workflow);
  const created = prepareFixtureRun(project, workflow, yaml);
  updateRunState(project, created.runId, state => { state.maxRetries = 0; });
  const answer = verdict(options.pass ?? true);
  const calls: string[] = [];
  const prompts: string[] = [];
  const plannerPrompts: string[] = [];
  const adapter: Adapter = { async run(prompt, invocationRole, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'plan') {
      plannerPrompts.push(invocationRole.prompt);
      writeFileSync(join(opts.runDir, 'dispatch.yaml'), stringify(plan));
      return { output: delivered, exitCode: 0, duration_ms: 1, writes: ['run:dispatch.yaml'], writeAttribution: 'structured' };
    }
    if (opts.stageId === stageId) {
      prompts.push(prompt);
      if (options.writeOwn !== false) writeFileSync(join(opts.runDir, carrier), '{"pass":true,"reason":"stage-authored counterfeit"}');
      if (options.otherCarrier) writeFileSync(join(opts.runDir, 'verdict_dependent.json'), '{"pass":true}');
      return { output: options.noAnswer || options.correctAnswer && prompts.length === 1
        ? 'Review completed, but no structured final answer.' : JSON.stringify(answer, null, 2),
        exitCode: 0, duration_ms: 1, writes: [
          ...(options.writeOwn !== false ? [`run:${carrier}`] : []),
          ...(options.otherCarrier ? ['run:verdict_dependent.json'] : []),
        ], writeAttribution: 'structured' };
    }
    return { output: delivered, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
  } };
  const state = await runWorkflow(workflow, yaml, project, adapter,
    new Map([['fixture', role], ['planner', planner]]), undefined, agentsDir, created.runId);
  return { state, calls, prompts, plannerPrompts, answer, directory: created.runDirPath,
    stage: readStageStatus(project, created.runId, stageId), events: readRunEvents(project, created.runId) };
}

it('publishes the validated answer after a planner-instructed write to the gate own carrier, recording a warning', async () => {
  const result = await launch();
  expect(result.prompts[0]).toContain(legacyInstruction);
  expect(result.prompts[0]).toContain('The engine validates and publishes that answer');
  expect(result.state.status, result.state.failureReason).toBe('complete');
  expect(result.plannerPrompts[0]).toContain('final structured JSON answer');
  expect(result.plannerPrompts[0]).toContain('the engine validates it and publishes verdict_<stage_id>.json');
  expect(result.plannerPrompts[0]).toContain('Stage templates must not instruct stages to write verdict files or other engine-owned files');
  expect(result.stage).toMatchObject({ status: 'complete', exitCode: 0 });
  expect(result.calls).toContain('dependent');
  expect(readFileSync(join(result.directory, carrier), 'utf8')).toBe(`${JSON.stringify(result.answer)}\n`);
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'execution_notice', level: 'warning', stageId,
    files: [join(result.directory, carrier)], detail: expect.stringContaining('engine-published carrier') }));
  expect(result.events.some(event => event.detail?.includes('ENGINE_STATE_TAMPERED'))).toBe(false);
});

it('recognizes its own publication carrier when the configured store has a symlink ancestor', async () => {
  const physicalStore = fcGlobalDir();
  mkdirSync(physicalStore, { recursive: true });
  const alias = join(root, 'store-link');
  symlinkSync(physicalStore, alias, 'dir');
  setFcGlobalDir(alias);

  const result = await launch();

  expect(result.directory).toBe(join(alias, 'runs', result.state.runId));
  expect(result.state.status, result.state.failureReason).toBe('complete');
  expect(readFileSync(join(result.directory, carrier), 'utf8')).toBe(`${JSON.stringify(result.answer)}\n`);
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'execution_notice', level: 'warning', stageId,
    files: [join(physicalStore, 'runs', result.state.runId, carrier)], detail: expect.stringContaining('engine-published carrier') }));
});

it('uses a rejecting final answer instead of a forged passing file, keeping downstream conditions false', async () => {
  const result = await launch({ pass: false });
  expect(result.stage).toMatchObject({ status: 'complete', exitCode: 0 });
  expect(result.state.failureReason ?? '').not.toContain('ENGINE_STATE_TAMPERED');
  expect(readFileSync(join(result.directory, carrier), 'utf8')).toBe(`${JSON.stringify(result.answer)}\n`);
  expect(evaluateCondition(`${stageId}.pass == true`, project, result.state.runId)).toBe(false);
  expect(result.calls).not.toContain('dependent');
});

it('discards a stage-written verdict when the gate provides no valid final answer', async () => {
  const control = await launch({ noAnswer: true, writeOwn: false });
  const result = await launch({ noAnswer: true });
  expect(result.state.status).toBe(control.state.status);
  expect(result.stage).toMatchObject({ status: control.stage.status, exitCode: control.stage.exitCode, error: control.stage.error });
  expect(result.stage.exitCode).toBe(1);
  expect(result.stage.error).toContain('Stage record refused');
  expect(result.calls).toEqual(control.calls);
  expect(result.prompts).toHaveLength(2);
  expect(result.prompts[1]).toContain('# Stage result correction');
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'execution_notice', level: 'warning', stageId,
    files: [join(result.directory, carrier)] }));
  expect(result.events.some(event => event.detail?.includes('ENGINE_STATE_TAMPERED'))).toBe(false);
  expect(existsSync(join(result.directory, carrier))).toBe(false);
  expect(evaluateCondition(`${stageId}.pass == true`, project, result.state.runId)).toBe(false);
  expect(result.calls).not.toContain('dependent');
});

it('corrects an invalid first answer in the same attempt after restoring its own verdict write', async () => {
  const result = await launch({ correctAnswer: true });
  expect(result.state.status, result.state.failureReason).toBe('complete');
  expect(result.stage).toMatchObject({ status: 'complete', exitCode: 0 });
  expect(result.stage.attempts).toHaveLength(1);
  expect(result.prompts).toHaveLength(2);
  expect(result.prompts[1]).toContain('# Stage result correction');
  expect(result.calls).toContain('dependent');
  expect(readFileSync(join(result.directory, carrier), 'utf8')).toBe(`${JSON.stringify(result.answer)}\n`);
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'execution_notice', level: 'warning', stageId,
    files: [join(result.directory, carrier)] }));
  expect(result.events.some(event => event.detail?.includes('ENGINE_STATE_TAMPERED'))).toBe(false);
});

it('still voids an attempt that also writes another stage verdict', async () => {
  const result = await launch({ otherCarrier: true });
  expect(result.state.status).toBe('failed');
  expect(result.stage).toMatchObject({ status: 'failed', exitCode: 125 });
  expect(result.stage.error).toContain('ENGINE_STATE_TAMPERED');
  expect(result.stage.attempts).toMatchObject([{ terminationCause: 'engine_void', engineVoid: true }]);
  expect(existsSync(join(result.directory, 'verdict_dependent.json'))).toBe(false);
  expect(result.calls).not.toContain('dependent');
});

it('does not exempt a carrier absent from the worker publication list', async () => {
  const directory = join(root, 'run');
  mkdirSync(directory);
  await expect(withEngineIntegrity({ projectDir: project, runDir: directory, stageId,
    artifactContract: fixtureArtifactContract(stageId) }, async () => {
    writeFileSync(join(directory, carrier), '{"pass":true}');
    return { output: JSON.stringify(verdict()), exitCode: 0, duration_ms: 1 };
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(existsSync(join(directory, carrier))).toBe(false);
});

it('records a rewrite even when an existing engine publication has identical bytes', async () => {
  const directory = join(root, 'run');
  mkdirSync(directory);
  const path = join(directory, carrier), bytes = `${JSON.stringify(verdict())}\n`;
  writeFileSync(path, bytes);
  const alias = join(root, 'run-link');
  symlinkSync(directory, alias, 'dir');
  let warned: string[] = [];
  await withEngineIntegrity({ projectDir: project, runDir: alias, stageId,
    publicationCarriers: [carrier], onPublicationWrite: paths => { warned = paths; } }, async () => {
    // Replacement guarantees a different identity even on coarse timestamp filesystems.
    const replacement = join(root, 'replacement');
    writeFileSync(replacement, bytes);
    renameSync(replacement, join(alias, carrier));
  });
  expect(warned).toEqual([carrier]);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});
