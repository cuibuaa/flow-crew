import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentConfig } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { LiveConstraintGuard, readLiveConstraintIncidents } from '../src/live-constraint-guard.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { createRun, readRunState, readStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const role: AgentConfig = {
  name: 'fixture', description: 'fixture', model: 'fixture', reasoning_effort: 'default', tools: [], prompt: 'fixture',
};
const providers = ['claude', 'codex'] as const;
let root: string, project: string, runDir: string, callsPath: string;

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), '.authentication-spec-'));
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
  project = join(root, 'project'); runDir = join(root, 'run'); callsPath = join(root, 'calls.jsonl');
  const bin = join(root, 'bin');
  for (const directory of [project, runDir, bin, join(root, 'codex-source'), join(root, 'plugins'), join(root, 'skills')]) mkdirSync(directory);
  // An empty synthetic source prevents this fixture from touching operator credentials.
  vi.stubEnv('CODEX_HOME', join(root, 'codex-source'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  vi.stubEnv('FC_AUTH_FIXTURE_CALLS', callsPath);
  setEngineDefaults({ timeout_ms: 5_000, stage_technical_retries: 2 });
  for (const provider of providers) writeFileSync(join(bin, provider), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path');
process.stdin.resume();
process.stdin.on('end', () => {
  const provider = path.basename(process.argv[1]);
  fs.appendFileSync(process.env.FC_AUTH_FIXTURE_CALLS, JSON.stringify({ provider, argv: process.argv.slice(2) }) + '\n');
  if (process.env.FC_AUTH_FIXTURE_MODE === 'prose') {
    const text = 'The report quotes: Not logged in · Please run /login; 401 Unauthorized authentication';
    if (provider === 'claude') console.log(JSON.stringify({ type: 'result', is_error: false, result: text }));
    else console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    process.exitCode = 1;
    return;
  }
  const firstCapacity = process.env.FC_AUTH_FIXTURE_MODE === 'capacity-auth'
    && fs.readFileSync(process.env.FC_AUTH_FIXTURE_CALLS, 'utf8').trim().split('\n').length === 1;
  const diagnostic = firstCapacity ? 'model is at capacity' : provider === 'claude'
    ? 'Not logged in · Please run /login' : '401 Unauthorized authentication';
  // No init/thread event: authentication failed before session attestation.
  if (provider === 'claude') console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, result: diagnostic,
  }));
  else console.log(JSON.stringify({ type: 'turn.failed', error: { message: diagnostic } }));
  process.exitCode = 1;
});
`, { mode: 0o700 });
});

afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function adapter(provider: typeof providers[number]) {
  return provider === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
}

function calls(): Array<{ provider: string; argv: string[] }> {
  return existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

function scenario(repair = false) {
  const stageId = repair ? 'repair' : 'work';
  const workflow = WorkflowConfigSchema.parse({
    name: 'authentication-fixture', defaults: { max_iterations: 1, max_retries: 2 },
    stages: [{ id: stageId, role: 'fixture', scope: [], prompt_template: 'fixture',
      ...(repair ? { retry_to: ['review'] } : {}), artifact_contract: fixtureArtifactContract(stageId) }],
  });
  return { stageId, workflow, created: createRun(project, workflow.name, stringify(workflow), [stageId]) };
}

describe('native authentication failures', () => {
  it.each(['Not logged in · Please run /login', '401 Unauthorized', 'authentication_error',
    'Authentication failed', 'invalid API key', 'invalid token'])('shares the non-retryable classification for %s', diagnostic => {
    const kind = classifyAdapterFailure(diagnostic);
    expect(kind).toBe('authentication');
    expect(isRetryableAdapterFailure(kind)).toBe(false);
  });

  it('retains transport recovery when its diagnostic mentions authentication infrastructure', () => {
    const kind = classifyAdapterFailure('authentication service connection reset: ECONNRESET');
    expect(kind).toBe('connection_reset');
    expect(isRetryableAdapterFailure(kind)).toBe(true);
  });

  it.each(providers)('%s classifies auth failure without replaying an unattested resume', async provider => {
    const result = await withEngineIntegrity({ projectDir: project, runDir, stageId: 'work',
      artifactContract: fixtureArtifactContract('work') },
    () => adapter(provider).run('fixture', role, { workDir: project, runDir, stageId: 'work', timeout_ms: 5_000,
      resumeSessionId: uuid, sessionOwnerStageId: 'work', freshSessionPrompt: 'fresh fixture' }));
    expect(result).toMatchObject({ exitCode: 1, adapterError: true, adapterFailureKind: 'authentication' });
    expect(result.invocations).toHaveLength(1);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].argv).toContain(provider === 'claude' ? '--resume' : 'resume');
    expect(calls()[0].argv).toContain(uuid);
  });

  it.each(providers)('%s does not classify an auth error quoted in agent-authored output', async provider => {
    vi.stubEnv('FC_AUTH_FIXTURE_MODE', 'prose');
    const result = await withEngineIntegrity({ projectDir: project, runDir, stageId: 'work',
      artifactContract: fixtureArtifactContract('work') },
    () => adapter(provider).run('fixture', role, { workDir: project, runDir, stageId: 'work', timeout_ms: 5_000 }));
    expect(result).toMatchObject({ exitCode: 1, adapterError: false });
    expect(result.adapterFailureKind).toBeUndefined();
    expect(result.output).toContain('Not logged in');
    expect(calls()).toHaveLength(1);
  });

  it.each(providers)('%s stops worker backoff when a retryable failure becomes authentication failure', async provider => {
    vi.stubEnv('FC_AUTH_FIXTURE_MODE', 'capacity-auth');
    const s = scenario();
    const result = await runStage(adapter(provider), {
      stageId: s.stageId, role, dependsOn: [], promptTemplate: 'fixture', artifactContract: fixtureArtifactContract(s.stageId),
      projectDir: project, runId: s.created.runId, runDir: s.created.runDirPath, retries: 0, timeout_ms: 5_000,
      projectWriteScope: [], technicalRetry: { delaysMs: [0, 0, 0] },
    });
    expect(result).toMatchObject({ exitCode: 1, adapterError: true, adapterFailureKind: 'authentication' });
    expect(calls()).toHaveLength(2);
    expect(readStageStatus(project, s.created.runId, s.stageId).attempts).toHaveLength(1);
  });

  it.each(providers)('%s retains authentication failure without replaying a restored scope incident', async provider => {
    const s = scenario();
    let incidentReported = false;
    const result = await runStage(adapter(provider), {
      stageId: s.stageId, role, dependsOn: [], promptTemplate: 'fixture', artifactContract: fixtureArtifactContract(s.stageId),
      projectDir: project, runId: s.created.runId, runDir: s.created.runDirPath, retries: 0, timeout_ms: 5_000,
      projectWriteScope: [], technicalRetry: { delaysMs: [0, 0, 0] },
      liveConstraintGuardFactory: ({ attemptIndex }) => new LiveConstraintGuard({
        projectDir: project, runDir: s.created.runDirPath, stageId: s.stageId, attemptIndex,
        effectiveScope: () => [], watchProject: () => undefined,
        scopeRevisionInstruction: () => 'correct the restored scope incident',
        scanAndRestore: (_paths, trigger) => {
          // Report the synthetic restored incident only after the real fixture CLI closes.
          if (trigger !== 'phase_boundary' || incidentReported) return { scannedPaths: 0, violations: [] };
          incidentReported = true;
          return { scannedPaths: 1, violations: [{ path: 'protected.txt', reason: 'outside scope', restored: true }] };
        },
      }),
    });
    expect(result).toMatchObject({ exitCode: 1, adapterError: true, adapterFailureKind: 'authentication' });
    expect(calls()).toHaveLength(1);
    expect(result.invocations).toHaveLength(1);
    expect(readLiveConstraintIncidents(s.created.runDirPath, s.stageId, 1)).toEqual([
      expect.objectContaining({ path: 'protected.txt', restored: true, trigger: 'phase_boundary' }),
    ]);
    expect(readStageStatus(project, s.created.runId, s.stageId).attempts).toHaveLength(1);
  });

  it.each(providers)('%s fails the ordinary batch without consuming either retry allowance', async provider => {
    const s = scenario();
    await executeReadyBatch(s.workflow.stages, readRunState(project, s.created.runId), project,
      s.created.runId, s.created.runDirPath, s.workflow, adapter(provider), new Map([['fixture', role]]), project,
      new Map([['fixture', { name: role.name, description: role.description }]]), new Map());
    const state = readRunState(project, s.created.runId);
    expect(state).toMatchObject({ status: 'failed' });
    expect(state.failureReason).toContain('authentication');
    expect(readStageStatus(project, s.created.runId, s.stageId)).toMatchObject({ status: 'failed', retries: 0 });
    expect(readStageStatus(project, s.created.runId, s.stageId).attempts).toHaveLength(1);
    expect(calls()).toHaveLength(1);
  });

  it.each(providers.flatMap(provider => [
    { provider, repair: false, path: 'single ordinary' }, { provider, repair: true, path: 'repair' },
  ]))('$provider fails a $path execution without consuming either retry allowance', async ({ provider, repair }) => {
    const s = scenario(repair);
    await executeSingleStage(s.workflow.stages[0], project, s.created.runId, s.created.runDirPath,
      s.workflow, adapter(provider), new Map([['fixture', role]]), project, readRunState(project, s.created.runId),
      s.workflow.stages, undefined, undefined, repair ? 1 : undefined);
    const state = readRunState(project, s.created.runId);
    expect(state).toMatchObject({ status: 'failed' });
    expect(state.failureReason).toContain('authentication');
    expect(readStageStatus(project, s.created.runId, s.stageId)).toMatchObject({ status: 'failed', retries: 0 });
    expect(readStageStatus(project, s.created.runId, s.stageId).attempts).toHaveLength(1);
    expect(calls()).toHaveLength(1);
  });
});
