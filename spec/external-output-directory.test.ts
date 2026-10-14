import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { archiveDeclaredOutputs, declaredOutputSource } from '../src/declared-output-archive.js';
import { readRunStateView } from '../src/run-state-view.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { extractBriefOutputDeclarations, inspectBriefOutputs, nodeShipInputFileSystem } from '../src/ship-inputs.js';
import { createRun, fcGlobalDir, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { registerEngineOwnedSqlitePath } from '../src/engine-owned-carriers.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { clearAttemptSummaryRefreshDebounce } from '../src/run-events.js';

// Runtime callers derive their installation from their module location. Model
// a separate fixture installation when the entire fixture lives in this repo.
const installation = vi.hoisted(() => { vi.resetModules(); return { install: () => {} }; });
vi.mock('../src/ship-inputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-inputs.js')>();
  const { dirname, join } = await import('node:path');
  const external = actual.externalOutputDirectory, inventory = actual.inspectBriefOutputs;
  installation.install = () => {
    vi.spyOn(actual, 'externalOutputDirectory').mockImplementation((declaration, project, fs, context) =>
      external(declaration, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
    vi.spyOn(actual, 'inspectBriefOutputs').mockImplementation((brief, project, fs, context) =>
      inventory(brief, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
  };
  return actual;
});

let root: string, project: string, output: string, stateRoot: string, previousStore: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [], replays: [] };
const brief = (path: string, type = 'directory') => `---\noutputs:\n  - path: ${JSON.stringify(path)}\n    type: ${type}\n---\n# Goal\nWrite per-item results.\n\n## Acceptance criteria\n1. Retain the per-item results in the declared directory.\n`;
beforeEach(() => {
  installation.install();
  root = mkdtempSync(join(tmpdir(), 'fc-external-output-'));
  project = join(root, 'project'); mkdirSync(project);
  output = join(root, 'durable', 'items');
  stateRoot = join(root, 'state'); previousStore = fcGlobalDir(); setFcGlobalDir(stateRoot);
});
afterEach(() => { clearAttemptSummaryRefreshDebounce(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

function boundaryFixture(source = brief(output)) {
  const created = createRun(project, 'external-output', 'name: fixture\nstages: []\n', ['work']);
  writeFileSync(join(created.runDirPath, 'task_brief.md'), source);
  const input = { projectDir: project, runDir: created.runDirPath, stageId: 'work', projectWriteScope: [], artifactContract: contract };
  const command = (code: string) => execWithStdin(process.execPath, ['-e', code], '', { cwd: project, timeout_ms: 5000 });
  return { ...created, input, command };
}

describe('absolute directories in the declared output contract', () => {
  it('retains the declaration and inventories only pathname metadata', () => {
    mkdirSync(output, { recursive: true });
    const noContents = { ...nodeShipInputFileSystem,
      readDirectory: vi.fn(() => { throw new Error('must not walk outputs'); }),
      readBytes: vi.fn(() => { throw new Error('must not hash outputs'); }),
    };
    expect(extractBriefOutputDeclarations(brief(output))).toMatchObject([{ path: output, expectedType: 'directory', source: 'outputs.path' }]);
    const inventory = inspectBriefOutputs(brief(output), project, noContents);
    expect(inventory.blocking).toEqual([]);
    expect(inventory.entries[0]).toMatchObject({ exists: true, entryType: 'directory', reason: expect.stringContaining('not inventoried or archived') });
    expect(noContents.readDirectory).not.toHaveBeenCalled(); expect(noContents.readBytes).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'worktree'])('keeps protected source paths and shared Git storage closed (%s launch)', launch => {
    const target = join(root, 'target');
    const gitDir = join(project, '.git');
    mkdirSync(gitDir);
    const context = { launchProject: launch === 'unknown' ? null : target };
    expect(inspectBriefOutputs(brief(join(gitDir, 'objects', 'results')), project, undefined, context).blocking).toHaveLength(1);
    if (launch === 'unknown') {
      for (const name of ['.fc', '.github', '.codex', '.claude']) {
        expect(inspectBriefOutputs(brief(join(project, name, 'results')), project, undefined, context).blocking).toHaveLength(1);
      }
    }
    mkdirSync(target);
    const worktreeGit = join(gitDir, 'worktrees', 'target');
    mkdirSync(worktreeGit, { recursive: true });
    writeFileSync(join(target, '.git'), `gitdir: ${worktreeGit}\n`);
    writeFileSync(join(worktreeGit, 'commondir'), '../..\n');
    expect(inspectBriefOutputs(brief(join(gitDir, 'objects', 'results')), target).blocking[0].reason).toContain('project Git storage');
  });

  it.each(['project', 'project child', 'project parent', 'engine root', 'dist', 'build generation', 'state root', 'other run', 'home', 'home configuration', 'root', 'root-level tree', 'traversal', 'absolute file', 'template'])(
    'refuses %s before creating an output root', kind => {
      const engine = join(root, 'engine');
      const paths: Record<string, string> = {
        project, 'project child': join(project, '.git', 'objects'), 'project parent': root,
        'engine root': engine, dist: join(engine, 'dist', 'external-results'),
        'build generation': join(engine, '.cache', 'build-generations', 'generation', 'results'),
        'state root': stateRoot, 'other run': join(stateRoot, 'runs', 'other', 'results'),
        home: process.env.HOME!, 'home configuration': join(process.env.HOME!, '.ssh', 'results'), root: '/', 'root-level tree': '/tmp',
        traversal: `${output}/../escape`, 'absolute file': output, template: `${output}/$NAME`,
      };
      const inventory = inspectBriefOutputs(brief(paths[kind], kind === 'absolute file' ? 'file' : 'directory'), project);
      expect(inventory.blocking, kind).toHaveLength(1);
      expect(inventory.blocking[0].reason).toContain('EXTERNAL_OUTPUT_REFUSED');
      expect(existsSync(output)).toBe(false);
    },
  );

  it('accepts an ordinary directory under $HOME without creating it', () => {
    const path = join(process.env.HOME!, `flowcrew-external-output-probe-${process.pid}`, 'results');
    const inventory = inspectBriefOutputs(brief(path), project);
    expect(inventory.blocking).toHaveLength(0);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('reserves a future custom engine database during output inventory', () => {
    registerEngineOwnedSqlitePath(join(output, 'future.sqlite'));
    const inventory = inspectBriefOutputs(brief(output), project);
    expect(inventory.blocking).toHaveLength(1);
    expect(inventory.blocking[0].reason).toContain('contains an engine database');
    expect(inspectBriefOutputs(brief(join(root, 'ordinary')), project).blocking).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each(['root', 'ancestor', 'dangling ancestor'])('refuses a symlink at the %s', kind => {
    mkdirSync(join(root, 'destination'));
    const link = join(root, 'link');
    symlinkSync(join(root, kind === 'dangling ancestor' ? 'missing' : 'destination'), link);
    const path = kind === 'root' ? link : join(link, 'items');
    expect(inspectBriefOutputs(brief(path), project).blocking[0].reason).toContain('symlinked pathname');
  });

  it.each(['.git', '.fc', '.github', '.codex', '.claude', 'declared input'])('refuses physical overlap with %s', kind => {
    mkdirSync(output, { recursive: true });
    symlinkSync(output, join(project, kind === 'declared input' ? 'dataset' : kind));
    const source = kind === 'declared input' ? brief(output).replace('outputs:', 'inputs: [dataset]\noutputs:') : brief(output);
    expect(inspectBriefOutputs(source, project).blocking[0].reason).toMatch(/overlaps (project protected path|declared input)/);
  });

  it('refuses an occupied file and keeps unsupported absolute research slots visible', () => {
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, 'existing data');
    expect(inspectBriefOutputs(brief(output), project).blocking[0].reason).toContain('not a directory');
    expect(inspectBriefOutputs(`---\nresearch:\n  report_dir: ${output}\n---\n`, project).blocking[0].reason).toContain('in outputs');
  });

  it('resolves dangling protected links using the same metadata adapter as preflight', () => {
    symlinkSync(output, join(project, '.git'));
    const fs = { ...nodeShipInputFileSystem, lstat: path => nodeShipInputFileSystem.lstat!(path) };
    expect(inspectBriefOutputs(brief(output), project, fs).blocking[0].reason).toContain('project protected path');
  });

  it.each([false, true])('refuses Git storage outside the project (linked worktree=%s)', linked => {
    const gitRoot = join(root, 'git-storage');
    const gitDir = linked ? join(gitRoot, 'worktrees', 'task') : gitRoot;
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(project, '.git'), `gitdir: ${gitDir}\n`);
    if (linked) writeFileSync(join(gitDir, 'commondir'), '../..\n');
    const path = join(gitRoot, 'objects', 'results');
    expect(inspectBriefOutputs(brief(path), project).blocking[0].reason).toContain('project Git storage');
    expect(existsSync(path)).toBe(false);
  });

  it.each(['dist', 'build generations'])('refuses physical overlap with engine %s outside the installation', kind => {
    const engineRoot = join(root, 'engine');
    mkdirSync(join(engineRoot, '.cache'), { recursive: true });
    symlinkSync(output, kind === 'dist' ? join(engineRoot, 'dist') : join(engineRoot, '.cache', 'build-generations'));
    expect(inspectBriefOutputs(brief(output), project, undefined, { engineRoot }).blocking[0].reason).toContain(`engine ${kind}`);
  });

  it('records external locators without walking, hashing, or copying members at settlement', () => {
    const f = boundaryFixture(); mkdirSync(output, { recursive: true });
    // External outputs remain opaque, including links to absent targets.
    symlinkSync(join(root, 'missing'), join(output, 'opaque-link'));
    const declarations = extractBriefOutputDeclarations(brief(output));
    expect(declaredOutputSource(project, declarations[0])).toBe(output);
    const manifest = archiveDeclaredOutputs(project, f.runDirPath, declarations);
    expect(manifest.outputs).toEqual([{ path: output, expectedType: 'directory', external: true }]);
    expect(readdirSync(join(f.runDirPath, 'declared_outputs'))).toEqual([]);
    updateRunState(project, f.runId, state => { state.declaredOutputs = declarations; });
    expect(readRunStateView(project, f.runId).artifacts).toContainEqual(expect.objectContaining({
      declaration: expect.objectContaining({ root: 'external', path: output }),
      existence: expect.objectContaining({ status: 'present', path: output }),
    }));
  });
});

describe('external output execution', () => {
  it('retains ordinary filesystem access beyond declared output roots', async () => {
    const f = boundaryFixture();
    await withEngineIntegrity(f.input, async () => {
      const paths = [join(output, 'result'), join(root, 'ordinary'), join(project, 'ordinary')];
      const result = await f.command(`const fs=require('node:fs'); for(const path of ${JSON.stringify(paths)}) fs.writeFileSync(path,'result');`);
      expect(result.exitCode, result.output).toBe(0);
      for (const path of paths) expect(readFileSync(path, 'utf8')).toBe('result');
    });
  });

  it('refuses an invalid declaration before entering stage code', async () => {
    const f = boundaryFixture(brief(join(stateRoot, 'runs', 'other', 'results')));
    const action = vi.fn(async () => {});
    await expect(withEngineIntegrity(f.input, action)).rejects.toThrow('EXTERNAL_OUTPUT_REFUSED');
    expect(action).not.toHaveBeenCalled();
  });

  it('refuses a source-overlapping in-place launch before stage code', async () => {
    const path = join(project, 'runs', 'results');
    const f = boundaryFixture(brief(path));
    const action = vi.fn(async () => {});
    await expect(withEngineIntegrity(f.input, action)).rejects.toThrow('overlaps project');
    expect(action).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('completes a real scheduler stage once without parking or requesting approval', async () => {
    mkdirSync(join(project, 'config', 'agents'), { recursive: true });
    writeFileSync(join(project, 'config', 'agents', 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const config: WorkflowConfig = { name: 'external-output', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{
      id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'Write the declared output.',
      skills: [], dynamic_dispatch: false, is_gate: false, artifact_contract: contract,
    }] };
    const written = join(output, 'per-item', 'result.json'); let calls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls++;
      expect(prompt).toContain(output);
      const result = await execWithStdin(process.execPath, ['-e', `const fs=require('node:fs');
        fs.mkdirSync(${JSON.stringify(dirname(written))},{recursive:true});fs.writeFileSync(${JSON.stringify(written)},'durable result');`], '',
      { cwd: project, timeout_ms: 5000 });
      expect(result.exitCode, result.output).toBe(0);
      return fixtureResult({ ...result, output: 'Results retained.', writes: [written], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(config, 'name: external-output\nstages: []\n', project, adapter, new Map(), undefined,
      join(project, 'config', 'agents'), undefined, brief(output).split('\n## Acceptance criteria')[0], false);
    expect(final.status, final.failureReason).toBe('complete'); expect(calls).toBe(1);
    expect(readStageStatus(project, final.runId!, 'work').attempts).toHaveLength(1);
    expect(readFileSync(written, 'utf8')).toBe('durable result');
    expect(existsSync(join(stateRoot, 'runs', final.runId!, 'approvals'))).toBe(false);
  });
});
