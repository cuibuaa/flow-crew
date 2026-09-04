import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../src/adapters/base.js';
import {
  compareLiveConstraintContentIdentities,
  readLiveConstraintContentIdentity,
} from '../src/live-constraint-guard.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

let projectDir: string;
let stateDir: string;
let priorStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-content-truth-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-content-truth-state-'));
  priorStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
});

afterEach(() => {
  setFcGlobalDir(priorStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function seedProject(): string {
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
  writeFileSync(join(projectDir, 'config', 'agents', 'scout.yaml'), [
    'name: scout',
    'description: content truth fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const target = join(projectDir, 'tracked.txt');
  writeFileSync(target, 'original bytes\n');
  for (const path of [
    join(projectDir, 'config', 'defaults.yaml'),
    join(projectDir, 'config', 'agents', 'scout.yaml'),
    target,
  ]) chmodSync(path, 0o644);
  return target;
}

const GIT_FIXTURE_SCRIPT = [
  "import { spawnSync } from 'node:child_process';",
  'const result = spawnSync(\'git\', JSON.parse(process.argv[1]), { encoding: \'utf8\' });',
  'if (result.error) throw result.error;',
  'if (result.status !== 0) { process.stderr.write(result.stderr ?? \'\'); process.exit(result.status ?? 1); }',
].join('\n');

function git(args: string[]): void {
  execFileSync(process.execPath, [
    '--input-type=module', '-e', GIT_FIXTURE_SCRIPT, JSON.stringify(args),
  ], {
    cwd: projectDir,
    env: { ...process.env, HOME: stateDir, FC_HOME: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitProject(): void {
  git(['init', '--quiet']);
  git(['config', 'user.name', 'FlowCrew Test']);
  git(['config', 'user.email', 'flowcrew-test@example.invalid']);
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'fixture preimage']);
}

function workflow(scope: string[], suffix: string): { config: WorkflowConfig; yaml: string } {
  const config: WorkflowConfig = {
    name: `content-truth-${suffix}`,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{
      id: 'scout', role: 'scout', scope, depends_on: [],
      prompt_template: 'Read the fixture.', skills: [], dynamic_dispatch: false, is_gate: false,
    }],
  };
  const yaml = [
    `name: content-truth-${suffix}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: scout',
    '    role: scout',
    `    scope: [${scope.map((entry) => JSON.stringify(entry)).join(', ')}]`,
    '    depends_on: []',
    '    prompt_template: Read the fixture.',
  ].join('\n');
  return { config, yaml };
}

async function run(scope: string[], suffix: string, adapter: Adapter) {
  const declared = workflow(scope, suffix);
  const created = createRun(projectDir, declared.config.name, declared.yaml, ['scout']);
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.maxRetries = 0;
  writeRunState(projectDir, created.runId, state);
  const final = await runWorkflow(
    declared.config,
    declared.yaml,
    projectDir,
    adapter,
    new Map(),
    undefined,
    join(projectDir, 'config', 'agents'),
    created.runId,
    'content truth test',
    true,
    false,
  );
  const stagePath = join(created.runDirPath, 'stages', 'scout');
  const incidents = readdirSync(stagePath)
    .filter((name) => /^live_constraint_incidents_attempt_\d+\.jsonl$/.test(name))
    .flatMap((name) => readFileSync(join(stagePath, name), 'utf8').trim().split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as { path: string; restored: boolean; rollbackFailure?: string });
  return {
    final,
    status: readStageStatus(projectDir, created.runId, 'scout'),
    incidents,
  };
}

describe('live guard content truth', () => {
  it('defines identity from object type, byte length, and bytes while ignoring timestamps and permissions', () => {
    const path = join(projectDir, 'identity.txt');
    writeFileSync(path, 'same bytes\n');
    const before = readLiveConstraintContentIdentity(path);
    chmodSync(path, 0o777);
    const future = new Date(Date.now() + 86_400_000);
    utimesSync(path, future, future);
    expect(compareLiveConstraintContentIdentities(before, readLiveConstraintContentIdentity(path))).toBe('equal');

    writeFileSync(path, 'diff bytes\n');
    expect(compareLiveConstraintContentIdentities(before, readLiveConstraintContentIdentity(path))).toBe('different');

    const link = join(projectDir, 'identity-link');
    symlinkSync('diff bytes\n', link);
    expect(compareLiveConstraintContentIdentities(
      readLiveConstraintContentIdentity(path),
      readLiveConstraintContentIdentity(link),
    )).toBe('different');
    expect(compareLiveConstraintContentIdentities(
      before,
      { state: 'unavailable', reason: 'simulated unstable read' },
    )).toBe('unavailable');

    const rawLink = join(projectDir, 'raw-identity-link');
    symlinkSync(Buffer.from([0xff]), rawLink);
    const rawBefore = readLiveConstraintContentIdentity(rawLink);
    rmSync(rawLink);
    symlinkSync(Buffer.from([0xfe]), rawLink);
    expect(compareLiveConstraintContentIdentities(
      rawBefore,
      readLiveConstraintContentIdentity(rawLink),
    )).toBe('different');
  });

  it.each([
    { label: 'empty', scope: [] },
    { label: 'non-empty', scope: ['allowed.txt'] },
  ])('dispatches once without an incident for unchanged bytes under a $label effective scope', async ({ label, scope }) => {
    const target = seedProject();
    let invocationCount = 0;
    const result = await run(scope, `metadata-${label}`, { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      invocationCount++;
      chmodSync(target, 0o777);
      const future = new Date(Date.now() + 86_400_000);
      utimesSync(target, future, future);
      readFileSync(target);
      return { output: 'read-only scout', exitCode: 0, duration_ms: 1 };
    } });
    expect(result.final.status).toBe('complete');
    expect(result.status.status).toBe('complete');
    expect(invocationCount).toBe(1);
    expect(result.incidents).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('original bytes\n');
  });

  it('does not attribute a timestamp-only scoped artifact as a write', async () => {
    const target = seedProject();
    const result = await run(['tracked.txt'], 'touch-artifact', { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      const future = new Date(Date.now() + 86_400_000);
      utimesSync(target, future, future);
      return { output: 'touch only', exitCode: 0, duration_ms: 1 };
    } });
    expect(result.status.status).toBe('complete');
    expect(result.status.artifacts ?? []).not.toContain('tracked.txt');
    expect(result.status.writes ?? []).not.toContain('tracked.txt');
    expect(result.incidents).toEqual([]);
  });

  it('ignores structured timestamp-only attribution under an empty effective scope', async () => {
    const target = seedProject();
    const result = await run([], 'structured-touch', { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      const future = new Date(Date.now() + 86_400_000);
      utimesSync(target, future, future);
      return {
        output: 'structured timestamp-only attribution', exitCode: 0, duration_ms: 1,
        writes: ['tracked.txt'], writeAttribution: 'structured',
      };
    } });
    expect(result.final.status).toBe('complete');
    expect(result.status.status).toBe('complete');
    expect(result.status.constraintAudit).toMatchObject({
      violationCount: 0,
      unresolvedViolationCount: 0,
      rawWriteCount: 1,
      rolledBackWriteCount: 0,
    });
    expect(result.incidents).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('original bytes\n');
  });

  it.each(['clean', 'dirty'] as const)(
    'detects and restores non-UTF-8 symbolic-link targets from a %s preimage',
    async (preimageState) => {
      seedProject();
      const link = join(projectDir, 'tracked-link');
      const preimage = Buffer.from([0xff]);
      if (preimageState === 'clean') {
        symlinkSync(preimage, link);
        commitProject();
      } else {
        symlinkSync('committed-target', link);
        commitProject();
        rmSync(link);
        symlinkSync(preimage, link);
      }

      let invocationCount = 0;
      const result = await run([], `raw-symlink-${preimageState}`, { async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount++;
        if (invocationCount === 1) {
          rmSync(link);
          symlinkSync(Buffer.from([0xfe]), link);
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline && !readlinkSync(link, { encoding: 'buffer' }).equals(preimage)) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
          }
          return {
            output: 'changed raw symbolic-link target', exitCode: 0, duration_ms: 1,
            writes: ['tracked-link'], writeAttribution: 'structured',
          };
        }
        return {
          output: 'corrected symbolic-link target', exitCode: 0, duration_ms: 1,
          writes: [], writeAttribution: 'structured',
        };
      } });

      expect(result.final.status).toBe('complete');
      expect(result.status.status).toBe('complete');
      expect(invocationCount).toBe(2);
      expect(result.incidents).toHaveLength(1);
      expect(result.incidents[0]).toMatchObject({ path: 'tracked-link', restored: true });
      expect(result.status.constraintAudit).toMatchObject({
        violationCount: 1,
        unresolvedViolationCount: 0,
        liveViolationCount: 1,
        liveRestoredCount: 1,
      });
      expect(readlinkSync(link, { encoding: 'buffer' })).toEqual(preimage);
    },
  );

  it('diagnoses a replacement failure without deleting the changed file', async () => {
    const target = seedProject();
    let invocationCount = 0;
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run([], 'replacement-failure', { async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount++;
        chmodSync(projectDir, 0o555);
        writeFileSync(target, 'changed bytes remain present\n');
        return {
          output: 'genuine write with blocked atomic replacement', exitCode: 0, duration_ms: 1,
          writes: ['tracked.txt'], writeAttribution: 'structured',
        };
      } });
    } finally {
      chmodSync(projectDir, 0o755);
    }
    expect(result.status.status).toBe('failed');
    expect(invocationCount).toBe(1);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({ path: 'tracked.txt', restored: false });
    expect(result.incidents[0].rollbackFailure).toContain('could not restore tracked.txt');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('changed bytes remain present\n');
  });
});
