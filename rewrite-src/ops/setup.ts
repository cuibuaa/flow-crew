import { admitInputs, admitPreparation, prospective } from './preparation.js';
import { protectedStatePaths } from '../records/state.js';
import { putEvidence } from '../records/state.js';
import { claim, release, recordOperation } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { contentIdentity, gitAuthority } from '../records/content.js';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseBrief, idSchema } from '../contract/brief.js';
import type { JournalPayload, Writer } from '../contract/runtime.js';
import { publishNoReplace, nativeTool, nativeExec, type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { verifyRuntime, hashInputs, captureTree, type ContentScope } from '../records/content.js';
import type { Ref, Result } from '../contract/brief.js';
import { parseSetupRequest, parseSetupEvidence, parseRunRef, type RunLocation, type RuntimeConfig, type SetupEvidence, type SetupRequest,
  type RunRef } from '../contract/runtime.js';

/**  Read-only preparation observations for one exact request. */
export interface Inspection {
  readonly request: SetupRequest;
  readonly occupancy: 'free' | 'same_run' | 'occupied' | 'unknown';
  readonly evidence: readonly Ref[];
}

/**  Explicit original brief bytes, future-run identity and main-supplied config/environment. */
export interface SetupContext {
  readonly briefBytes: Uint8Array;
  readonly backend: 'codex' | 'claude';
  readonly location: RunLocation;
  readonly unit: RunRef;
  readonly configuration: RuntimeConfig;
  readonly configRoot: string;
  readonly privateEnvironment: Readonly<Record<string, string>>;
}

/**  Inspect exact brief/path occupancy/input/output dispositions and runtime inventory without materializing or executing. */
export async function inspectSetup(request: SetupRequest, location: RunLocation): Promise<Result<Inspection>> {
  const parsed = parseSetupRequest(request);
  if (!parsed.ok) return parsed;
  request = parsed.value;
  if (!idSchema.safeParse(location.run).success) return refuse('invalid', 'Invalid run id');
  try {
    const project = await fs.realpath(request.project);
    const target = await prospective(request.target);
    if (project === target || within(project, target) || within(target, project)) return refuse('invalid', 'Source and target overlap');
    const sourceStat = await fs.lstat(project);
    if (!sourceStat.isDirectory()) return refuse('invalid', 'Source is not a directory');
    let occupancy: Inspection['occupancy'] = 'free';
    try { await fs.lstat(target); occupancy = 'occupied'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse('unknown', 'Target occupancy unknown'); }
    if (occupancy === 'occupied') {
      const journal = await openJournal(location, 'read');
      if (journal.ok) {
        const events = await readEvents(journal.value, 0);
        if (!events.ok) occupancy = 'unknown';
        else if (events.value.some(event => event.payload.type === 'setup_prepared' && isDeepStrictEqual(event.payload.request,
          request))) occupancy = 'same_run';
      } else if (journal.kind !== 'unavailable') occupancy = 'unknown';
    }
    const inputs = await admitInputs(request.brief.declaration, project);
    if (!inputs.ok) return inputs;

    const runtime = await verifyRuntime(location.storeRoot, request.runtime);
    if (!runtime.ok) return runtime;
    return { ok: true, value: { request, occupancy, evidence: [runtime.value] } };
  } catch (error) { return filesystemFailure(error); }
}

/** Prepare isolated resources and durable originals, record content observations. Commands remain deferred. */
export async function setup(request: SetupRequest, context: SetupContext): Promise<Result<SetupEvidence>> {
  if (!['codex', 'claude'].includes(context.backend)) return refuse('invalid', 'Select a backend before setup');
  const parsed = parseSetupRequest(request);
  if (!parsed.ok) return parsed;
  request = parsed.value;
  const unit = parseRunRef(context.unit);
  if (!unit.ok) return unit;
  if (context.unit.run !== context.location.run || !isDeepStrictEqual(context.unit.runtime, request.runtime)) return refuse('invalid',
    'Setup unit mismatch');
  const claims: Claim[] = [];
  let writer: Writer | undefined;
  let cleanup: Result<unknown> = { ok: true, value: null };
  const execute = async (): Promise<Result<SetupEvidence>> => {
    const project = await claim(resolve(request.target), context.unit, { database: context.location.database,
      holder: join(resolve(context.location.storeRoot), 'runs', context.location.run) });
    if (!project.ok) return project;
    claims.push(project.value);
    let journal = await openJournal(context.location, 'read');
    if (!journal.ok && journal.kind === 'unavailable') journal = await openJournal(context.location, 'create');
    if (!journal.ok) return journal;
    // The exclusive journal creator establishes the directory before its sibling claim carrier.
    const execution = await claim(join(journal.value.root, 'execution'), context.unit, { database: context.location.database,
      holder: join(resolve(context.location.storeRoot), 'runs', context.location.run) });
    if (!execution.ok) return execution;
    claims.push(execution.value);
    const opened = await openWriter(journal.value, execution.value, 'execution');
    if (!opened.ok) return opened;
    writer = opened.value;
    const prior = await readEvents(journal.value, 0);
    if (!prior.ok) return prior;
    if (prior.value.some(event => event.payload.type === 'admitted')) return refuse('conflict', 'Run already admitted');
    const prepared = prior.value.filter(event => event.payload.type === 'setup_prepared').at(-1);
    if (prepared?.payload.type === 'setup_prepared' && (!isDeepStrictEqual(prepared.payload.request, request)
      || !isDeepStrictEqual(prepared.payload.unit, context.unit))) return refuse('conflict', 'Different preparation already owns run');
    if (prepared?.payload.type === 'setup_prepared') {
      if (prepared.payload.measured === null) return refuse('unknown', 'Preparation has no completed measurement; original baselines retained');
      if (prepared.payload.measured.backend !== context.backend) return refuse('conflict',
        'Backend differs from prepared setup; repeat setup in a fresh target');
      return parseSetupEvidence(prepared.payload.measured);
    }
    // N3a: authenticate the pin before deriving any protected path or probing a backend.
    const runtime = await verifyRuntime(context.location.storeRoot, request.runtime);
    if (!runtime.ok) return runtime;
    const runtimeRoot = dirname(join(resolve(context.location.storeRoot), runtime.value.path));
    if (resolve(context.configRoot) !== join(runtimeRoot, 'config')) return refuse('invalid', 'Config root does not match verified runtime');
    const bytes = await putEvidence(journal.value, context.briefBytes);
    if (!bytes.ok) return bytes;
    const declaration = parseBrief(context.briefBytes);
    const digest = createHash('sha256').update(context.briefBytes).digest('hex');
    if (!declaration.ok) return declaration;
    if (digest !== request.brief.digest || !isDeepStrictEqual(bytes.value, request.brief.bytes)
      || !isDeepStrictEqual(declaration.value, request.brief.declaration)) return refuse('invalid', 'Original approved brief bytes mismatch');
    const inspection = await inspectSetup(request, context.location);
    if (!inspection.ok) return inspection;
    if (inspection.value.occupancy === 'occupied') return refuse('conflict', 'Target occupied by another preparation');
    if (inspection.value.occupancy === 'unknown') return refuse('unknown', 'Target occupancy unknown');
    if (inspection.value.occupancy === 'free') {
      const imported = await recordOperation(journal.value, 'construct', { module: import.meta.url, method: 'importTask', args: [request.project,
        resolve(request.target), true] }); if (!imported.ok) return imported;
    }
    const layout = await validateRecordLayout({
      location: context.location, project: resolve(request.target),
      protectedRoots: [journal.value.root, runtimeRoot, ...protectedStatePaths(context.location.database)]
    });
    if (!layout.ok) return layout;
    for (const input of request.brief.declaration.inputs) {
      if (isAbsolute(input.path)) continue;
      const target = join(layout.value.project, input.path);
      try { await fs.lstat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const imported = await recordOperation(journal.value, 'construct', { module: import.meta.url, method: 'importTask',
          args: [join(request.project, input.path), target, false] }); if (!imported.ok) return imported;
      }
    }
    const preparedAuthority = await admitPreparation(request.brief.declaration, context.configuration, {
      project: layout.value.project, source: layout.value.project,
      protectedRoots: [...layout.value.protectedRoots, context.configRoot, request.project],
      backend: context.backend, environment: context.privateEnvironment,
      workRoot: resolve(context.location.storeRoot, 'work', context.location.run),
    });
    if (!preparedAuthority.ok) return preparedAuthority;
    const authority = preparedAuthority;
    const git = gitAuthority(context.location, layout.value.project);
    const scope: ContentScope = {
      journal: journal.value, layout: layout.value, brief: request.brief,
      inputBaseline: [], outputBaseline: [], projectClaim: project.value, git, authority: authority.value
    };
    const inputs = await hashInputs(scope);
    if (!inputs.ok) return inputs;
    const inputBaseline = [...inputs.value];
    const outputBaseline: Ref[] = [];
    for (const output of request.brief.declaration.outputs) {
      // Use the same streaming snapshot owner for originals, without a second baseline format.
      const captured = await hashInputs({
        ...scope, brief: {
          ...request.brief,
          declaration: { ...request.brief.declaration, inputs: [{ id: 'output_baseline', path: output.path, kind: output.kind, frozen: true }] }
        }
      });
      if (!captured.ok) return captured;
      outputBaseline.push(captured.value[0]);
    }
    // The run's base: what every gate's change view compares with. Captured once, here, after the last write setup makes.
    const baseTree = await captureTree(scope);
    if (!baseTree.ok) return baseTree;
    const baselines = { inputs: inputBaseline, outputs: outputBaseline, tree: baseTree.value };
    const committed = await appendFresh(writer, [{ type: 'run_authority', authority: authority.value }, { type: 'setup_prepared', request,
      unit: context.unit, baselines, measured: null }]);
    if (!committed.ok) return committed;
    const measured = parseSetupEvidence({
      project: request.project, target: request.target, brief: request.brief.digest,
      inputs: inputBaseline, outputs: outputBaseline, tree: baseTree.value, commands: [], backend: context.backend,
        interpretation: authority.value.interpretation
    });
    if (!measured.ok) return measured;
    const completed = await appendFresh(writer, [{ type: 'setup_prepared', request, unit: context.unit, baselines, measured: measured.value }]);
    return completed.ok ? measured : completed;
  };
  let result: Result<SetupEvidence>;
  try { result = await execute(); }
  catch (error) { result = filesystemFailure(error); }
  finally {
    for (const held of claims.reverse()) {
      const released = await release(held, held.unit === null ? 'retire' : 'handoff');
      if (!released.ok) cleanup = released;
    }
  }
  return cleanup.ok ? result : cleanup;
}

function refuse(kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> { return { ok: false, kind, detail }; }
function filesystemFailure(error: unknown): Result<never> {
  return refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unknown',
    error instanceof Error ? error.message : String(error));
}
function within(parent: string, child: string): boolean { return child === parent || child.startsWith(parent + sep); }
async function appendFresh(writer: Writer, payloads: readonly JournalPayload[]): Promise<Result<number>> {
  const events = await readEvents(writer.journal, 0);
  if (!events.ok) return events;
  return appendEvents(writer, events.value.at(-1)?.seq ?? 0, payloads);
}
/** Native selective import into fresh private staging. */
export async function importSource(source: string, target: string, workspace: boolean): Promise<void> {
  const parent = dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(join(parent, '.import-'));
  try {
    const stat = await fs.lstat(source);
    // The copier's working directory is the staging directory, so the source operand must not depend on the caller's.
    const operand = resolve(source) + (stat.isDirectory() ? '/' : '');
    // The copier runs inside the staging directory and names its destination relatively. A Unix socket entry is
    // created by binding a path built from the destination operand, and bind(2) accepts at most 104 bytes on macOS
    // (108 on Linux; unix(7) and the macOS sys/un.h). openrsync, the macOS system rsync, fails with EINVAL
    // ("mkstempsock") when the operand is an absolute path past that limit, and run directories under a long
    // home or TMPDIR are. A relative operand is bounded by its own length, not by where the run lives.
    const copy = stat.isDirectory() ? 'content/' : 'content', destination = staging + '/' + copy;
    if (stat.isDirectory()) await fs.mkdir(destination);
    const exclude = (name: string) => '/' + [...name].map(char => '*?[]'.includes(char) ? '[' + char + ']' : char).join('');
    const excluded = workspace ? ['.git'] : [];
    const args = ['--recursive', '--links', '--perms', '--times', '--devices', '--specials', '--super',
      ...excluded.map(name => '--exclude=' + exclude(name))];
    const before = await contentIdentity(source, excluded);
    await nativeExec([await nativeTool('rsync'), ...args, '--', operand, copy], { env: {}, cwd: staging });
    if (await contentIdentity(source, excluded) !== before) throw new Error('Source changed during import');
    if (await contentIdentity(destination, excluded) !== before) throw new Error('Imported copy differs from source');
    await publishNoReplace(destination.replace(/\/$/, ''), target);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function importTask(source: string, target: string, workspace: boolean): Promise<Result<null>> {
  try { await importSource(source, target, workspace); return { ok: true, value: null }; } catch (error) { return filesystemFailure(error); }
}
