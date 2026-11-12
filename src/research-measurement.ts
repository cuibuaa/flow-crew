import { RUN_STATUS } from './lifecycle-status.js';
import { readCommittedResearchState, verifyResearchRef as verifyRef, type ResearchCommit } from './research-history.js';
/** Frozen execution and durable settlement replace scientific measurement policy.
 * The carrier name remains stable for engine ownership and historical readers. */
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { atomicWrite, chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from './engine-fs.js';
import { updateFileHashSync } from './rollback-content-store.js';
import { createInvocationScratch } from './invocation-scratch.js';
import { withEngineIntegrity } from './engine-integrity.js';
import { spawnOwnedCommand, runProcessAbortSignal } from './adapters/base.js';
import { scheduleDeadline } from './attempt-deadline.js';
import { runRecordPath, assertSeparatedRunLayout } from './run-layout.js';
import { runDir as runDirForStateLookup, withRunStateLock, isTerminalRunStatus } from './store.js';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';
import { artifactRootContains, resolveArtifactLocation } from './artifact-location.js';
import { withProjectWriteOwnership } from './run-lock.js';
import { ResearchInstrumentSchema, RESEARCH_PROTOCOL, validateResearchResponse, parseResearchJSON,
  type ResearchConfig, type ResearchPhase, type ResearchRequest, type ResearchResponse,
  type ResearchOutcome, type CandidateSnapshot, type RecordRef, type ExecutionReceipt } from './research-instrument.js';
export type { CandidateSnapshot } from './research-instrument.js';
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fileDigest = (path: string): string => { const hash = createHash('sha256'); updateFileHashSync(path, hash); return hash.digest('hex'); };
type Inventory = Record<string, string>;
function inventory(root: string, paths: string[], changes = false): Inventory {
  const result: Inventory = {};
  const walk = (path: string): void => {
    const absolute = resolve(root, path);
    // Reject symlinks in every component, including declared directory parents.
    for (let p = absolute; p !== resolve(root); p = dirname(p)) {
      if (relative(root, p).startsWith('..') || lstatSync(p).isSymbolicLink()) throw new Error('measurement inputs must be regular, local, non-symlink paths');
    }
    const stat = lstatSync(absolute, { bigint: true });
    if (stat.isDirectory()) {
      result[path] = changes ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : `directory:${stat.mode}`;
      for (const child of readdirSync(absolute).sort()) walk(join(path, child));
    } else if (stat.isFile()) result[path] = changes ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : `file:${stat.mode}:${fileDigest(absolute)}`;
    else throw new Error('measurement input is not a regular file');
  };
  paths.forEach(walk);
  return result;
}
function snapshot(source: string, destination: string, paths: string[]): string {
  const before = inventory(source, paths);
  mkdirSync(destination, { recursive: true });
  for (const file of Object.keys(before)) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    if (before[file].startsWith('directory:')) mkdirSync(join(destination, file), { recursive: true });
    else copyFileSync(join(source, file), join(destination, file));
  }
  for (const file of Object.keys(before).reverse()) if (before[file].startsWith('directory:')) chmodSync(join(destination, file), Number(before[file].split(':')[1]) & 0o7777);
  if (digest(before) !== digest(inventory(source, paths)) || digest(before) !== digest(inventory(destination, paths))) throw new Error('input changed during snapshot');
  return digest(before);
}
const read = <T>(path: string): T => parseResearchJSON(readFileSync(path, 'utf8')) as T;
const save = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
export const researchDirectory = (run: string) => runRecordPath(run, 'research_measurement');
const directory = researchDirectory;
export interface ResearchInstrumentState {
  protocol: typeof RESEARCH_PROTOCOL; runId: string; projectDir: string; config: ResearchConfig;
  revision: number; startedAt: string; deadline: number | null;
  instrument: { files: Inventory; fingerprint: string };
  initial: CandidateSnapshot; incumbent: CandidateSnapshot;
  history: ResearchOutcome[]; instrumentState: unknown;
  stop?: ResearchResponse['stop']; error?: string;
  termination?: { reason: string; conclusion?: ResearchConclusion };
}
const ref = (path: string): RecordRef => ({ path, sha256: fileDigest(path) });
/** Recovery projects the same committed state used by read-only consumers. */
export function researchInstrumentState(run: string): ResearchInstrumentState {
  const state = readCommittedResearchState(run);
  const path = join(directory(run), 'state.json');
  if (read<ResearchInstrumentState>(path).revision !== state.revision) save(path, state);
  return state;
}
function commitState(run: string, state: ResearchInstrumentState): void {
  const previousRevision = state.revision++;
  const path = join(directory(run), 'commits', String(state.revision).padStart(16, '0') + '.json');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error('research_commit_already_exists');
  save(path, { previousRevision, state } satisfies ResearchCommit);
  save(join(directory(run), 'state.json'), state);
}
function instrumentIdentity(state: ResearchInstrumentState, run: string): string {
  return digest({ config: state.config, files: inventory(join(directory(run), 'instrument'), state.config.frozen), executable: inventory(join(directory(run), 'executables'), ['command']) });
}
export function captureMeasuredCandidate(project: string, run: string, label: string): CandidateSnapshot {
  const root = directory(run), index = join(root, 'candidates', `${digest(label)}.json`);
  const state = researchInstrumentState(run);
  if (existsSync(index)) return read<CandidateSnapshot>(index);
  const sha256 = digest(inventory(project, state.config.candidate));
  const path = join(root, 'candidates', digest([label, sha256]));
  mkdirSync(dirname(index), { recursive: true });
  if (!existsSync(path)) {
    const pending = `${path}.pending`;
    rmSync(pending, { recursive: true, force: true });
    if (snapshot(project, pending, state.config.candidate) !== sha256) throw new Error('candidate changed during capture');
    renameSync(pending, path);
  }
  const candidate = { path, sha256, label }; save(index, candidate); return candidate;
}
// Landlock is inherited across exec/fork and cannot be relaxed by candidate code.
// Use the system Python only as a syscall bridge; -I/-B exclude authored imports
// and bytecode writes. No evaluator runs unless confinement is installed.
const confinedMeasurement = `
import ctypes, os, platform, shutil, signal, subprocess, sys
if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
    raise RuntimeError('measurement requires Linux Landlock on x86_64/aarch64')
libc = ctypes.CDLL(None, use_errno=True)
def checked(value):
    if value < 0:
        raise OSError(ctypes.get_errno(), 'measurement write confinement unavailable')
    return value
abi = checked(libc.syscall(444, 0, 0, 1))
if abi < 3:
    raise RuntimeError('measurement requires Landlock ABI >= 3 (truncate protection)')
# WRITE_FILE, REMOVE_*, MAKE_*, REFER and TRUNCATE; reads/exec stay available.
writes = (1 << 1) | sum(1 << n for n in range(4, 15))
if abi >= 5:
    writes |= 1 << 15 # IOCTL_DEV
class Ruleset(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64)]
class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int)]
rules = Ruleset(writes)
fd = checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
for path in set((os.environ['HOME'], os.environ['TMPDIR'], '/dev/null')):
    parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
    allowed = writes if os.path.isdir(path) else (1 << 1) | (1 << 14)
    rule = Beneath(allowed, parent)
    checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
    os.close(parent)
checked(libc.prctl(38, 1, 0, 0, 0)) # PR_SET_NO_NEW_PRIVS
checked(libc.syscall(446, fd, 0))
os.close(fd)
# Popen's close-on-exec error pipe distinguishes exec failure from command exit.
# Buffer command stdout until success is acknowledged; no output can forge it.
try:
    child = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE)
except OSError:
    os.write(1, bytes([1]))
    raise
os.write(1, bytes([0]))
shutil.copyfileobj(child.stdout, sys.stdout.buffer)
sys.stdout.buffer.flush()
code = child.wait()
if code < 0:
    try:
        signal.signal(-code, signal.SIG_DFL)
    except (OSError, ValueError): # SIGKILL cannot have a handler.
        pass
    os.kill(os.getpid(), -code)
sys.exit(code)
`;

// Landlock does not mediate chmod/chown/utime. Kernel change stamps also refuse
// temporary metadata edits, including edits restored before the final digest.
function inputChanges(root: string, paths: string[]): string {
  const entries = inventory(root, paths, true);
  for (const path of Object.keys(entries)) for (let p = dirname(path); p !== '.'; p = dirname(p)) {
    const s = lstatSync(join(root, p), { bigint: true });
    entries[p] = `${s.dev}:${s.ino}:${s.ctimeNs}`;
  }
  return digest(entries);
}

export function restoreResearchBest(project: string, run: string): void {
  const state = researchInstrumentState(run);
  const paths = state.config.candidate;
  if (!state.incumbent.sha256) return;
  if (digest(inventory(state.incumbent.path, paths)) !== state.incumbent.sha256) throw new Error('best candidate fingerprint mismatch');
  // Validate EVERY destination before the first mutation. Never follow a
  // candidate-installed ancestor alias, even when it points inside the project.
  if (!lstatSync(project).isDirectory()) throw new Error('unsafe research restore root');
  for (const path of paths) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    try {
      if (!lstatSync(join(project, parent)).isDirectory()) throw new Error('unsafe research restore ancestor');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const path of paths) rmSync(join(project, path), { recursive: true, force: true });
  snapshot(state.incumbent.path, project, paths);
}

const MAX_OUTPUT = 4 * 1024 * 1024;
async function execute(state: ResearchInstrumentState, run: string, request: ResearchRequest, requestRef: RecordRef,
  invocation: string): Promise<{ receipt: ExecutionReceipt; response?: ResearchResponse; artifacts: RecordRef[] }> {
  const root = directory(run), scratch = createInvocationScratch();
  const start = Date.now();
  let receipt: ExecutionReceipt = { started: false, exitCode: null, stdout: '', stderr: '', duration_ms: 0 };
  const artifacts: RecordRef[] = [];
  try {
    const candidate = request.candidate;
    const assertInputs = () => {
      verifyRef(requestRef);
      if (instrumentIdentity(state, run) !== state.instrument.fingerprint) throw new Error('instrument_fingerprint_mismatch');
      if (digest(inventory(state.projectDir, state.config.frozen)) !== digest(state.instrument.files)) throw new Error('frozen_source_fingerprint_mismatch');
      if (digest(inventory(candidate.path, state.config.candidate)) !== candidate.sha256) throw new Error('candidate_fingerprint_mismatch');
      if (digest(inventory(state.projectDir, state.config.candidate)) !== candidate.sha256) throw new Error('candidate_source_fingerprint_mismatch');
    };
    const signal = runProcessAbortSignal();
    if (signal?.aborted || read<{ status?: string }>(join(run, 'run.json')).status === RUN_STATUS.CANCELLED) throw new Error('research_cancelled');
    const deadline = Math.min(state.deadline ?? Infinity,
      state.config.budget.invocation_seconds === undefined ? Infinity : start + state.config.budget.invocation_seconds * 1000);
    if (deadline <= Date.now()) throw new Error('research_wall_budget_exhausted');
    assertInputs();
    const changes = () => digest([
      inputChanges(join(root, 'instrument'), state.config.frozen), inputChanges(join(root, 'executables'), ['command']),
      inputChanges(candidate.path, state.config.candidate),
      inputChanges(state.projectDir, [...state.config.frozen, ...state.config.candidate]),
      inputChanges(dirname(requestRef.path), [basename(requestRef.path)]),
    ]);
    const before = changes();
    receipt = await withEngineIntegrity({ projectDir: state.projectDir, runDir: run, stageId: '_research_instrument' }, () => new Promise<ExecutionReceipt>(resolveReceipt => {
      const env = { ...state.config.environment, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: scratch.path,
        TMPDIR: scratch.path, TMP: scratch.path, TEMP: scratch.path };
      const { child, stop } = spawnOwnedCommand('/usr/bin/python3', ['-I', '-B', '-c', confinedMeasurement,
        join(root, 'executables', 'command'), ...state.config.argv.slice(1), requestRef.path], { cwd: join(root, 'instrument'), env });
      let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), reason: string | undefined;
      const cancel = () => { reason = 'research_cancelled'; stop(); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const cancelDeadline = scheduleDeadline(() => { reason = 'instrument_timeout'; stop(); }, () => deadline - Date.now());
      const collect = (previous: Buffer, data: Buffer): Buffer => {
        if (previous.length + data.length > MAX_OUTPUT) { reason = 'instrument_output_limit'; stop(); }
        return Buffer.concat([previous, data.subarray(0, MAX_OUTPUT - previous.length)]);
      };
      child.stdout?.on('data', data => { stdout = collect(stdout, Buffer.from(data)); });
      child.stderr?.on('data', data => { stderr = collect(stderr, Buffer.from(data)); });
      child.on('error', error => { reason = String(error); });
      child.on('close', (exitCode, processSignal) => {
        cancelDeadline(); signal?.removeEventListener('abort', cancel);
        const started = stdout[0] === 0;
        if (!started) reason ??= stdout[0] === 1 ? 'instrument_executable_start_failed' : 'instrument_write_confinement_unavailable';
        const output = started ? stdout.subarray(1) : stdout;
        if (!isUtf8(output)) reason ??= 'instrument_stdout_invalid_utf8';
        receipt = { started, exitCode, signal: processSignal, stdout: output.toString('utf8'),
          ...(!isUtf8(output) ? { stdout_base64: output.toString('base64') } : {}),
          ...(!isUtf8(stderr) ? { stderr_base64: stderr.toString('base64') } : {}),
          stderr: stderr.toString('utf8'), reason, duration_ms: Date.now() - start };
        resolveReceipt(receipt);
      });
    }));
    if (before !== changes()) receipt.reason = 'instrument_input_changed_during_execution';
    assertInputs();
    if (signal?.aborted) receipt.reason = 'research_cancelled';
    if (receipt.reason || !receipt.started || receipt.exitCode !== 0) return { receipt, artifacts };
    const response = validateResearchResponse(JSON.parse(receipt.stdout), request);
    const exact = parseResearchJSON(receipt.stdout) as ResearchResponse;
    Object.assign(response, { observations: exact.observations, diagnostics: exact.diagnostics, next_state: exact.next_state,
      ...(exact.stop ? { stop: exact.stop } : {}) });
    // Artifact paths are relative to the invocation scratch. Retain regular,
    // digest-bound files before retiring scratch; the envelope is kept verbatim.
    for (const artifact of response.artifacts) {
      inventory(scratch.path, [artifact.path]);
      const source = join(scratch.path, artifact.path);
      if (!lstatSync(source).isFile() || fileDigest(source) !== artifact.sha256) throw new Error('instrument_artifact_digest_mismatch');
      const target = join(invocation, 'artifacts', artifact.path);
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
      if (fileDigest(target) !== artifact.sha256) throw new Error('instrument_artifact_changed_during_capture');
      artifacts.push(ref(target));
    }
    return { receipt, response, artifacts };
  } catch (error) { receipt.reason = String(error); return { receipt, artifacts }; }
  finally { receipt.duration_ms = Date.now() - start; scratch.cleanup(); }
}

export async function initializeResearchInstrument(project: string, run: string, config: ResearchConfig, startedAt = new Date().toISOString()): Promise<ResearchInstrumentState> {
  assertSeparatedRunLayout(run);
  const root = directory(run), statePath = join(root, 'state.json');
  if (!existsSync(statePath)) {
    config = ResearchInstrumentSchema.parse(config);
    mkdirSync(root, { recursive: true });
    const marker = join(root, 'initializing.json');
    if (existsSync(marker)) throw new Error('interrupted research freeze; initial identity is uncertain');
    save(marker, { protocol: RESEARCH_PROTOCOL, config });
    const path = join(root, 'baseline');
    const sha256 = snapshot(project, path, config.candidate);
    snapshot(project, join(root, 'instrument'), config.frozen);
    mkdirSync(join(root, 'executables'), { recursive: true });
    const executable = join(root, 'executables', 'command');
    // A missing executable is retained as an execution error by invoke below.
    let executableError: string | undefined;
    try { copyFileSync(realpathSync(config.argv[0]), executable); } catch (error) { executableError = String(error); }
    const state: ResearchInstrumentState = {
      protocol: RESEARCH_PROTOCOL, runId: read<{ runId?: string }>(join(run, 'run.json')).runId ?? basename(run),
      projectDir: project, config, revision: 0, startedAt,
      deadline: config.budget.wall_seconds === undefined ? null : Date.parse(startedAt) + config.budget.wall_seconds * 1000,
      instrument: { files: inventory(join(root, 'instrument'), config.frozen), fingerprint: '' },
      initial: { path, sha256, label: 'baseline' }, incumbent: { path, sha256, label: 'baseline' }, history: [], instrumentState: null,
    };
    if (executableError) state.error = executableError;
    state.instrument.fingerprint = executableError ? digest({ config, files: state.instrument.files, executableError }) : instrumentIdentity(state, run);
    save(statePath, state);
  }
  const state = researchInstrumentState(run);
  if (digest(ResearchInstrumentSchema.parse(config)) !== digest(state.config)) throw new Error('frozen_instrument_declaration_mismatch');
  await invokeResearchInstrument(run, 'initialize', state.initial, 0);
  return researchInstrumentState(run);
}

/** The request's immutable reservation is written before launch. An interrupted
 * reservation is conservative uncertainty, never permission to repeat a spend. */
export async function invokeResearchInstrument(run: string, phase: ResearchPhase, candidate: CandidateSnapshot, round: number,
  author?: unknown, review?: ResearchOutcome['review'], engineStopReason?: string): Promise<ResearchOutcome> {
  const state = researchInstrumentState(run);
  const prior = state.history.find(h => h.phase === phase && h.round === round);
  if (prior) return prior;
  if (state.termination && phase !== 'finalize') throw new Error('research_already_finalizing');
  const root = directory(run), invocation = join(root, 'invocations', `${phase}-${round}`);
  mkdirSync(invocation, { recursive: true });
  const requestPath = join(invocation, 'request.json');
  let request: ResearchRequest, requestRef: RecordRef;
  let receipt: ExecutionReceipt, response: ResearchResponse | undefined, artifacts: RecordRef[] = [];
  if (existsSync(requestPath)) {
    request = read<ResearchRequest>(requestPath); requestRef = ref(requestPath);
    receipt = { started: null, exitCode: null, stdout: '', stderr: '', reason: 'instrument_invocation_uncertain', duration_ms: 0 };
    // Preserve the raw receipt if it was published before the interrupted commit.
    if (existsSync(join(invocation, 'raw.json'))) receipt = { ...read<ExecutionReceipt>(join(invocation, 'raw.json')), reason: 'instrument_invocation_uncertain' };
  } else {
    request = { protocol: RESEARCH_PROTOCOL, run_id: state.runId, invocation_id: randomUUID(), phase, round,
      instrument_sha256: state.instrument.fingerprint, instrument_path: join(root, 'instrument'),
      candidate, initial: state.initial, incumbent: state.incumbent, history: state.history, previous_state: state.instrumentState,
      remaining_budget: { rounds: Math.max(0, state.config.budget.max_rounds - state.history.filter(h => h.phase !== 'initialize' && h.phase !== 'finalize').length),
        wall_ms: state.deadline === null ? null : Math.max(0, state.deadline - Date.now()),
        invocation_ms: state.config.budget.invocation_seconds === undefined ? null : state.config.budget.invocation_seconds * 1000 },
      ...(engineStopReason === undefined ? {} : { engine_stop_reason: engineStopReason }) };
    save(requestPath, request); requestRef = ref(requestPath);
    if (state.error && phase !== 'finalize' || phase === 'evaluate' && request.remaining_budget.rounds === 0) receipt = {
      started: false, exitCode: null, stdout: '', stderr: '', reason: state.error ?? 'research_round_budget_exhausted', duration_ms: 0,
    };
    else ({ receipt, response, artifacts } = await execute(state, run, request, requestRef, invocation));
  }
  const rawPath = join(invocation, 'raw.json');
  // Raw process evidence is immutable, even if settlement was interrupted.
  if (!existsSync(rawPath)) save(rawPath, receipt);
  return withRunStateLock(run, () => {
    // Use the existing native cancellation lock as the settlement fence. A
    // process response cannot acquire verdict authority after cancellation.
    if (read<{ status?: string }>(join(run, 'run.json')).status === RUN_STATUS.CANCELLED && phase !== 'finalize') receipt.reason = 'research_cancelled';
    const error = receipt.reason ?? (!receipt.started || receipt.exitCode !== 0 ? `instrument_exit_${receipt.exitCode}` : undefined);
    const outcome: ResearchOutcome['outcome'] = error || !response ? 'execution_error' : response.status === 'unavailable' ? 'unavailable'
      : phase === 'finalize' ? 'finalized' : response.verdict!;
    const reason = error ?? response?.reason ?? 'instrument_response_unavailable';
    const prepared = join(invocation, 'result.json');
    const resultPath = existsSync(prepared) ? join(invocation, 'uncertain.json') : prepared;
    if (!existsSync(resultPath)) save(resultPath, { request: requestRef, candidate: request.candidate, outcome, reason, response, artifacts, author, review, ...(resultPath !== prepared ? { unsettled_result: ref(prepared) } : {}) });
    const result: ResearchOutcome = { round, phase, candidate: request.candidate, outcome, reason, request: requestRef,
      raw: ref(rawPath), result: ref(resultPath), ...(response ? { response } : {}), ...(author === undefined ? {} : { author }), ...(review ? { review } : {}) };
    state.history.push(result);
    if (response && !error) {
      state.instrumentState = response.next_state;
      if (response.verdict === 'keep' || response.verdict === 'baseline') state.incumbent = request.candidate;
      if (response.stop) state.stop = response.stop;
    }
    if (outcome === 'execution_error' && phase !== 'finalize') state.error = reason;
    commitState(run, state);
    return result;
  });
}

/** Non-invoked submissions consume round budget without inventing observations. */
export function recordResearchSubmission(run: string, candidate: CandidateSnapshot, round: number,
  outcome: 'no_candidate' | 'review_rejected', author?: unknown, review?: ResearchOutcome['review']): ResearchOutcome {
  const state = researchInstrumentState(run);
  const prior = state.history.find(h => h.round === round && h.phase !== 'initialize' && h.phase !== 'finalize');
  if (prior) return prior;
  const reason = outcome === 'no_candidate' ? 'Candidate content equals the incumbent' : review?.reason ?? 'Project review rejected candidate';
  const path = join(directory(run), 'submissions', `${round}.json`);
  mkdirSync(dirname(path), { recursive: true });
  save(path, { candidate, round, outcome, reason, author, review });
  const entry: ResearchOutcome = { candidate, round, outcome, reason, result: ref(path), author, review };
  state.history.push(entry); commitState(run, state); return entry;
}

export type ResearchConclusion = { status: import('./store.js').StoreState['status']; reasonCode: NonNullable<import('./store.js').StoreState['reasonCode']>; detail?: string };
export interface ResearchManifest {
  protocol: typeof RESEARCH_PROTOCOL; run_id: string; engine_stop_reason: string;
  initial: CandidateSnapshot; incumbent: CandidateSnapshot; instrument_sha256: string;
  history: ResearchOutcome[]; finalizer?: ResearchOutcome; report?: RecordRef; finalization_error?: string; conclusion?: ResearchConclusion;
  restoration_skipped?: 'project_ownership_changed_or_unknown';
}
/** Run-local only. The terminal publisher owns optional project delivery; neither
 * recovery nor this finalizer writes project report files. */
export async function finalizeResearchInstrument(run: string, engineStopReason: string, conclusion?: ResearchConclusion): Promise<ResearchManifest> {
  const manifestPath = runRecordPath(run, 'research_manifest.json');
  if (existsSync(manifestPath)) return reconcileResearchManifest(run, read(join(run, 'run.json')))!;
  const cancelled = conclusion?.status === RUN_STATUS.CANCELLED || read<{ status?: string }>(join(run, 'run.json')).status === RUN_STATUS.CANCELLED;
  let state = researchInstrumentState(run);
  // The existing commit journal replaces the volatile finish closure. A crash
  // after finalizer settlement cannot authorize another author or change why
  // this loop ended, even before the terminal run.json publication.
  if (!state.termination) { state.termination = { reason: engineStopReason, conclusion }; commitState(run, state); }
  engineStopReason = state.termination.reason;
  conclusion = state.termination.conclusion;
  let restorationSkipped: ResearchManifest['restoration_skipped'];
  try {
    if (cancelled) {
      if (!withProjectWriteOwnership(state.projectDir, run, () => restoreResearchBest(state.projectDir, run))) restorationSkipped = 'project_ownership_changed_or_unknown';
    } else restoreResearchBest(state.projectDir, run);
  }
  catch (error) {
    const manifest: ResearchManifest = { protocol: RESEARCH_PROTOCOL, run_id: state.runId, engine_stop_reason: engineStopReason,
      initial: state.initial, incumbent: state.incumbent, instrument_sha256: state.instrument.fingerprint,
      history: state.history, finalization_error: String(error),
      conclusion: conclusion ? { status: RUN_STATUS.FAILED, reasonCode: 'stage_failed', detail: String(error) } : undefined };
    save(manifestPath, manifest); return reconcileResearchManifest(run, read(join(run, 'run.json')))!;
  }
  const finalizer = await invokeResearchInstrument(run, 'finalize', state.incumbent,
    state.history.filter(h => h.phase !== 'initialize' && h.phase !== 'finalize').length, undefined, undefined, engineStopReason);
  state = researchInstrumentState(run);
  const manifest: ResearchManifest = { protocol: RESEARCH_PROTOCOL, run_id: state.runId, engine_stop_reason: engineStopReason,
    initial: state.initial, incumbent: state.incumbent, instrument_sha256: state.instrument.fingerprint, history: state.history, finalizer, conclusion,
    ...(restorationSkipped ? { restoration_skipped: restorationSkipped } : {}) };
  if (finalizer.outcome === 'finalized' && finalizer.response?.report) {
    const path = runRecordPath(run, 'research_report.md');
    atomicWrite(path, finalizer.response.report.content); manifest.report = ref(path);
  }
  save(manifestPath, manifest); return reconcileResearchManifest(run, read(join(run, 'run.json')))!;
}

/** Native cancellation owns control even if it wins between finalizer and
 * terminal publication. Reconciliation touches only the run-local manifest;
 * it replaces report re-projection/status rewriting, never project delivery. */
export function reconcileResearchManifest(run: string, control: Pick<import('./store.js').StoreState, 'status' | 'failureReason'>): ResearchManifest | undefined {
  const path = runRecordPath(run, 'research_manifest.json');
  if (!existsSync(path)) return undefined;
  const manifest = read<ResearchManifest>(path);
  if (control.status === RUN_STATUS.CANCELLED && manifest.conclusion?.status !== RUN_STATUS.CANCELLED) {
    manifest.engine_stop_reason = 'cancelled';
    manifest.conclusion = { status: RUN_STATUS.CANCELLED, reasonCode: 'cancelled', detail: control.failureReason };
    save(path, manifest);
  }
  return manifest;
}

/** Terminal publisher. A durable finalizer and publication attempt precede the
 * project write; current-tree validation is projected before terminal commit.
 * Uncertain delivery is never retried by recovery or land. */
export function writeResearchTerminalReport(state: import('./store.js').StoreState): void {
  const run = runDirForStateLookup(state.projectDir, state.runId);
  const path = runRecordPath(run, 'research_publication.json');
  if (!isTerminalRunStatus(state.status) || state.research?.protocol !== RESEARCH_PROTOCOL || !state.research.publication || existsSync(path)) return;
  const manifestPath = runRecordPath(run, 'research_manifest.json');
  if (!existsSync(manifestPath)) return;
  const manifest = read<ResearchManifest>(manifestPath);
  const intent = { protocol: RESEARCH_PROTOCOL, run_id: state.runId, publication_id: randomUUID(),
    attempted_at: new Date().toISOString(), destination: state.research.publication, report: manifest.report };
  if (!atomicWrite(path, JSON.stringify({ ...intent, status: 'started' }) + '\n', { exclusive: true })) return;
  try {
    if (!manifest.report) throw new Error('Project finalizer supplied no report');
    verifyRef(manifest.report);
    const destination = resolveArtifactLocation({ root: 'project', path: state.research.publication }, state.projectDir, run);
    const physical = prospectivePhysicalPath(destination);
    for (const root of [...state.research.candidate, ...state.research.frozen]) {
      const input = prospectivePhysicalPath(resolve(state.projectDir, root));
      if (artifactRootContains(input, physical) || artifactRootContains(physical, input)) throw new Error('publication overlaps instrument inputs');
    }
    mkdirSync(dirname(destination), { recursive: true });
    atomicWrite(destination, readFileSync(manifest.report.path, 'utf8'));
    save(path, { ...intent, status: 'published' });
  } catch (error) { save(path, { ...intent, status: 'failed', error: String(error) }); }
}

/** Author context is the same lossless committed history given to the next
 * instrument, rather than an engine-selected projection of observations. */
export function researchAuthorContext(run: string) {
  const state = researchInstrumentState(run);
  return { protocol: state.protocol, incumbent: state.incumbent, initial: state.initial,
    history: state.history, previous_state: state.instrumentState,
    remaining_budget: { rounds: Math.max(0, state.config.budget.max_rounds - state.history.filter(h => h.phase !== 'initialize' && h.phase !== 'finalize').length),
      wall_ms: state.deadline === null ? null : Math.max(0, state.deadline - Date.now()) } };
}
/** Detect temporary metadata edits as well as byte edits during authoring. */
export function researchFrozenStamp(run: string): string {
  const state = researchInstrumentState(run);
  return digest(inventory(state.projectDir, state.config.frozen, true));
}
