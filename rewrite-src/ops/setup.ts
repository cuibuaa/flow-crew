import { protectedStatePaths } from '../records/state.js';
import { prepareAliases, admitAliases, type Alias } from '../host/confine.js';
import { putEvidence } from '../records/state.js';
import { claim, release, recordOperation } from '../records/state.js';
import { preparePolicy, authorityGrant } from '../exec/policy.js';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { gitAuthority } from '../records/content.js';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseBrief, idSchema } from '../contract/brief.js';
import type { OutputFact, JournalPayload, Writer } from '../contract/runtime.js';
import { publishNoReplace, nativeTool, nativeExec, type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { verifyRuntime, hashInputs, type ContentScope } from '../records/content.js';
import { probeExecution } from '../exec/attempt.js';
import type { Ref, Result } from '../contract/brief.js';
import { parseSetupRequest, parseSetupEvidence, parseRunRef, type RunLocation, type RuntimeConfig, type SetupEvidence, type SetupRequest,
  type RunRef } from '../contract/runtime.js';
import type { ExecutionContext } from '../exec/attempt.js';
import type { TransportContext } from '../exec/transport.js';
import type { ProcessPortsFactory } from '../host/process.js';

/**  Read-only preparation observations for one exact request. */
export interface Inspection {
  readonly request: SetupRequest;
  readonly occupancy: 'free' | 'same_run' | 'occupied' | 'unknown';
  readonly evidence: readonly Ref[];
}

/**  Explicit original brief bytes, future-run identity and main-supplied config/environment. */
export interface SetupContext {
  readonly briefBytes: Uint8Array;
  readonly advisory?: (line: string) => void;
  readonly backend: 'codex' | 'claude';
  readonly location: RunLocation;
  readonly unit: RunRef;
  readonly configuration: RuntimeConfig;
  readonly process: ProcessPortsFactory;
  readonly configRoot: ExecutionContext['configRoot'];
  readonly privateEnvironment: TransportContext['privateEnvironment'];
  readonly abort: AbortSignal;
}

/**  Inspect exact brief/path occupancy/input/output dispositions and runtime inventory without materializing or executing. */
export async function inspectSetup(request: SetupRequest, location: RunLocation): Promise<Result<Inspection>> {
  const parsed = parseSetupRequest(request);
  if (!parsed.ok) return parsed;
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
    for (const input of request.brief.declaration.inputs) {
      const path = isAbsolute(input.path) ? input.path : join(project, input.path);
      await checkKind(path, input.kind);
      if (input.kind === 'file' && input.sha256 !== undefined && await fileHash(path) !== input.sha256)
        return refuse('invalid', 'Declared source input hash mismatch');
      if (!isAbsolute(input.path) && !within(project, await fs.realpath(path))) return refuse('invalid', 'Input escapes source');
    }

    const runtime = await verifyRuntime(location.storeRoot, request.runtime);
    if (!runtime.ok) return runtime;
    return { ok: true, value: { request, occupancy, evidence: [runtime.value] } };
  } catch (error) { return filesystemFailure(error); }
}

/** Prepare isolated resources and durable originals, then test physical grants. Commands remain deferred. */
export async function setup(request: SetupRequest, context: SetupContext): Promise<Result<SetupEvidence>> {
  if (!['codex', 'claude'].includes(context.backend)) return refuse('invalid', 'Select a backend before setup');
  const parsed = parseSetupRequest(request);
  if (!parsed.ok) return parsed;
  const unit = parseRunRef(context.unit);
  if (!unit.ok) return unit;
  if (context.unit.run !== context.location.run || !isDeepStrictEqual(context.unit.runtime, request.runtime)) return refuse('invalid',
    'Setup unit mismatch');
  const claims: Claim[] = [];
  let importedAliases: readonly Alias[] = [];
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
    const process = context.process(writer);
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
    const declaration = parseBrief(context.briefBytes, context.advisory);
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
        resolve(request.target), true, request.brief.declaration.inputs.filter(input => input.frozen &&
        !isAbsolute(input.path)).map(input => input.path)] }); if (!imported.ok) return imported; importedAliases = imported.value as readonly Alias[];
    }
    const layout = await validateRecordLayout({
      location: context.location, project: resolve(request.target),
      protectedRoots: [journal.value.root, runtimeRoot, ...protectedStatePaths(context.location.database)],
        sharedCaches: context.configuration.sharedCaches
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
    const facts: OutputFact[] = [];
    for (const output of request.brief.declaration.outputs) {
      try {
        const stat = await fs.lstat(resolve(layout.value.project, output.path));
        facts.push(stat.isSymbolicLink() ? 'other' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; facts.push('absent'); }
    }
    const parents: { path: string; original: OutputFact; mode: number }[] = [];
    for (const output of request.brief.declaration.outputs) {
      let path = dirname(resolve(layout.value.project, output.path));
      while (!parents.some(parent => parent.path === path)) {
        try {
          const stat = await fs.lstat(path);
          parents.push({ path, original: stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'other', mode: stat.mode & 0o7777 }); break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        parents.push({ path, original: 'absent', mode: 0 }); path = dirname(path);
      }
    }
    const preparedAuthority = await preparePolicy(request.brief.declaration, context.configuration, {
      project: layout.value.project, protectedRoots: [...layout.value.protectedRoots, context.configRoot, request.project],
      parents, backend: context.backend, environment: context.privateEnvironment,
      workRoot: resolve(context.location.storeRoot, 'work', context.location.run), home: context.privateEnvironment.HOME,
    }, facts);
    if (!preparedAuthority.ok) return preparedAuthority;
    for (const command of request.brief.declaration.commands) if (command.env.TMPDIR !== undefined) {
      const path = await prospective(command.env.TMPDIR), grant = preparedAuthority.value.commands.find(row => row.id === command.id)!.grant;
      if (!grant.writableRoots.some(root => within(root, path)) || grant.protectedRoots.some(root => within(root,
        path))) return refuse('invalid', `Command ${command.id}: declared TMPDIR lacks physical writable authority`);
    }
    const admittedAliases = admitAliases([...new Set(importedAliases.map(alias => alias.source)),
      ...request.brief.declaration.inputs.filter(input => input.frozen).map(input => resolve(request.target, input.path))],
      [...new Set(Object.values(preparedAuthority.value.purposes).flatMap(grant => grant.writableRoots))], importedAliases);
    if (!admittedAliases.ok) return admittedAliases;
    const authority = { ok: true as const, value: { ...preparedAuthority.value, aliases: importedAliases } };
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
    const preparedScope: ContentScope = { ...scope, inputBaseline, outputBaseline };
    const baselines = { inputs: inputBaseline, outputs: outputBaseline };
    const committed = await appendFresh(writer, [{ type: 'run_authority', authority: authority.value }, { type: 'setup_prepared', request,
      unit: context.unit, baselines, measured: null }]);
    if (!committed.ok) return committed;
    // Originals are durable before provisioning exact external roots. A placeholder is never original evidence.
    for (const output of authority.value.outputs) if (output.provision) {
      for (const parent of [...authority.value.parents].reverse()) if (parent.original === 'absent') {
        try { await fs.mkdir(parent.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (output.kind === 'directory') {
        if (!authority.value.parents.some(parent => parent.path === output.absolute && parent.original === 'absent')) await fs.mkdir(output.absolute);
      }
      else { const file = await fs.open(output.absolute, 'wx', 0o600); await file.close(); }
    }
    const evidence: Ref[] = [];
    const disclosures: string[] = [];
    let nativeGrant: SetupEvidence['nativeGrant'] = 'applied';
    for (const purpose of ['work', 'plan', 'gate'] as const) {
      const scratch = join(resolve(context.location.storeRoot), 'work', context.location.run, 'probes', purpose);
      await fs.mkdir(scratch, { recursive: true });
      const probe = await probeExecution(authorityGrant(authority.value, purpose, scratch, context.backend, scope.git), {
        scope: preparedScope, process, privateEnvironment: context.privateEnvironment, abort: context.abort,
      });
      if (!probe.ok) return probe;
      evidence.push(...probe.value.evidence); disclosures.push(probe.value.detail);
      if (probe.value.state !== 'applied') { nativeGrant = probe.value.state; break; }
    }
    const measured = parseSetupEvidence({
      project: request.project, target: request.target, brief: request.brief.digest,
      inputs: inputBaseline, outputs: outputBaseline, nativeGrant, commands: [], backend: context.backend,
        interpretation: [...authority.value.interpretation, ...disclosures]
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
async function prospective(path: string): Promise<string> {
  try { return await fs.realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return join(await prospective(dirname(resolve(path))),
    resolve(path).slice(dirname(resolve(path)).length + 1)); }
}
async function checkKind(path: string, kind: 'file' | 'directory'): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw new Error('Declared path kind mismatch or symlink');
}
async function appendFresh(writer: Writer, payloads: readonly JournalPayload[]): Promise<Result<number>> {
  const events = await readEvents(writer.journal, 0);
  if (!events.ok) return events;
  return appendEvents(writer, events.value.at(-1)?.seq ?? 0, payloads);
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Native selective import into fresh private staging. */
export async function importSource(source: string, target: string, workspace: boolean, frozen: readonly string[] = []): Promise<readonly Alias[]> {
  const parent = dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(join(parent, '.import-'));
  try {
    const stat = await fs.lstat(source);
    const operand = stat.isDirectory() ? source + '/' : source;
    const destination = stat.isDirectory() ? staging + '/content/' : staging + '/content';
    if (stat.isDirectory()) await fs.mkdir(destination);
    const links: { source: string; relative: string }[] = [];
    const visit = async (path: string) => { const info = await fs.lstat(path);
      if (info.isDirectory()) for (const name of await fs.readdir(path)) await visit(join(path, name)); else if (info.isFile() &&
      info.nlink > 1) links.push({ source: path, relative: path.slice(source.length + 1) }); };
    for (const relative of frozen) await visit(join(source, relative));
    const exclude = (name: string) => '/' + [...name].map(char => '*?[]'.includes(char) ? '[' + char + ']' : char).join('');
    const args = ['--recursive', '--links', '--perms', '--times', '--devices', '--specials', '--super',
      ...(workspace ? ['--exclude=/.git'] : []), ...links.map(link => '--exclude=' + exclude(link.relative))];
    const run = async (...extra: string[]) => nativeExec([await nativeTool('rsync'), ...args, ...extra, '--', operand, destination], { env: {} });
    await run();
    const comparison = await run('--dry-run', '--checksum', '--itemize-changes');
    const reverse = await nativeExec([await nativeTool('rsync'), ...args,
      '--dry-run', '--checksum', '--itemize-changes', '--', destination, operand], { env: {} });
    if (comparison.stdout || reverse.stdout) throw new Error('Source changed during import');
    for (const link of links) { const name = join(destination, link.relative); await fs.mkdir(dirname(name), { recursive: true });
      await fs.link(link.source, name); }
    await publishNoReplace(destination.replace(/\/$/, ''), target);
    const aliases = prepareAliases(links.map(link => ({ source: link.source, destination: join(target, link.relative), writable: false })));
      if (!aliases.ok) throw Error(aliases.detail); return aliases.value;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function importTask(source: string, target: string, workspace: boolean,
  frozen: readonly string[] = []): Promise<Result<readonly Alias[]>> {
  try { return { ok: true, value: await importSource(source, target, workspace, frozen) }; } catch (error) { return filesystemFailure(error); }
}
