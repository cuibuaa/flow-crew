/** Owned child engine. Stdout checkpoints + stdin acknowledgments synchronize
 * crashes with writes; no sleep, polling deadline, daemon or real adapter. */
import fs from 'node:fs';
import type { RunStatus } from '../../src/store.js';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2]);
const mode = process.argv[3];
if (process.env.FC_HOME !== join(root, 'fc') || process.env.TMPDIR !== join(root, 'tmp')
    || process.env.FLOWCREW_DAEMON_SOCKET !== join(root, 'daemon.sock')) throw new Error('private engine environment required before module load');
const NativeDate = Date;
const instant = '2035-02-03T04:05:06.000Z';
globalThis.Date = class extends NativeDate {
  constructor(value?: string | number) { super(value ?? instant); }
  static now() { return NativeDate.parse(instant); }
} as DateConstructor;

const store = await import('../../src/store.js');
const { observeEnginePublications } = await import('../../src/engine-fs.js');
const { runRecordPath } = await import('../../src/run-layout.js');
const { prepareWorkflowLaunch } = await import('../../src/scheduler/sched_loop/launch.js');
const { WorkflowConfigSchema } = await import('../../src/scheduler/sched_admission/configuration.js');
const { concludeRun, cancelRunStateAtPath } = await import('../../src/scheduler/sched_policy/run-completion.js');
const { reconcileHostInterruptedRun } = await import('../../src/restart-recovery.js');
const { requestDeploymentHold, parkAtDeploymentBoundary } = await import('../../src/deployment-hold.js');
const { parkProviderQuota } = await import('../../src/scheduler/sched_settlement/stage-execution.js');
store.setFcGlobalDir(join(root, 'fc'));
const project = join(root, 'project');
fs.mkdirSync(project, { recursive: true });
const workflow = WorkflowConfigSchema.parse({ name: 'lifecycle-fixture', defaults: { max_iterations: 2 }, stages: [{ id: 'work', role: 'worker', artifact_contract: { version: 1, produces: [], reads: [] } }] });
const { stringify } = await import('yaml');
const yaml = stringify(workflow);
const reserved = store.reserveRun(project);
const { runId, runDirPath: directory } = reserved;
if (mode !== 'initialize') store.initializeReservedRun(project, runId, workflow.name, yaml, ['work']);
if (['resume', 'import-resume', 'import-short'].includes(mode)) store.updateRunState(project, runId, state => { state.status = 'parked'; });
if (['import-resume', 'import-short'].includes(mode)) {
  const record = JSON.parse(fs.readFileSync(join(directory, 'run.json'), 'utf8'));
  delete record.lifecycleAuthority;
  delete record.lifecycleCursor;
  // Old observation bytes may disagree with the historical snapshot.
  fs.writeFileSync(join(directory, 'run.json'), JSON.stringify(record));
}
if (mode === 'pause') requestDeploymentHold();
if (mode === 'quota') store.writeStageStatus(project, runId, 'work', { status: 'pending', retries: 0 });
if (mode === 'cancel-active' || mode === 'recovery-active') store.beginStageAttempt(project, runId, 'work', 0, instant);
if (mode === 'recovery-park' || mode === 'recovery-active') store.updateRunState(project, runId, state => {
  state.engineCheckpoint = { version: 2, runId, projectDir: project, pid: 1,
    bootId: 'previous-boot', at: instant, processes: [] };
});

if (mode === 'validation-park') {
  const { appendEvidence, captureProjectTree, VALIDATION_FACT_VERSION } = await import('../../src/evidence-ledger.js');
  store.updateRunState(project, runId, state => { state.planControl = { version: 1, stages: workflow.stages } as never; });
  store.writeStageStatus(project, runId, 'work', { status: 'complete', retries: 0, attempts: [
    { index: 1, status: 'complete', startedAt: instant, completedAt: instant, exitCode: 0 },
  ] });
  appendEvidence(directory, { kind: 'attempt', stageId: 'work', attemptIndex: 1, attemptStartedAt: instant,
    exitCode: 0, status: 'complete', treeHash: null, files: [],
    measurements: { inputTokens: null, outputTokens: null, durationMs: 0, provenance: 'adapter-reported' } });
  fs.writeFileSync(runRecordPath(directory, 'validation_baseline.json'), JSON.stringify({ version: 1,
    capturedAt: instant, source: 'project-declarations', baseline: { version: 1, results: [], discovery: {
      state: 'configured', configPath: 'fixture', missingRoles: [], commands: [
        { role: 'test', command: process.execPath, args: ['-e', 'throw Error("exhausted validation must not execute")'], display: 'stub validation' },
      ],
    } } }));
  const hash = captureProjectTree(project, '', directory).hash;
  if (!hash) throw new Error('fixture source identity unavailable');
  fs.mkdirSync(join(root, 'fc', 'validation'), { recursive: true });
  fs.writeFileSync(join(root, 'fc', 'validation', hash + '.json'), JSON.stringify({ validationVersion: VALIDATION_FACT_VERSION,
    treeHash: hash, resourceState: 'unfinished', recordPath: 'exhausted-fixture', executions: [],
    limits: { timeoutMs: 1, attempts: 1 }, spentMs: Number.MAX_SAFE_INTEGER, pass: false }));
}

// Patch only sync notifications; writes still use native storage. The existing
// engine publication observer supplies mutation boundaries including temp bytes.
const descriptors = new Map<number, string>();
const nativeOpen = fs.openSync, nativeClose = fs.closeSync, nativeSync = fs.fsyncSync, nativeWrite = fs.writeSync;
const relevant = (path: string) => path.startsWith(directory + '/')
  && (/^(?:events\.jsonl|run\.json|run_event_status\.json|summary\.md|\.run-reservation\.json)(?:\.tmp\..*)?$/.test(basename(path))
    || path.includes('/engine/stages/') && /^status\.json(?:\.tmp\..*)?$/.test(basename(path)));
let armed = true, index = 0;
const checkpoint = (kind: string, path: string) => {
  if (!armed || !relevant(path)) return;
  fs.writeSync(1, JSON.stringify({ checkpoint: ++index, kind, path, runId, directory, project }) + '\n');
  const ack = Buffer.alloc(1);
  if (fs.readSync(0, ack, 0, 1, null) !== 1) throw new Error('checkpoint controller disconnected');
};
fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
  const descriptor = nativeOpen(...args); descriptors.set(descriptor, String(args[0])); return descriptor;
}) as typeof fs.openSync;
fs.closeSync = ((descriptor: number) => { descriptors.delete(descriptor); return nativeClose(descriptor); }) as typeof fs.closeSync;
fs.fsyncSync = ((descriptor: number) => {
  nativeSync(descriptor);
  const path = descriptors.get(descriptor);
  if (path && (relevant(path) || path === directory)) checkpoint(path === directory ? 'fsync-directory' : 'fsync-file', path === directory ? join(directory, 'events.jsonl') : path);
}) as typeof fs.fsyncSync;
let split = false;
fs.writeSync = ((fd: number, data: string | Uint8Array, offset?: number, length?: number, position?: number | null) => {
  if (typeof data === 'string') return nativeWrite(fd, data, offset);
  let count = length ?? data.byteLength;
  if (armed && !split && ['terminal-short', 'import-short'].includes(mode) && descriptors.get(fd) === join(directory, 'events.jsonl')) {
    const end = Buffer.from(data.buffer, data.byteOffset, data.byteLength).indexOf(0x0a, offset ?? 0);
    if (end > (offset ?? 0)) { count = end - (offset ?? 0); split = true; }
  }
  return nativeWrite(fd, data, offset ?? 0, count, position);
}) as typeof fs.writeSync;
syncBuiltinESMExports();
observeEnginePublications((paths, _tree, publication) => () => {
  const path = publication?.transfer?.[1] ?? paths[0];
  const kind = publication?.transfer ? 'rename' : publication?.write?.bytes.length ? 'write' : 'open';
  checkpoint(kind, path);
});
fs.writeSync(1, JSON.stringify({ ready: true, runId, directory, project }) + '\n');
if (mode === 'initialize') store.initializeReservedRun(project, runId, workflow.name, yaml, ['work']);
else if (mode === 'terminal-short') await concludeRun(store.readRunState(project, runId), { status: 'failed', reasonCode: 'workflow_complete' });
else if (mode.startsWith('terminal:')) await concludeRun(store.readRunState(project, runId), {
  status: mode.slice('terminal:'.length) as RunStatus, reasonCode: 'workflow_complete',
});
else if (mode === 'pause') parkAtDeploymentBoundary(project, runId);
else if (mode === 'park') store.updateRunState(project, runId, state => { state.status = 'parked'; });
else if (mode === 'quota') parkProviderQuota(store.readRunState(project, runId), project, runId, 'work', {
  output: '', exitCode: 1, duration_ms: 0, endingCause: 'provider_quota',
  providerFailure: { kind: 'quota', provider: 'stub', source: 'native_stdout', resetAt: '2035-02-04T00:00:00.000Z' },
} as never);
else if (mode === 'resume' || ['import-resume', 'import-short'].includes(mode)) prepareWorkflowLaunch(workflow, yaml, project, runId);
else if (mode === 'validation-park') await (await import('../../src/scheduler/sched_settlement/gate-validation.js')).validateSettledTree(project, runId);
else if (mode === 'cancel' || mode === 'cancel-active') cancelRunStateAtPath(directory, instant);
else if (mode === 'recovery-park' || mode === 'recovery-active') reconcileHostInterruptedRun(project, runId, { currentBootId: 'current-boot', assertSchedulerAbsent: () => {} });
else if (mode === 'recovery-block') reconcileHostInterruptedRun(project, runId, { assertSchedulerAbsent: () => {} });
else throw new Error(`Unknown fixture transition ${mode}`);
armed = false;
fs.writeSync(1, JSON.stringify({ done: true, checkpoints: index, status: store.readRunState(project, runId).status }) + '\n');
