import { prospectivePhysicalPath } from './engine-owned-carriers.js';
import { runDir, type StoreState } from './store.js';
import { ArtifactPathSchema, artifactRootContains, resolveArtifactLocation } from './artifact-location.js';
import { runRecordPath } from './run-layout.js';
import { updateFileHashSync } from './rollback-content-store.js';
import { createInvocationScratch } from './invocation-scratch.js';
import { withEngineIntegrity } from './engine-integrity.js';
/** Engine-owned research instrument, observations and paired numeric selection. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWrite, chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from './engine-fs.js';
import { spawnOwnedCommand } from './adapters/base.js';
import { scheduleDeadline } from './attempt-deadline.js';
import { normalizedProjectContentPath } from './scheduler/sched_admission/scope-services.js';

const localPath = ArtifactPathSchema.refine(p => normalizedProjectContentPath(p) === p && !p.startsWith('.fc'), 'use a normalized literal project-relative root without surrounding whitespace');
const command = z.object({ command: z.string().min(1).refine(isAbsolute, 'command must be an absolute executable'), args: z.array(z.string()).default([]) }).strict();
const condition = z.union([
  z.object({ exit_code: z.number().int() }).strict(),
  z.object({ field: z.string().min(1), equals: z.union([z.string(), z.number().finite(), z.boolean()]) }).strict(),
]);
const metric = z.object({ direction: z.enum(['min', 'max']), scale: z.enum(['fraction', 'count']) }).strict();
export const ResearchMeasurementSchema = z.object({
  frozen: z.array(localPath).min(1), candidate: z.array(localPath).min(1),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  replicates: z.number().int().min(2),
  metrics: z.record(z.string().min(1), metric), primary: z.array(z.string().min(1)).min(1),
  development: command,
  guards: z.array(command.extend({ name: z.string().min(1), pass: condition }).strict()).default([]),
  held_out: command.extend({ allowance: z.number().int().nonnegative(), pass: condition }).strict().optional(),
  timeout_seconds: z.number().positive().default(300),
}).strict().superRefine((v, ctx) => {
  if (v.primary.some(m => !v.metrics[m])) ctx.addIssue({ code: 'custom', message: 'primary metrics must be declared' });
  if (new Set(v.guards.map(g => g.name)).size !== v.guards.length) ctx.addIssue({ code: 'custom', message: 'guard names must be unique' });
  if (Object.keys(v.environment).some(k => k.startsWith('FC_RESEARCH_') || ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'PATH', 'LANG', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH'].includes(k))) ctx.addIssue({ code: 'custom', message: 'reserved measurement environment variable' });
  const paths = [...v.frozen, ...v.candidate];
  if (paths.some((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(q + '/') || q.startsWith(p + '/'))))) ctx.addIssue({ code: 'custom', message: 'frozen and candidate roots must be disjoint and non-overlapping' });
});
export type ResearchMeasurement = z.infer<typeof ResearchMeasurementSchema>;
export type Metric = z.infer<typeof metric>;
export interface Item { id: string; metrics: Record<string, number> }
export interface Observation {
  status: 'measured' | 'unmeasured'; fingerprint: string; candidate: string;
  items?: Item[]; reason?: string; detail?: string;
}
export interface GuardObservation {
  passes: boolean; reason?: string; detail?: string; name?: string; baseline?: number; candidate?: number;
  /** Optional independently collected guard identity, checked before its status. */
  fingerprint?: string; expectedFingerprint?: string;
}
/** A structured numeric guard shared by declared numeric conditions and replay. */
export function numericResearchGuard(baseline: unknown, candidate: unknown): GuardObservation {
  if (typeof baseline !== 'number' || !Number.isFinite(baseline) || typeof candidate !== 'number' || !Number.isFinite(candidate)) return { passes: false, reason: 'guard_error', detail: 'finite numeric guard values required' };
  return { baseline, candidate, passes: candidate >= baseline };
}
export interface Calibration { fingerprint: string; items: string[]; metrics: Record<string, number> }
export interface Comparison {
  keep: boolean; reason: string;
  metrics: Record<string, { baseline: number; candidate: number; improvement: number; noise: number; threshold: number; improved: boolean }>;
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fileDigest = (path: string): string => { const hash = createHash('sha256'); updateFileHashSync(path, hash); return hash.digest('hex'); };
const sum = (items: Item[], name: string): number => items.reduce((n, i) => n + i.metrics[name], 0);

function paired(base: Observation, candidate: Observation, metrics: Record<string, Metric>): boolean {
  if (base.status !== 'measured' || candidate.status !== 'measured' || !base.fingerprint || base.fingerprint !== candidate.fingerprint) return false;
  const ids = (o: Observation) => o.items?.map(i => i.id).sort();
  const left = ids(base), right = ids(candidate);
  return !!left?.length && new Set(left).size === left.length && !!right && new Set(right).size === right.length
    && JSON.stringify(left) === JSON.stringify(right)
    && [base, candidate].every(o => Object.keys(metrics).every(m => finite(sum(o.items!, m))) && o.items!.every(i => typeof i.id === 'string' && i.id.length > 0 && Object.keys(metrics).every(m => finite(i.metrics[m]))));
}

// Raw count observations are integral; a mean baseline need not be.
const rawCounts = (observation: Observation, metrics: Record<string, Metric>): boolean => observation.items?.every(item =>
  Object.entries(metrics).every(([name, metric]) => metric.scale !== 'count' || Number.isInteger(item.metrics[name]))) ?? false;

// Compare decimal observations exactly at a strict boundary, like the POC's
// Fraction(str(number)). IEEE subtraction can make 1.1 -> .99 exceed 10%.
function decimal(value: number): { n: bigint; d: bigint } {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const n = BigInt(whole + fraction);
  return scale >= 0 ? { n, d: 10n ** BigInt(scale) } : { n: n * 10n ** BigInt(-scale), d: 1n };
}
function exactTotal(items: Item[], name: string): { n: bigint; d: bigint } {
  return items.reduce((sum, item) => {
    const value = decimal(item.metrics[name]);
    const d = sum.d > value.d ? sum.d : value.d;
    return { n: sum.n * (d / sum.d) + value.n * (d / value.d), d };
  }, { n: 0n, d: 1n });
}
function clearsNoise(base: Item[], candidate: Item[], name: string, metric: Metric, noise: number): boolean {
  const a = exactTotal(base, name), b = exactTotal(candidate, name), sigma = decimal(noise);
  const delta = (metric.direction === 'min' ? 1n : -1n) * (a.n * b.d - b.n * a.d);
  const denominator = metric.scale === 'fraction' ? b.d * a.n : a.d * b.d;
  return delta * sigma.d > 2n * sigma.n * denominator;
}

/** Shared production rule: structured instrument/item identity, guards, strict > 2 sigma. */
export function decideResearchComparison(base: Observation, candidate: Observation, metrics: Record<string, Metric>, primary: string[], calibration: Calibration, guards: GuardObservation[]): Comparison {
  const result: Comparison = { keep: false, reason: 'input_invalid', metrics: {} };
  const noise = calibration.metrics;
  if (calibration.fingerprint !== base.fingerprint || JSON.stringify([...calibration.items].sort()) !== JSON.stringify(base.items?.map(i => i.id).sort()) || !paired(base, candidate, metrics) || !rawCounts(candidate, metrics) || !primary.length || primary.some(m => !metrics[m]) || Object.keys(metrics).some(m => !finite(noise[m]))) return result;
  if (guards.some(g => g.fingerprint !== undefined && g.fingerprint !== g.expectedFingerprint)) return { ...result, reason: 'guard_fingerprint_mismatch' };
  const failure = guards.find(g => !g.passes && g.reason);
  if (failure) return { ...result, reason: failure.reason! };
  for (const [name, metric] of Object.entries(metrics)) {
    const a = sum(base.items!, name), b = sum(candidate.items!, name);
    if (metric.scale === 'fraction' && a <= 0) return { keep: false, reason: 'input_invalid', metrics: {} };
    const delta = metric.direction === 'min' ? a - b : b - a;
    const improvement = metric.scale === 'fraction' ? delta / a : delta;
    result.metrics[name] = { baseline: a, candidate: b, improvement, noise: noise[name], threshold: 2 * noise[name], improved: clearsNoise(base.items!, candidate.items!, name, metric, noise[name]) };
  }
  result.keep = guards.every(g => g.passes) && primary.some(m => result.metrics[m].improved);
  result.reason = result.keep ? 'kept' : guards.some(g => !g.passes) ? 'guard_worse' : 'no_improvement_above_noise';
  return result;
}

/** 4096 seeded cluster resamples: one distinct run pair per resample,
 * then paired items sampled within that pair. Shared run shifts survive.
 * Count noise uses whole-run total differences, floored at one count. */
export function calibrateResearchNoise(replicates: Observation[], metrics: Record<string, Metric>): Record<string, number> {
  const base = replicates[0];
  if (replicates.length < 2 || replicates.some(r => !paired(base, r, metrics) || !rawCounts(r, metrics) || r.candidate !== base.candidate)) throw new Error('calibration requires paired unchanged-baseline observations');
  const rows = [...base.items!].sort((a, b) => a.id.localeCompare(b.id)).map(i => replicates.map(r => r.items!.find(j => j.id === i.id)!));
  const noise: Record<string, number> = {};
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric.scale === 'count') {
      let squaredDifferences = 0, pairs = 0;
      for (let a = 0; a < replicates.length; a++) for (let b = a + 1; b < replicates.length; b++) {
        squaredDifferences += rows.reduce((n, row) => n + row[a].metrics[name] - row[b].metrics[name], 0) ** 2; pairs++;
      }
      noise[name] = Math.sqrt(Math.max(squaredDifferences / pairs, 1));
      continue;
    }
    if (rows.some(row => row.some(item => item.metrics[name] <= 0))) throw new Error('positive baseline items required for fractional calibration');
    let seed = 1108;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const values: number[] = [];
    for (let n = 0; n < 4096; n++) {
      let left = 0, right = 0;
      const a = Math.floor(random() * replicates.length), b = (a + 1 + Math.floor(random() * (replicates.length - 1))) % replicates.length;
      for (let j = 0; j < rows.length; j++) {
        const row = rows[Math.floor(random() * rows.length)];
        left += row[a].metrics[name]; right += row[b].metrics[name];
      }
      values.push(right / left);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    noise[name] = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  }
  if (Object.values(noise).some(value => !finite(value))) throw new Error('finite calibration noise required');
  return noise;
}

/** The incumbent includes every declared replicate, paired by stable item ID. */
export function meanResearchBaseline(replicates: Observation[], metrics: Record<string, Metric>): Observation {
  const base = replicates[0];
  if (!base || replicates.some(r => !paired(base, r, metrics) || !rawCounts(r, metrics) || r.candidate !== base.candidate)) throw new Error('baseline replicates must be paired');
  return { ...base, items: base.items!.map(item => ({ id: item.id, metrics: Object.fromEntries(Object.keys(metrics).map(name =>
    [name, replicates.reduce((sum, r) => sum + r.items!.find(i => i.id === item.id)!.metrics[name], 0) / replicates.length])) })) };
}

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
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const save = (path: string, value: unknown) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
const directory = (run: string) => runRecordPath(run, 'research_measurement');
interface Instrument { unavailable: Record<string, string>; projectDir: string; config: ResearchMeasurement; files: Inventory; executables: Inventory; fingerprint: string }
export interface MeasurementState {
  revision: number; instrument: Instrument; replicates: Observation[]; noise?: Record<string, number>;
  baseline: Observation; best: Observation; bestPath: string; heldOutUses: Array<{ round: string; status: 'started' | 'finished'; passes?: boolean; reason?: string }>;
  error?: string;
  rounds?: import('./research-history.js').ResearchRound[];
}
export interface CandidateSnapshot { path: string; sha256: string; label: string; error?: string }

function instrumentIdentity(instrument: Instrument, root: string): string {
  const executables = Object.fromEntries(Object.entries(instrument.executables).map(([p, expected]) => [p, expected === 'unavailable' ? expected : inventory(join(root, 'executables'), [digest(p)])[digest(p)]]));
  return digest({ config: instrument.config, files: inventory(join(root, 'instrument'), instrument.config.frozen), executables });
}
export function captureMeasuredCandidate(project: string, run: string, label: string, refresh = false): CandidateSnapshot {
  const root = directory(run), index = join(root, 'candidates', `${digest(label)}.json`);
  const state = read<MeasurementState>(join(root, 'state.json'));
  mkdirSync(dirname(index), { recursive: true });
  if (!refresh && existsSync(index)) return read<CandidateSnapshot>(index);
  let path = join(root, 'candidates', digest(label));
  try {
    const sha256 = digest(inventory(project, state.instrument.config.candidate));
    path = join(root, 'candidates', digest([label, sha256]));
    if (!existsSync(path)) {
      const pending = `${path}.pending`;
      rmSync(pending, { recursive: true, force: true });
      if (snapshot(project, pending, state.instrument.config.candidate) !== sha256) throw new Error('candidate changed during capture');
      renameSync(pending, path);
    }
    const captured = { path, sha256, label }; save(index, captured); return captured;
  } catch (error) { const failed = { path, sha256: '', label, error: String(error) }; save(index, failed); return failed; }
}

/** Relocate declared dependencies in argv/environment, including --input=PATH.
 * An absolute authored path must never escape the retained instrument/candidate. */
function bindInput(value: string, instrument: Instrument, root: string, candidate: CandidateSnapshot): string {
  const equal = value.indexOf('=');
  const prefix = value.startsWith('--') && equal >= 0 ? value.slice(0, equal + 1) : '';
  const input = prefix ? value.slice(equal + 1) : value;
  if (!isAbsolute(input)) return value; // Relative inputs already resolve inside the frozen cwd.
  const absolute = resolve(instrument.projectDir, input);
  const local = relative(resolve(instrument.projectDir), absolute);
  for (const [paths, destination] of [[instrument.config.frozen, join(root, 'instrument')], [instrument.config.candidate, candidate.path]] as const) {
    if (paths.some(path => local === path || local.startsWith(path + '/'))) return prefix + join(destination, local);
  }
  if (isAbsolute(input) && !local.startsWith('..') && !isAbsolute(local)) throw new Error('absolute measurement input is not declared frozen or candidate');
  return value;
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

interface Receipt { fingerprint?: string; exitCode: number | null; stdout: string; stderr: string; reason?: string; output?: Record<string, unknown> }
async function execute(instrument: Instrument, run: string, candidate: CandidateSnapshot, spec: z.infer<typeof command>, deadline: number): Promise<Receipt> {
  const root = directory(run), scratch = createInvocationScratch();
  try {
    const environment = Object.fromEntries(Object.entries(instrument.config.environment).map(([key, value]) => [key, bindInput(value, instrument, root, candidate)]));
    const env = { ...environment, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: scratch.path, TMPDIR: scratch.path, TMP: scratch.path, TEMP: scratch.path,
      FC_RESEARCH_CANDIDATE: candidate.path, FC_RESEARCH_CANDIDATE_SHA256: candidate.sha256 };
    const args = spec.args.map(value => bindInput(value, instrument, root, candidate));
    if (deadline <= Date.now()) throw new Error('research_wall_budget_exhausted');
    if (candidate.error) throw new Error(candidate.error);
    if (Object.hasOwn(instrument.unavailable, spec.command)) throw new Error(instrument.unavailable[spec.command]);
    if (instrumentIdentity(instrument, root) !== instrument.fingerprint) throw new Error('instrument_fingerprint_mismatch');
    if (digest(inventory(instrument.projectDir, instrument.config.frozen)) !== digest(instrument.files)) throw new Error('frozen_source_fingerprint_mismatch');
    if (digest(inventory(candidate.path, instrument.config.candidate)) !== candidate.sha256) throw new Error('candidate_fingerprint_mismatch');
    if (digest(inventory(instrument.projectDir, instrument.config.candidate)) !== candidate.sha256) throw new Error('candidate_source_fingerprint_mismatch');
    const changes = () => digest([
      inputChanges(join(root, 'instrument'), instrument.config.frozen),
      inputChanges(join(root, 'executables'), Object.keys(instrument.executables).filter(p => instrument.executables[p] !== 'unavailable').map(digest)),
      inputChanges(candidate.path, instrument.config.candidate),
      inputChanges(instrument.projectDir, [...instrument.config.frozen, ...instrument.config.candidate]),
    ]);
    const before = changes();
    if (deadline <= Date.now()) throw new Error('research_wall_budget_exhausted');
    const result = await withEngineIntegrity({ projectDir: instrument.projectDir, runDir: run, stageId: '_research_measurement' }, () => new Promise<Receipt>(resolveReceipt => {
      const { child, stop } = spawnOwnedCommand('/usr/bin/python3', ['-I', '-B', '-c', confinedMeasurement, join(root, 'executables', digest(spec.command)), ...args], { cwd: join(root, 'instrument'), env });
      let stdout = '', stderr = '', reason: string | undefined;
      const cancelDeadline = scheduleDeadline(() => { reason = 'measurement_timeout'; stop(); }, () => deadline - Date.now());
      child.stdout?.on('data', data => { stdout += String(data); if (stdout.length > 4 * 1024 * 1024) { reason = 'measurement_output_limit'; stop(); } });
      child.stderr?.on('data', data => { if (stderr.length < 8192) stderr += String(data); });
      child.on('error', error => { reason = String(error); });
      child.on('close', exitCode => { cancelDeadline(); resolveReceipt({ exitCode, stdout, stderr, reason }); });
    }));
    if (!result.stdout.startsWith('\0')) result.reason ??= result.stdout.startsWith('\x01') ? 'measurement_executable_start_failed' : 'measurement_write_confinement_unavailable';
    else result.stdout = result.stdout.slice(1);
    if (before !== changes()) result.reason = 'measurement_input_changed_during_execution';
    result.fingerprint = instrumentIdentity(instrument, root);
    if (result.fingerprint !== instrument.fingerprint) result.reason = 'instrument_fingerprint_mismatch';
    if (digest(inventory(instrument.projectDir, instrument.config.frozen)) !== digest(instrument.files)) result.reason = 'frozen_source_fingerprint_mismatch';
    if (digest(inventory(candidate.path, instrument.config.candidate)) !== candidate.sha256) result.reason = 'candidate_fingerprint_mismatch';
    if (digest(inventory(instrument.projectDir, instrument.config.candidate)) !== candidate.sha256) result.reason = 'candidate_source_fingerprint_mismatch';
    try { result.output = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* Exit-code guards need no JSON. */ }
    return result;
  } catch (error) { return { exitCode: null, stdout: '', stderr: '', reason: String(error) }; }
  finally { scratch.cleanup(); }
}
function observe(receipt: Receipt, instrument: Instrument, candidate: CandidateSnapshot): Observation {
  const base = { fingerprint: receipt.fingerprint ?? instrument.fingerprint, candidate: candidate.sha256 };
  const parsed = z.object({ items: z.array(z.object({ id: z.string().min(1), metrics: z.record(z.string(), z.number().finite().nonnegative()) })).min(1) }).safeParse(receipt.output);
  if (receipt.reason || receipt.exitCode !== 0 || !parsed.success) return { ...base, status: 'unmeasured', reason: 'measurement_unavailable', detail: receipt.reason ?? (receipt.exitCode !== 0 ? `exit ${receipt.exitCode}` : 'invalid item output') };
  const observation: Observation = { ...base, status: 'measured', items: parsed.data.items };
  return paired(observation, observation, instrument.config.metrics) && rawCounts(observation, instrument.config.metrics) ? observation : { ...base, status: 'unmeasured', reason: 'input_invalid', detail: 'missing metrics or duplicate item identity' };
}
function passes(receipt: Receipt, pass: z.infer<typeof condition>): GuardObservation {
  if (receipt.reason || receipt.exitCode === null) return { passes: false, reason: 'guard_error', detail: receipt.reason ?? 'command did not produce an exit code' };
  if ('field' in pass && (receipt.exitCode !== 0 || !receipt.output || !Object.hasOwn(receipt.output, pass.field))) return { passes: false, reason: 'guard_error', detail: `exit ${receipt.exitCode}; missing structured field ${pass.field}` };
  if ('field' in pass && typeof pass.equals === 'number') {
    const lower = numericResearchGuard(pass.equals, receipt.output?.[pass.field]);
    return { ...lower, passes: lower.passes && numericResearchGuard(receipt.output?.[pass.field], pass.equals).passes, detail: `exit ${receipt.exitCode}; required ${JSON.stringify(pass)}` };
  }
  return { passes: 'exit_code' in pass ? receipt.exitCode === pass.exit_code : receipt.exitCode === 0 && receipt.output?.[pass.field] === pass.equals, detail: `exit ${receipt.exitCode}; required ${JSON.stringify(pass)}` };
}

/** Before any producer runs. Incomplete initialization is never recalibrated from a candidate. */
export async function initializeResearchMeasurements(project: string, run: string, config: ResearchMeasurement, deadline = Infinity): Promise<MeasurementState> {
  const root = directory(run), statePath = join(root, 'state.json');
  if (existsSync(statePath)) return read<MeasurementState>(statePath);
  mkdirSync(root, { recursive: true });
  const parsed = ResearchMeasurementSchema.parse(config);
  const instrument: Instrument = { unavailable: {}, projectDir: project, config: parsed, files: {}, executables: {}, fingerprint: '' };
  const unavailable: Observation = { status: 'unmeasured', fingerprint: '', candidate: '', reason: 'baseline_unavailable' };
  const state: MeasurementState = { revision: 0, instrument, replicates: [], baseline: unavailable, best: unavailable, bestPath: join(root, 'baseline'), heldOutUses: [] };
  try {
    if (existsSync(join(root, 'initializing.json'))) throw new Error('interrupted research initialization; baseline is unavailable');
    save(join(root, 'initializing.json'), { config });
    const sha256 = snapshot(project, state.bestPath, parsed.candidate);
    unavailable.candidate = sha256;
    snapshot(project, join(root, 'instrument'), parsed.frozen);
    const specs = [parsed.development, ...parsed.guards, ...(parsed.held_out ? [parsed.held_out] : [])];
    mkdirSync(join(root, 'executables'), { recursive: true });
    instrument.executables = Object.fromEntries([...new Set(specs.map(s => s.command))].map(executable => {
      const destination = join(root, 'executables', digest(executable));
      try { copyFileSync(realpathSync(executable), destination); } catch (error) { instrument.unavailable[executable] = String(error); return [executable, 'unavailable']; }
      return [executable, fileDigest(destination)];
    }));
    instrument.files = inventory(join(root, 'instrument'), parsed.frozen);
    instrument.fingerprint = instrumentIdentity(instrument, root);
    const candidate = { path: state.bestPath, sha256, label: 'baseline' };
    for (let n = 0; n < parsed.replicates; n++) {
      const remaining = deadline - Date.now();
      const receipt = await execute(instrument, run, candidate, parsed.development, Math.min(Date.now() + parsed.timeout_seconds * 1000, deadline));
      save(join(root, `calibration-${n + 1}.json`), receipt);
      state.replicates.push(observe(receipt, instrument, candidate));
      if (remaining <= 0) break;
    }
    state.baseline = state.replicates[0];
    state.noise = calibrateResearchNoise(state.replicates, parsed.metrics);
    state.baseline = state.best = meanResearchBaseline(state.replicates, parsed.metrics);
  } catch (error) { state.error = `${String(error)}${state.baseline.detail ? `: ${state.baseline.detail}` : ''}`; state.baseline.detail = state.error; }
  save(statePath, state);
  return state;
}

export interface MeasurementResult { candidate: CandidateSnapshot; observation: Observation; comparison: Comparison; heldOutExhausted: boolean; guards: GuardObservation[] }
export async function measureResearchCandidate(run: string, candidate: CandidateSnapshot, remainingMs = Infinity, submission?: Pick<import('./research-history.js').ResearchRound, 'notes' | 'review' | 'wallHoursCumulative'>): Promise<MeasurementResult> {
  const root = directory(run), statePath = join(root, 'state.json');
  const record = join(root, 'results', digest(candidate.label) + '.json');
  if (existsSync(record)) {
    const committed = read<MeasurementResult & { previousRevision: number; nextState: MeasurementState }>(record);
    const current = read<MeasurementState>(statePath);
    if (current.revision === committed.previousRevision) save(statePath, committed.nextState);
    return committed;
  }
  const state = read<MeasurementState>(statePath), { instrument } = state, config = instrument.config;
  const previousRevision = state.revision;
  const deadline = Date.now() + remainingMs;
  const runCommand = (spec: z.infer<typeof command>) => execute(instrument, run, candidate, spec, Math.min(Date.now() + config.timeout_seconds * 1000, deadline));
  const exhausted = !!config.held_out && state.heldOutUses.length >= config.held_out.allowance;
  const alreadySpent = exhausted || !!config.held_out && state.heldOutUses.some(u => u.round === candidate.label);
  const spentReason = exhausted ? 'held_out_allowance_exhausted' : 'held_out_interrupted';
  const development: Receipt = alreadySpent
    ? { exitCode: null, stdout: '', stderr: '', reason: spentReason }
    : await runCommand(config.development);
  const observation = observe(development, instrument, candidate);
  const guards: GuardObservation[] = [];
  const compare = () => decideResearchComparison(state.best, observation, config.metrics, config.primary, { fingerprint: state.baseline.fingerprint, items: state.baseline.items?.map(i => i.id) ?? [], metrics: state.noise ?? {} }, guards);
  let comparison = state.error ? { keep: false, reason: 'input_invalid', metrics: {} } : compare();
  const receipts: Receipt[] = [];
  if (comparison.keep) {
    for (const guard of config.guards) { const receipt = await runCommand(guard); receipts.push(receipt); guards.push({ ...passes(receipt, guard.pass), name: guard.name }); }
    comparison = compare();
  }
  let heldOutExhausted = exhausted;
  if (alreadySpent) comparison = { ...comparison, keep: false, reason: spentReason };
  if (comparison.keep && config.held_out) {
    const use: MeasurementState['heldOutUses'][number] = { round: candidate.label, status: 'started' };
    state.heldOutUses.push(use); save(statePath, state); // spend BEFORE launch, including crashes/failures
    const receipt = await runCommand(config.held_out); receipts.push(receipt);
    const verdict = passes(receipt, config.held_out.pass); guards.push(verdict);
    Object.assign(use, { status: 'finished', passes: verdict.passes, reason: receipt.reason });
    comparison = compare();
  }
  if (config.held_out && state.heldOutUses.length >= config.held_out.allowance) heldOutExhausted = true;
  if (comparison.keep) { state.best = observation; state.bestPath = candidate.path; }
  if (submission) state.rounds = [...(state.rounds ?? []), {
    ...submission, label: candidate.label, candidate: candidate.sha256, outcome: observation.status,
    measurement: observation, comparison, guards, reason: comparison.reason,
    ...(observation.items ? { result: sum(observation.items, config.primary[0]) } : {}),
  }];
  state.revision++;
  const result = { candidate, observation, comparison, heldOutExhausted, guards, development, receipts, previousRevision, nextState: state };
  mkdirSync(dirname(record), { recursive: true });
  // Result precedes best projection. Recovery reapplies a committed result idempotently.
  save(record, result); save(statePath, state);
  return result;
}

export function restoreResearchBest(project: string, run: string): void {
  const state = read<MeasurementState>(join(directory(run), 'state.json'));
  const paths = state.instrument.config.candidate;
  if (!state.best.candidate) return;
  if (digest(inventory(state.bestPath, paths)) !== state.best.candidate) throw new Error('best candidate fingerprint mismatch');
  // Validate EVERY destination before the first mutation. Never follow a
  // candidate-installed ancestor alias, even when it points inside the project.
  if (!lstatSync(project).isDirectory()) throw new Error('unsafe research restore root');
  for (const path of paths) for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    try {
      if (!lstatSync(join(project, parent)).isDirectory()) throw new Error('unsafe research restore ancestor');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const path of paths) rmSync(join(project, path), { recursive: true, force: true });
  snapshot(state.bestPath, project, paths);
}
export function researchMeasurementState(run: string): MeasurementState { return read(join(directory(run), 'state.json')); }

/** Sole report author. Called after the terminal commit under its run-state lock.
 * Committed destinations survive publication errors and pointer-save failures. */
export function writeResearchTerminalReport(state: StoreState, superseded: ReadonlySet<string> = new Set()): string[] {
  const directory = runDir(state.projectDir, state.runId);
  let measured: ReturnType<typeof researchMeasurementState> | undefined;
  try { measured = researchMeasurementState(directory); } catch { /* initialization may have failed */ }
  const journal = measured ? { baseline: measured.baseline, replicates: measured.replicates, noise: measured.noise,
    fingerprint: measured.instrument.fingerprint, best: measured.best, heldOutUses: measured.heldOutUses, error: measured.error } : { error: 'Measurement not initialized' };
  const rounds = measured?.rounds ?? [];
  const body = `# Research report\n\nStatus: ${state.status}\nReason: ${state.failureReason ?? state.reasonCode ?? 'unknown'}\n\n## Engine measurement journal\n\n\`\`\`json\n${JSON.stringify(journal, null, 2)}\n\`\`\`\n\n`
    + rounds.map(round => { const { notes, ...engine } = round; return `## ${round.label}\n\n### Engine decision\n\n\`\`\`json\n${JSON.stringify(engine, null, 2)}\n\`\`\`\n\n### Producer notes (advisory; no numeric authority)\n\n\`\`\`json\n${JSON.stringify(notes ?? { unavailable: true }, null, 2)}\n\`\`\`\n`; }).join('\n');
  const publish = (path: string): void => {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== body) atomicWrite(path, body);
  };
  publish(runRecordPath(directory, 'research_report.md'));
  const desired = new Set(state.terminalStates?.[state.status]?.paths ?? []);
  const paths = new Set([...(state.researchReportPaths ?? []), ...desired]);
  const errors: string[] = [];
  delete state.terminalArtifact;
  for (const path of paths) try {
    if (superseded.has(path)) continue;
    const absolute = resolveArtifactLocation({ root: 'project', path }, state.projectDir, directory);
    const destination = prospectivePhysicalPath(absolute);
    for (const root of [...(state.research?.measurement.frozen ?? []), ...(state.research?.measurement.candidate ?? [])]) {
      const input = prospectivePhysicalPath(resolve(state.projectDir, root));
      if (artifactRootContains(input, destination) || artifactRootContains(destination, input)) throw new Error('terminal report overlaps measurement inputs');
    }
    mkdirSync(dirname(absolute), { recursive: true });
    publish(absolute);
    if (desired.has(path)) state.terminalArtifact ??= path;
  } catch (error) { errors.push(`${path}: ${String(error)}`); }
  if (!state.terminalArtifact && [...desired].some(path => superseded.has(path))) {
    state.terminalArtifact = relative(state.projectDir, runRecordPath(directory, 'research_report.md'));
  }
  return errors;
}
