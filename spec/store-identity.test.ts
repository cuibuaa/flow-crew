import { execFileSync } from 'node:child_process';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { artifactDeclarationFindings } from '../src/artifact-declarations.js';
import { fcGlobalDir, setFcGlobalDir, ensureGlobalRunsDir, runsRoot, campaignsRoot } from '../src/store.js';
import { stageWorkPath } from '../src/run-layout.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, run: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
function findings(path: string, kind: 'file' | 'directory' = 'file') {
  return artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{
    id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [{
      id: 'result', root: 'project', path: relative(project, path), kind,
    }] },
  }] });
}
const refused = (path: string, kind: 'file' | 'directory' = 'file') =>
  expect(findings(path, kind)).toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-store-identity-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'initial-store'));
  run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

it.each(['direct', 'symlink', 'hardlink', 'directory', 'ancestor', 'future'] as const)(
  'refuses this engine state inside the project via %s', route => {
    const container = join(project, 'container'), store = join(container, 'state');
    setFcGlobalDir(store); ensureGlobalRunsDir();
    const carrier = join(store, 'arbitrary-record'); writeFileSync(carrier, 'engine state');
    let output = carrier;
    if (route === 'symlink') { output = join(project, 'alias'); symlinkSync(carrier, output); }
    if (route === 'hardlink') { output = join(project, 'alias'); linkSync(carrier, output); }
    if (route === 'directory') output = store;
    if (route === 'ancestor') output = container;
    if (route === 'future') output = join(store, 'uncreated', 'record');
    refused(output, route === 'directory' || route === 'ancestor' ? 'directory' : 'file');
    expect(readFileSync(carrier, 'utf8')).toBe('engine state');
  });

it('protects configured runs storage reached through a symlink outside FC_HOME', () => {
  const store = join(root, 'state'), runs = join(project, 'machine-runs');
  mkdirSync(store); mkdirSync(runs); symlinkSync(runs, join(store, 'runs'), 'dir');
  setFcGlobalDir(store); ensureGlobalRunsDir();
  const record = join(runs, 'arbitrary-record'); writeFileSync(record, 'engine state');
  refused(record);
  refused(join(runs, 'uncreated'));
  refused(runs, 'directory');
});

it('judges the configured root alias at its current target on every admission', () => {
  const state = join(project, 'state'), ordinary = join(project, 'ordinary'), alias = join(root, 'config-alias');
  mkdirSync(state); mkdirSync(ordinary); symlinkSync(state, alias, 'dir');
  setFcGlobalDir(alias); ensureGlobalRunsDir();
  expect(fcGlobalDir()).toBe(alias);
  expect(runsRoot()).toBe(join(alias, 'runs'));
  expect(campaignsRoot()).toBe(join(alias, 'campaigns'));
  const record = join(state, 'record'); writeFileSync(record, 'engine state');
  refused(record);
  rmSync(alias); symlinkSync(ordinary, alias, 'dir');
  const output = join(ordinary, 'result'); writeFileSync(output, 'engine state');
  refused(output);
  refused(join(ordinary, 'future-record'));
  refused(ordinary, 'directory');
  expect(findings(record)).toEqual([]);
});

it('judges a renamed state directory only at its currently configured location', () => {
  const state = join(project, 'state'), moved = join(project, 'retained-state');
  setFcGlobalDir(state); ensureGlobalRunsDir();
  const record = join(state, 'record'); writeFileSync(record, 'engine state');
  refused(record);
  renameSync(state, moved);
  expect(findings(join(moved, 'record'))).toEqual([]);
  setFcGlobalDir(moved);
  refused(join(moved, 'record'));
  refused(join(moved, 'uncreated', 'record'));
  expect(readFileSync(join(moved, 'record'), 'utf8')).toBe('engine state');
});

it('treats a former configured store as ordinary project content after reconfiguration', () => {
  const state = join(project, 'previous-state');
  setFcGlobalDir(state); ensureGlobalRunsDir();
  const record = join(state, 'record'); writeFileSync(record, 'former engine data');
  refused(record);
  setFcGlobalDir(join(root, 'current-state')); ensureGlobalRunsDir();
  expect(findings(record)).toEqual([]);
});

it('creates only its configured runs directory without persisting an ownership inventory', () => {
  const home = join(root, 'creator-home'), state = join(root, 'creator-state'); mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FC_')));
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { ensureGlobalRunsDir } from './src/store.ts'; ensureGlobalRunsDir();"],
  { cwd: process.cwd(), env: { ...env, HOME: home, FC_HOME: state }, timeout: 15000 });
  expect(readdirSync(home)).toEqual([]);
  expect(readdirSync(state)).toEqual(['runs']);
});

it('counts overlapping project and own-work roots only once', () => {
  project = stageWorkPath(run);
  const source = join(project, 'result'); writeFileSync(source, 'stage data');
  linkSync(source, join(root, 'outside-link'));
  refused(source);
});

it('refuses this engine state configured inside its own work tree', () => {
  const state = stageWorkPath(run);
  setFcGlobalDir(state); ensureGlobalRunsDir();
  const record = join(state, 'arbitrary-state'); writeFileSync(record, 'engine state');
  for (const route of ['direct', 'symlink', 'hardlink', 'directory'] as const) {
    const output = route === 'directory' ? state : route === 'direct' ? record : join(project, route);
    if (route === 'symlink') symlinkSync(record, output);
    if (route === 'hardlink') linkSync(record, output);
    const outputRoot = route === 'direct' || route === 'directory' ? 'run' as const : 'project' as const;
    const artifactContract = { ...contract, produces: [{ id: 'result', root: outputRoot,
      path: relative(outputRoot === 'run' ? run : project, output), kind: route === 'directory' ? 'directory' as const : 'file' as const }] };
    expect(artifactDeclarationFindings({ projectDir: project, runDir: run, stages: [{ id: 'work', depends_on: [], artifact_contract: artifactContract }] }))
      .toContainEqual(expect.objectContaining({ message: expect.stringContaining('ARTIFACT_FRAMEWORK_PATH') }));
  }
});

it('protects the current runs target while preserving the configured write spelling', () => {
  const state = join(root, 'state'), first = join(project, 'first-runs'), second = join(project, 'second-runs');
  mkdirSync(state); mkdirSync(first); mkdirSync(second);
  const alias = join(state, 'runs'); symlinkSync(first, alias, 'dir');
  setFcGlobalDir(state);
  refused(join(first, 'future-record'));
  rmSync(alias); symlinkSync(second, alias, 'dir');
  const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  expect(dirname(created.runDirPath)).toBe(alias);
  expect(existsSync(join(second, created.runId, 'run.json'))).toBe(true);
  expect(existsSync(join(first, created.runId))).toBe(false);
  refused(join(second, created.runId, 'run.json'));
  refused(join(second, created.runId), 'directory');
  refused(join(second, 'future-record'));
  const output = join(second, 'ordinary-result'); writeFileSync(output, 'engine state');
  refused(output);
  expect(findings(join(first, 'future-record'))).toEqual([]);
});

it('imports and configures the store without inspecting configured paths', () => {
  const blocker = join(root, 'not-a-directory'); writeFileSync(blocker, 'data');
  const state = join(blocker, 'initial'), next = join(blocker, 'next');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const inspected = [];
    for (const name of ['lstatSync', 'statSync', 'realpathSync', 'readlinkSync']) {
      const original = fs[name];
      const tracked = (...args) => {
        if (String(args[0]).startsWith(process.env.FC_HOME_PARENT)) inspected.push([name, String(args[0])]);
        return original(...args);
      };
      Object.assign(tracked, original);
      fs[name] = tracked;
    }
    syncBuiltinESMExports();
    const store = await import('./src/store.ts');
    store.setFcGlobalDir(process.env.NEXT_FC_HOME);
    if (store.fcGlobalDir() !== process.env.NEXT_FC_HOME) throw new Error('configuration lost');
    console.log(JSON.stringify(inspected));
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FC_')));
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...env, FC_HOME: state, NEXT_FC_HOME: next, FC_HOME_PARENT: blocker },
    encoding: 'utf8', timeout: 15000,
  });
  expect(JSON.parse(output.trim())).toEqual([]);
});

it.each(['store', 'runs'].flatMap(route =>
  ['file', 'file-parent', 'permission', 'loop'].map(failure => ({ route, failure }))))(
  'refuses and records $failure resolving the configured $route at judgment time', ({ route, failure }) => {
    const bad = join(root, 'unresolvable');
    let target = bad;
    if (failure === 'file' || failure === 'file-parent') {
      writeFileSync(bad, 'ordinary file');
      if (failure === 'file-parent') target = join(bad, 'child');
    } else if (failure === 'loop') symlinkSync(bad, bad);
    else mkdirSync(bad);
    const state = route === 'store' ? target : join(root, 'broken-runs-store');
    if (route === 'runs') { mkdirSync(state); symlinkSync(target, join(state, 'runs')); }
    const candidate = join(project, 'ordinary-result'); writeFileSync(candidate, 'stage data');
    const directory = join(project, 'ordinary-directory'); mkdirSync(directory);
    const original = fs.lstatSync;
    fs.lstatSync = ((...args: Parameters<typeof original>) => {
      if (failure === 'permission' && String(args[0]) === bad) {
        throw Object.assign(new Error(`EACCES: permission denied, lstat '${bad}'`), { code: 'EACCES' });
      }
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      expect(() => setFcGlobalDir(state)).not.toThrow();
      const reason = failure === 'permission' ? 'EACCES' : failure === 'loop' ? 'SYMLINK_LOOP' : 'NOT_DIRECTORY';
      for (const [output, kind] of [[candidate, 'file'], [directory, 'directory']] as const) {
        let result: ReturnType<typeof findings> = [];
        expect(() => { result = findings(output, kind); }).not.toThrow();
        expect(result).toContainEqual(expect.objectContaining({
          code: 'artifact_contract', field: `artifact_contract.produces.project:${relative(project, output)}`,
          message: expect.stringContaining(reason),
        }));
      }
      expect(readFileSync(candidate, 'utf8')).toBe('stage data');
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  });
