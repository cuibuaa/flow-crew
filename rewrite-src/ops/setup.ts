import { protectedStatePaths } from '../records/state.js';
import { putEvidence } from '../records/state.js';
import { claim, release, recordOperation } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { contentIdentity, gitAuthority } from '../records/content.js';
import { resolve, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBrief } from '../contract/brief.js';
import { admitPreparation } from './preparation.js';
import type { JournalPayload, Writer } from '../contract/runtime.js';
import { publishNoReplace, nativeTool, nativeExec, type Claim } from '../host/process.js';
import { openJournal, openWriter, readEvents, appendEvents } from '../records/state.js';
import { validateRecordLayout } from '../records/content.js';
import { hashInputs, captureTree, type ContentScope } from '../records/content.js';
import type { Ref, Result } from '../contract/brief.js';
import { parseSetupRequest, parseSetupEvidence, parseRunRef, type RunLocation, type SetupEvidence, type SetupRequest,
  type RunRef, type RuntimeConfig } from '../contract/runtime.js';

/**  Explicit original brief bytes, future-run identity and main-supplied config/environment. */
export interface SetupContext {
  readonly briefBytes: Uint8Array;
  readonly backend: 'codex' | 'claude';
  readonly location: RunLocation;
  readonly unit: RunRef;
  readonly configRoot: string;
  readonly configuration: RuntimeConfig;
  readonly environment: Readonly<Record<string, string>>;
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
    const journal = await openJournal(context.location, 'read');
    if (!journal.ok) return journal;
    const project = await claim(resolve(request.target), context.unit, { database: context.location.database,
      holder: journal.value.root });
    if (!project.ok) return project;
    claims.push(project.value);
    const execution = await claim(join(journal.value.root, 'execution'), context.unit, { database: context.location.database,
      holder: join(resolve(context.location.storeRoot), 'runs', context.location.run) });
    if (!execution.ok) return execution;
    claims.push(execution.value);
    const opened = await openWriter(journal.value, execution.value, 'execution');
    if (!opened.ok) return opened;
    writer = opened.value;
    const runtimeRoot = dirname(join(resolve(context.location.storeRoot), request.runtime.path));
    if (resolve(context.configRoot) !== join(runtimeRoot, 'config')) return refuse('invalid', 'Config root does not match verified runtime');
    const bytes = await putEvidence(journal.value, context.briefBytes);
    if (!bytes.ok) return bytes;
    const declaration = parseBrief(context.briefBytes);
    if (!declaration.ok) return declaration;
    if (bytes.value.sha256 !== request.brief.digest || !isDeepStrictEqual(bytes.value, request.brief.bytes)
      || !isDeepStrictEqual(declaration.value, request.brief.declaration)) return refuse('invalid', 'Original approved brief bytes mismatch');
    // The journal already owns the pin and every operation below. Import completes before admission reads any project fact.
    const target = resolve(request.target);
    const imported = await recordOperation(journal.value, 'construct', { module: import.meta.url, method: 'importTask', args: [request.project,
      target, true] }); if (!imported.ok) return imported;
    const admitted = await admitPreparation(request.brief.declaration, context.configuration, {
      source: target, project: target, workRoot: join(resolve(context.location.storeRoot), 'work', context.location.run),
      backend: context.backend, environment: context.environment,
      protectedRoots: [journal.value.root, runtimeRoot, request.project, ...protectedStatePaths(context.location.database)]
    });
    if (!admitted.ok) return admitted;
    const authority = admitted.value;
    const layout = await validateRecordLayout({ location: context.location, project: target,
      protectedRoots: [journal.value.root, runtimeRoot, ...protectedStatePaths(context.location.database)] });
    if (!layout.ok) return layout;
    const git = gitAuthority(context.location, layout.value.project);
    const scope: ContentScope = {
      journal: journal.value, layout: layout.value, brief: request.brief,
      inputBaseline: [], outputBaseline: [], projectClaim: project.value, git, authority
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
    const measured = parseSetupEvidence({
      project: request.project, target: request.target, brief: request.brief.digest,
      inputs: inputBaseline, outputs: outputBaseline, tree: baseTree.value, commands: [], backend: context.backend,
        interpretation: authority.interpretation
    });
    if (!measured.ok) return measured;
    const completed = await appendFresh(writer, [{ type: 'run_authority', authority },
      { type: 'setup_prepared', request, unit: context.unit, baselines, measured: measured.value }]);
    return completed.ok ? measured : completed;
  };
  let result: Result<SetupEvidence>;
  try { result = await execute(); }
  catch (error) { result = filesystemFailure(error); }
  finally {
    for (const held of claims.reverse()) {
      const released = await release(held);
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
