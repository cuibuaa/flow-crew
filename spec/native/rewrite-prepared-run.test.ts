import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, executeOperation, type MainContext } from '../../dist-rewrite/ops/main.js';
import * as state from '../../dist-rewrite/records/state.js';
import * as pins from '../../dist-rewrite/records/pin.js';
import * as host from '../../dist-rewrite/host/process.js';
import * as evidence from '../../dist-rewrite/records/evidence.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import { openJournal, readEvents, readProjection } from '../../dist-rewrite/records/state.js';


// The public entry end to end, as an operator uses it. Every lifecycle action goes through `main`; the provider is a test-owned
// executable on PATH that never calls a model. Setup is where a run is recorded (brief bytes, declaration, options), so these
// tests change or delete the inputs setup read and check that nothing downstream notices.
let root: string, source: string, bin: string, context: Omit<MainContext, 'stdout' | 'stderr'>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const get = <T>(result: { ok: true; value: T } | { ok: false; kind: string; detail: string }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
};
async function invoke(...args: string[]) {
  let stdout = Buffer.alloc(0), stderr = '';
  const exit = await main(args, { ...context, stdout: async bytes => { stdout = Buffer.concat([stdout, bytes]); },
    stderr: async bytes => { stderr += Buffer.from(bytes).toString(); } });
  return { exit, stdout, stderr, json: () => JSON.parse(stdout.toString()) };
}

// A brief a Windows editor wrote: BOM, CRLF line endings, YAML-free JSON frontmatter, and a Next.js route path that is a glob if read as one.
const route = 'app/[id]/page.tsx';
const declaration = { criteria: [{ id: 'delivered', text: 'The page is rewritten.' }],
  inputs: [{ id: 'page', path: route, kind: 'file', frozen: false }], outputs: [{ path: route, kind: 'file', existing: 'update' }],
  commands: [], results: [], allowBlocked: false };
const briefBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(('---\n' + JSON.stringify(declaration) + '\n---\n# Rewrite the page\nKeep it short.\n').replaceAll('\n', '\r\n'))]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fc-prepared-'));
  source = join(root, 'project'); bin = join(root, 'bin');
  await mkdir(join(source, 'app', '[id]'), { recursive: true }); await mkdir(join(source, 'app', 'd'));
  await mkdir(bin);
  await writeFile(join(source, route), 'original page\n'); await writeFile(join(source, 'app', 'd', 'page.tsx'), 'sibling a glob would match\n');
  await writeFile(join(root, 'brief.md'), briefBytes);
  await writeFile(join(root, 'config.json'), JSON.stringify({ roles: ['plan', 'work', 'gate'].map(id => ({ id, description: id,
    prompt: 'Return ' + id, backend: 'claude', model: 'synthetic', effort: 'low' })) }));
  await cp(new URL('./fixtures/provider-protocol.mjs', import.meta.url), join(bin, 'provider-protocol.mjs'));
  await writeFile(join(bin, 'package.json'), '{"type":"module"}\n');
  // Author: rewrite the route file and say so; gate: wait to be cancelled. No model is ever called.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
import { providerProtocol, nativePrompt } from './provider-protocol.mjs';
await providerProtocol('claude', async message => {
  const prompt = nativePrompt('claude', message);
  if (prompt.kind === 'gate') { fs.writeFileSync(${JSON.stringify(join(root, 'gate-reached'))}, 'yes'); await new Promise(() => {}); }
  fs.writeFileSync(${JSON.stringify(route)}, 'rewritten page\\n');
  fs.writeFileSync('app/d/page.tsx', 'changed sibling\\n'); // not declared: only a pattern reading of the route path would take it
  const answer = { status: 'delivered', summary: 'Rewrote the page', caveats: [], remainingWork: [], blocks: null };
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { kind: prompt.kind, answer },
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0 }));
});
`, { mode: 0o755 });
  context = { cwd: source, storeRoot: join(root, 'store'), home: join(root, 'state'), runtimeRoot: resolve(import.meta.dirname, '../..'),
    environment: { PATH: bin + ':' + process.env.PATH!, HOME: join(root, 'home'), NODE_NO_WARNINGS: '1' }, stdin: new Uint8Array(),
    abort: new AbortController().signal };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

// Real public entry: invalid operands must not bootstrap even the state database.
function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [join(context.runtimeRoot, 'dist-rewrite', 'cli.js'), ...args], {
    cwd: context.cwd, env: { ...context.environment, TMPDIR: root, FC_HOME: context.home,
      FLOWCREW_STORE_ROOT: context.storeRoot }, encoding: 'utf8'
  });
  console.log(JSON.stringify({ command: ['node', '$ENGINE/dist-rewrite/cli.js', ...args.map(arg => arg.replaceAll(root, '$CASE'))],
    cwd: context.cwd.replaceAll(root, '$CASE'), exit: result.status, stderr: result.stderr.replaceAll(root, '$CASE') }));
  return result;
}

it.each(['project', 'project-file', 'brief', 'config', 'relative-input', 'absolute-input', 'update-output', 'append-output'] as const)(
  'round 9 invalid operand %s is refused before the first write', async operand => {
    const metadata = structuredClone(declaration);
    const args = ['setup', join(root, 'brief.md'), '--config', join(root, 'config.json')];
    if (operand === 'project' || operand === 'project-file') { metadata.inputs = []; metadata.outputs = []; }
    if (operand === 'project') args.push('--project', join(root, 'missing'));
    if (operand === 'project-file') args.push('--project', join(root, 'brief.md'));
    if (operand === 'brief') args[1] = join(root, 'missing.md');
    if (operand === 'config') args[3] = join(root, 'missing.json');
    if (operand === 'relative-input') metadata.inputs[0].path = 'missing.txt';
    if (operand === 'absolute-input') metadata.inputs[0].path = join(root, 'missing.txt');
    if (operand === 'update-output' || operand === 'append-output') {
      metadata.inputs = []; metadata.outputs[0].path = 'missing.txt';
      if (operand === 'append-output') metadata.outputs[0].existing = 'append';
    }
    await writeFile(join(root, 'brief.md'), '---\n' + JSON.stringify(metadata) + '\n---\nInvalid operand.');
    const result = cli(...args);
    expect(result.status, result.stderr + result.stdout).toBe(2);
    expect(existsSync(context.storeRoot), 'invalid operand created a store').toBe(false);
    expect(existsSync(context.home), 'invalid operand created a database directory').toBe(false);
  });

it('refuses an overlapping source and future target before creating a store or state', async () => {
  context.storeRoot = join(source, 'nested-store');
  const result = cli('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain('Source and target overlap');
  expect(existsSync(context.storeRoot)).toBe(false);
  expect(existsSync(context.home)).toBe(false);
});

it('monorepo root refuses absent declared paths; the selected subdirectory needs no git', async () => {
  const metadata = { ...declaration, inputs: [{ ...declaration.inputs[0], path: 'src/app.txt' }],
    outputs: [{ ...declaration.outputs[0], path: 'src/app.txt' }] };
  const mono = join(root, 'mono'), web = join(mono, 'pkgs', 'web');
  await mkdir(join(web, 'src'), { recursive: true }); await writeFile(join(web, 'src', 'app.txt'), 'original');
  await writeFile(join(root, 'brief.md'), '---\n' + JSON.stringify(metadata) + '\n---\nSelected root.');
  context = { ...context, cwd: mono };
  const invalid = cli('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(invalid.status, invalid.stderr + invalid.stdout).toBe(2);
  expect(existsSync(context.storeRoot), 'monorepo root created a store').toBe(false);
  expect(existsSync(context.home), 'monorepo root created a database directory').toBe(false);
  context = { ...context, cwd: web };
  const valid = cli('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(valid.status, valid.stderr + valid.stdout).toBe(0);
  const run = JSON.parse(valid.stdout).run;
  expect((await invoke('status', run)).json().sourceProject).toBe(web);
  expect(await readFile(join(context.storeRoot, 'work', run, 'project', 'src', 'app.txt'), 'utf8')).toBe('original');
  expect(existsSync(join(context.storeRoot, 'work', run, 'project', 'pkgs'))).toBe(false);
  await reclaimed(run);
}, 120_000);

it('setup records the run; status shows its digest and project; the brief prints back byte for byte; a never-started run is cancelled and landed', async () => {
  const prepared = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(prepared.exit, prepared.stderr).toBe(0);
  const { run, briefDigest, project, commands } = prepared.json();
  expect(run).toMatch(/^run_/); expect(briefDigest).toBe(sha(briefBytes)); expect(project).toBe(source); expect(commands).toEqual([]);
  // The record exists and nothing started: no activation, no start intent.
  const journal = get(await openJournal({ database: join(context.home, 'state.sqlite'), storeRoot: context.storeRoot, run }, 'read'));
  const events = get(await readEvents(journal, 0)).map(event => event.payload.type);
  expect(events).toContain('admitted'); expect(events).not.toContain('control_intent');
  expect(events.filter(type => type === 'setup_prepared')).toHaveLength(1);
  const status = (await invoke('status', run)).json();
  expect(status).toMatchObject({ status: 'pending', briefDigest, sourceProject: source, title: 'Rewrite the page' });
  expect((await invoke('status', run, '--brief')).stdout).toEqual(briefBytes);
  // The run is cancelled and landed with the existing controls; its delivery holds the unchanged route file and an empty patch.
  expect((await invoke('start', run, '--config', join(root, 'config.json'))).exit).toBe(2);
  const cancelled = await invoke('cancel', run); expect(cancelled.exit, cancelled.stderr).toBe(0);
  expect((await invoke('status', run)).json()).toMatchObject({ status: 'cancelled', briefDigest });
  const started = await invoke('start', run); expect(started.exit).toBe(1);
  expect(JSON.parse(started.stderr.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'conflict', detail: 'Terminal or cancelled runs cannot be started or resumed' });
  const landed = await invoke('land', run); expect(landed.exit, landed.stderr).toBe(0);
  const delivery = landed.json().delivery;
  expect(await readFile(join(delivery, 'project', route), 'utf8')).toBe('original page\n');
  expect((await stat(join(delivery, 'changes.patch'))).size).toBe(0);
  // The digest and source project outlive land; the brief bytes do not, and the command says so rather than failing.
  expect((await invoke('status', run)).json()).toMatchObject({ briefDigest, sourceProject: source });
  const gone = await invoke('status', run, '--brief'); expect(gone.exit).toBe(1);
  await expect(access(join(context.storeRoot, 'pins', run))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(source, route), 'utf8')).toBe('original page\n');
}, 120_000);

it.each(['immediate', 'stopped executor', 'killed controller'])('round 10 %s cancel confirms closure before land reclaims pin and work', async mode => {
  const setup = cli('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(setup.status, setup.stderr).toBe(0);
  const run = JSON.parse(setup.stdout).run;
  let reclaimed = false, executor: {pid:number;start:string;boot:string;group:number} | undefined;
  try {
    const start = cli('start', run); expect(start.status, start.stderr).toBe(0);
    if (mode === 'stopped executor') {
      while (!existsSync(join(root, 'gate-reached'))) await new Promise(done => setTimeout(done, 10));
      const journal = get(await openJournal({database:join(context.home, 'state.sqlite'),storeRoot:context.storeRoot,run}, 'read'));
      const ownership = get(await readEvents(journal, 0)).findLast(event => event.payload.type === 'ownership');
      if (ownership?.payload.type !== 'ownership') throw Error('No recorded executor');
      executor = ownership.payload.owner;
      process.kill(executor.pid, 'SIGSTOP');
    }
    if (mode === 'killed controller') {
      const owner = JSON.parse(start.stdout).operation.observation.owner;
      const lock = new DatabaseSync(join(context.storeRoot, 'runs', run, 'controller.sqlite'));
      try { expect(() => lock.exec('BEGIN EXCLUSIVE')).toThrow(/locked/); } finally { lock.close(); }
      process.kill(owner.pid, 'SIGKILL');
      const released = performance.now(), waiter = new DatabaseSync(join(context.storeRoot,'runs',run,'controller.sqlite'),{readOnly:true});
      try { waiter.exec(`PRAGMA busy_timeout=${host.CLOSURE_RUNAWAY_MS}; SELECT count(*) FROM sqlite_master`); } finally {waiter.close();}
      console.log(JSON.stringify({measurement:'SIGKILL-to-lock-release',ms:performance.now()-released}));
    }
    const started = performance.now();
    const cancel = cli('cancel', run);
    console.log(JSON.stringify({ measurement: mode + '-cancel', ms: performance.now() - started, exit: cancel.status }));
    expect(cancel.status, cancel.stderr + cancel.stdout).toBe(0);
    expect(JSON.parse(cancel.stdout).observation.state).toBe('inactive');
    const bytes = await readFile(join(context.storeRoot, 'work', run, 'project', route));
    const land = cli('land', run); expect(land.status, land.stderr + land.stdout).toBe(0);
    reclaimed = true;
    const repeated = cli('land', run); expect(repeated.status, repeated.stderr + repeated.stdout).toBe(0);
    expect(JSON.parse(repeated.stdout).state).toBe('reclaimed');
    expect(existsSync(join(context.storeRoot, 'runs', run, 'controller.sqlite'))).toBe(true);
    expect(await readFile(join(JSON.parse(land.stdout).delivery, 'project', route))).toEqual(bytes);
    for (const directory of ['pins', 'work']) expect(existsSync(join(context.storeRoot, directory, run))).toBe(false);
    expect(await readFile(join(source, route), 'utf8')).toBe('original page\n');
  } finally {
    if (executor) try { process.kill(executor.pid, 'SIGCONT'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (!reclaimed) {
      // A failed wait mutation must still close this test's controller before fixture removal.
      cli('cancel', run);
      const owner = JSON.parse(cli('status', run).stdout).host.activation.owner;
      while (owner && await host.observeController(owner) === 'active') await new Promise(done => setTimeout(done, 20));
      cli('cancel', run); cli('land', run);
    }
  }
}, 120_000);

it('cancel waits for a controller paused before final writes and land retains its receipts and accounting', async () => {
  const setup = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(setup.exit, setup.stderr).toBe(0);
  const run = setup.json().run;
  const start = await invoke('start', run); expect(start.exit, start.stderr).toBe(0);
  const controller = start.json().operation.observation.owner;
  const journal = get(await openJournal({database:join(context.home,'state.sqlite'),storeRoot:context.storeRoot,run},'read'));
  let cancelled: Promise<number | null> | undefined;
  try {
    while (!existsSync(join(root,'gate-reached'))) await new Promise(done=>setTimeout(done,10));
    expect(await host.observeController(controller)).toBe('active');
    // Pause between journal writes, so the test does not freeze SQLite's global writer itself.
    const barrier = new DatabaseSync(journal.database);
    try {
      barrier.exec(`PRAGMA busy_timeout=${host.CLOSURE_RUNAWAY_MS}; BEGIN IMMEDIATE`);
      process.kill(controller.pid,'SIGSTOP');
      barrier.exec('ROLLBACK');
    } finally { barrier.close(); }
    const before = get(await readProjection(journal));
    expect(before.received.length).toBeGreaterThan(0);
    const waiting = join(root,'cancel-lock-wait');
    const child = spawn(process.execPath,['--import',new URL('./fixtures/sqlite-wait.mjs',import.meta.url).pathname,
      join(context.runtimeRoot,'dist-rewrite','cli.js'),'cancel',run],{cwd:source,
      env:{...context.environment,TMPDIR:root,FC_HOME:context.home,FLOWCREW_STORE_ROOT:context.storeRoot,FC_WAIT_OBSERVATION:waiting},
      stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',done=false;
    child.stdout.on('data',bytes=>stdout+=bytes); child.stderr.on('data',bytes=>stderr+=bytes);
    cancelled = new Promise(resolve=>child.once('exit',code=>{done=true;resolve(code);}));
    while(!existsSync(waiting)) { if(done)throw Error(stderr+stdout); await new Promise(done=>setTimeout(done,10)); }
    expect(done).toBe(false);
    expect(get(await readProjection(journal)).status).toBe('cancelled');
    expect(existsSync(waiting+'.returned')).toBe(false);
    expect(await host.observeController(controller)).toBe('active');
    process.kill(controller.pid,'SIGCONT');
    expect(await cancelled,stderr+stdout).toBe(0);
    const ended = get(await readProjection(journal));
    expect((await invoke('status',run)).json().heldBytes).toBeGreaterThan(0);
    expect(ended.received.slice(0,before.received.length)).toEqual(before.received);
    expect(ended.intervals.length).toBeGreaterThan(0);
    expect(ended.intervals.every(interval=>interval.spentMs!==null)).toBe(true);
    const landed = await invoke('land',run); expect(landed.exit,landed.stderr).toBe(0);
    const after = get(await readProjection(journal));
    for(const key of ['attempts','received','commands','intervals'] as const)expect(after[key]).toEqual(ended[key]);
    expect((await invoke('status',run)).json().heldBytes).toBeUndefined();
  } finally {
    if(await host.observeController(controller)==='active')process.kill(controller.pid,'SIGCONT');
    if(cancelled)await cancelled;
    await invoke('cancel',run); await invoke('land',run);
  }
},120_000);

it('land waits for a completed controller final flush without signals or receipt loss', async () => {
  localEntry();
  const startRun = host.startRun;
  vi.spyOn(host, 'startRun').mockImplementation((run, entry, ...args) => startRun(run, { ...entry,
    argv: [entry.argv[0], new URL('./fixtures/controller-flush.mjs', import.meta.url).pathname,
      entry.argv[1], root, ...entry.argv.slice(2)] }, ...args));
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
import {providerProtocol,nativePrompt} from './provider-protocol.mjs';
await providerProtocol('claude', async message => {
 const {kind}=nativePrompt('claude',message);
 if(kind==='work')fs.writeFileSync(${JSON.stringify(route)},'completed delivery\\n');
 const answer=kind==='gate'?{outcome:'accepted',reason:'Observed',criteria:{delivered:{status:'pass',evidence:'file and command'}},findings:[],remainingWork:[]}
 :{status:'delivered',summary:'Delivered',caveats:[],remainingWork:[],blocks:null};
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{kind,answer},
 usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0},total_cost_usd:0}));
});
`, {mode:0o755});
  const metadata = {...declaration, commands:[{id:'Proof', argv:[process.execPath,'-e',"process.stdout.write('command receipt')"],
    env:{}, inputs:[], required:true, unconfined:true}]};
  await writeFile(join(root,'brief.md'),'---\n'+JSON.stringify(metadata)+'\n---\nDeliver reviewed bytes.\n');
  const setup = await invoke('setup',join(root,'brief.md'),'--config',join(root,'config.json'));
  expect(setup.exit,setup.stderr).toBe(0);
  const run = setup.json().run;
  let controller: any, landed: Promise<number | null> | undefined, db: DatabaseSync | undefined;
  const release = join(root,'finish-flush');
  try {
    const start = await invoke('start',run); expect(start.exit,start.stderr).toBe(0);
    controller = start.json().operation.observation.owner;
    while (!existsSync(join(root,'flushing'))) await new Promise(done=>setTimeout(done,10));
    const location = {database:join(context.home,'state.sqlite'),storeRoot:context.storeRoot,run};
    const journal = get(await openJournal(location,'read')), before = get(await readProjection(journal)), history = get(await readEvents(journal,0));
    expect(before.status).toBe('complete');
    expect((await invoke('status',run)).json().heldBytes).toBeGreaterThan(0);
    for (const rows of [before.attempts,before.received,before.commands,before.intervals]) expect(rows.length).toBeGreaterThan(0);
    expect(before.intervals.every(interval=>interval.spentMs!==null)).toBe(true);
    db = new DatabaseSync(location.database);
    const held = () => db!.prepare('SELECT * FROM resources WHERE owner IS NOT NULL ORDER BY id').all();
    let stdout='',stderr='',done=false;
    const waiting = join(root,'lock-wait');
    const child = spawn(process.execPath,['--import',new URL('./fixtures/sqlite-wait.mjs',import.meta.url).pathname,
      join(context.runtimeRoot,'dist-rewrite','cli.js'),'land',run],{cwd:source,
      env:{...context.environment,TMPDIR:root,FC_HOME:context.home,FLOWCREW_STORE_ROOT:context.storeRoot,FC_WAIT_OBSERVATION:waiting},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>stdout+=bytes); child.stderr.on('data',bytes=>stderr+=bytes);
    landed = new Promise(resolve=>child.once('exit',code=>{done=true;resolve(code);}));
    while (!existsSync(waiting)) {
      if(done) throw Error('land did not wait on the controller lock: '+stderr+stdout);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await new Promise(resolve=>setTimeout(resolve,100)); expect(done).toBe(false);
    expect(existsSync(waiting+'.returned')).toBe(false);
    await writeFile(release,'finish');
    expect(await landed,stderr+stdout).toBe(0); expect(JSON.parse(stdout).state).toBe('reclaimed');
    const after = get(await readProjection(journal));
    for (const key of ['attempts','received','commands','intervals'] as const) expect(after[key]).toEqual(before[key]);
    expect(get(await readEvents(journal,0)).slice(0,history.length)).toEqual(history);
    expect(held()).toEqual([]);
    expect(existsSync(join(root,'flushed'))).toBe(true); expect(existsSync(join(root,'signalled'))).toBe(false);
    expect(await readFile(join(context.storeRoot,'deliveries',run,'project',route),'utf8')).toBe('completed delivery\n');
  } finally {
    await writeFile(release,'finish'); if(landed)await landed; db?.close();
    if(controller)while(await host.observeController(controller)==='active')await new Promise(done=>setTimeout(done,10));
    await invoke('cancel',run); await invoke('land',run);
  }
},120_000);

it('start launches the recorded run, not the files setup read: the brief is deleted and the config replaced first; land preserves its delivery', async () => {
  const prepared = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'), '--requester', 'frontend:session_1');
  expect(prepared.exit, prepared.stderr).toBe(0);
  const { run, briefDigest } = prepared.json();
  await rm(join(root, 'brief.md')); await writeFile(join(root, 'config.json'), '{ not json');
  await writeFile(join(source, route), 'the project moved on\n');
  const started = await invoke('start', run);
  expect(started.exit, started.stderr).toBe(0);
  expect(started.json()).toMatchObject({ run, briefDigest, operation: { state: 'acknowledged' } });
  // Launched once: a second start is a conflict, and the control for a started run is resume.
  const again = await invoke('start', run); expect(again.exit).toBe(1);
  const location = { database: join(context.home, 'state.sqlite'), storeRoot: context.storeRoot, run };
  const journal = get(await openJournal(location, 'read'));
  const projection = get(await readProjection(journal));
  expect(projection.launch).toMatchObject({ requester: 'frontend:session_1', backend: 'claude' });
  expect(projection.brief.digest).toBe(briefDigest);
  expect(projection.intents.filter(intent => intent.kind === 'start')).toHaveLength(1);
  expect((await invoke('status', run)).json()).toMatchObject({ requester: 'frontend:session_1', briefDigest });
  const until = async (probe: () => Promise<boolean>) => { for (let waited = 0; !await probe(); waited += 50) {
    if (waited > 90_000) throw new Error('timed out'); await new Promise(done => setTimeout(done, 50)); } };
  await until(() => access(join(root, 'gate-reached')).then(() => true, () => false));
  expect([0, 3]).toContain((await invoke('cancel', run)).exit);
  let landed = await invoke('land', run);
  await until(async () => (landed = await invoke('land', run)).exit === 0);
  const delivery = landed.json().delivery;
  expect(await readFile(join(delivery, 'project', route), 'utf8')).toBe('rewritten page\n');
  const patch = await readFile(join(delivery, 'changes.patch'), 'utf8');
  expect(patch).toContain('rewritten page'); expect(patch).not.toContain('changed sibling');
}, 26 * 60_000);

// Syntax and config-role failures precede the record; project admission is decided later on the copy.
it('a setup refused by admission leaves nothing behind: the fixed graph needs the roles work and gate', async () => {
  await writeFile(join(root, 'noroles.json'), JSON.stringify({ roles: [{ id: 'plan', description: 'plan', prompt: 'Return plan',
    backend: 'claude', model: 'synthetic', effort: 'low' }] }));
  const refused = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'noroles.json'));
  expect(refused.exit, refused.stderr).toBe(2);
  expect(JSON.parse(refused.stderr.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'invalid', detail: expect.stringContaining('Unknown role id') });
  await expect(access(context.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(context.home)).rejects.toMatchObject({ code: 'ENOENT' });
});

// Snapshot the durable outcome, independent of which API, process or storage engine wrote it.
async function durable() {
  const files: Record<string, unknown> = {};
  const walk = async (path: string) => {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!info) return;
    files[path.slice(root.length)] = info.isDirectory() ? 'directory' : { mode: info.mode, bytes: sha(await readFile(path)) };
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  };
  await walk(context.storeRoot); await walk(context.home);
  return files;
}
function localEntry() {
  const perform = host.performOperation;
  return vi.spyOn(host, 'performOperation').mockImplementation(request => request.method === 'executeOperation'
    ? executeOperation(...request.args as [readonly string[], MainContext]) : perform(request));
}

it('failed evidence initialization follows the committed row and remains publicly reclaimable', async () => {
  localEntry();
  const initialize = evidence.initializeEvidence;
  vi.spyOn(evidence, 'initializeEvidence').mockImplementation(async journal => {
    const db = new DatabaseSync(journal.database);
    try {
      expect(db.prepare('SELECT root FROM runs WHERE root=?').get(journal.root)).toEqual({ root: journal.root });
      db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    } finally { db.close(); }
    await initialize(journal);
    throw Error('Evidence initialization interrupted');
  });
  const failed = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  vi.restoreAllMocks();
  // An untyped exception after confirmed creation is unknown (exit 3); its committed receipt survives.
  expect(failed.exit, failed.stderr).toBe(3);
  expect(failed.json()).toMatchObject({ kind: 'unknown', effects: 'setup' });
  const { run } = failed.json();
  expect((await invoke('status', run)).json()).toMatchObject({ run, status: 'refused',
    preparationReason: expect.stringContaining('Evidence initialization interrupted') });
  const before = await durable();
  expect((await invoke('status')).json()).toEqual([expect.objectContaining({ ok: true, value: expect.objectContaining({ run }) })]);
  expect(await durable(), 'status preserves durable bytes').toEqual(before);
  await reclaimed(run);
  expect(await readdir(join(context.storeRoot, 'runs', run))).toEqual(['status.json']);
});

it('kind, digest, outputs and dependencies use the imported copy when the source changes', async () => {
    localEntry();
    const metadata = { ...declaration, inputs: [
      { id: 'kind', path: 'kind.txt', kind: 'file', frozen: true },
      { id: 'digest', path: 'digest.txt', kind: 'file', frozen: true, sha256: sha(Buffer.from('copied digest')) }
    ], outputs: [{ path: 'output.txt', kind: 'file', existing: 'update' }],
      commands: [{ id: 'check', argv: ['/bin/true'], env: {}, inputs: [], required: false, dependsOn: ['deps/config'] }] };
    for (const [path, bytes] of [['kind.txt', 'copied kind'], ['digest.txt', 'copied digest'], ['output.txt', 'copied output']])
      await writeFile(join(source, path), bytes);
    await mkdir(join(source, 'deps')); await writeFile(join(source, 'deps', 'config'), 'copied dependency');
    await writeFile(join(root, 'brief.md'), '---\n' + JSON.stringify(metadata) + '\n---\nCopy decides.');
    // Idempotent so a duplicate admission reaches the assertion, never an rm/EISDIR error.
    const changeLive = async () => {
      await rm(join(source, 'kind.txt'), { recursive: true, force: true }); await mkdir(join(source, 'kind.txt'));
      await writeFile(join(source, 'digest.txt'), 'live digest');
      await rm(join(source, 'output.txt'), { recursive: true, force: true }); await mkdir(join(source, 'output.txt'));
      await rm(join(source, 'deps'), { recursive: true, force: true }); await symlink(join(source, 'app'), join(source, 'deps'));
    };
    const operation = state.recordOperation;
    vi.spyOn(state, 'recordOperation').mockImplementation(async (...args) => {
      const result = await operation(...args);
      if (args[2].method === 'importTask') { get(result); await changeLive(); }
      return result;
    });
    const prepared = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'), '--requester', 'opaque identity with spaces');
    expect(prepared.exit, prepared.stderr).toBe(0);
    vi.restoreAllMocks();
    const run = prepared.json().run;
    const journal = get(await openJournal({ database: join(context.home, 'state.sqlite'), storeRoot: context.storeRoot, run }, 'read'));
    const projection = get(await readProjection(journal)), copy = projection.launch.project;
    for (const [path, bytes] of [['kind.txt', 'copied kind'], ['digest.txt', 'copied digest'], ['output.txt', 'copied output'], ['deps/config', 'copied dependency']])
      expect(await readFile(join(copy, path), 'utf8')).toBe(bytes);
    expect(projection.launch.setup.inputs).toHaveLength(2);
    for (const [index, baseline] of projection.launch.setup.inputs.entries()) {
      const manifest = JSON.parse(Buffer.from(get(await readEvidence(journal, baseline))).toString());
      expect(manifest).toMatchObject({ path: metadata.inputs[index].path, snapshot: { kind: 'file',
        sha256: sha(Buffer.from(index === 0 ? 'copied kind' : 'copied digest')) } });
    }
    expect((await lstat(join(source, 'kind.txt'))).isDirectory()).toBe(true);
    expect(await readFile(join(source, 'digest.txt'), 'utf8')).toBe('live digest');
    expect((await lstat(join(source, 'output.txt'))).isDirectory()).toBe(true);
    expect((await lstat(join(source, 'deps'))).isSymbolicLink()).toBe(true);
    const before = await durable();
    expect((await invoke('status', run)).json()).toMatchObject({ status: 'pending', requester: 'opaque identity with spaces' });
    expect((await invoke('status', run, '--brief')).exit).toBe(0);
    expect(await durable(), 'status and brief inspection must be read-only').toEqual(before);
    await reclaimed(run);
    expect(await readFile(join(context.storeRoot, 'deliveries', run, 'project', 'output.txt'), 'utf8')).toBe('copied output');
  }, 26 * 60_000);

async function reclaimed(run: string) {
  const listed = await invoke('status'); expect(listed.exit, listed.stderr).toBe(0);
  expect(listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, value: expect.objectContaining({ run }) })]));
  for (const command of ['cancel', 'land']) {
    const result = await invoke(command, run); expect(result.exit, result.stderr).toBe(0);
  }
  for (const directory of ['pins', 'work']) await expect(access(join(context.storeRoot, directory, run))).rejects.toMatchObject({ code: 'ENOENT' });
  const rows = state.withState(join(context.home, 'state.sqlite'), false, db => ({ ok: true, value: db.prepare('SELECT id FROM resources WHERE holder=?').all(join(context.storeRoot, 'runs', run)) }));
  expect(get(rows)).toEqual([]);
}

it('copy admission records a digest refusal and leaves a publicly reclaimable run', async () => {
  const metadata = { ...declaration, inputs: [{ ...declaration.inputs[0], sha256: sha(Buffer.from('other')) }] };
  await writeFile(join(root, 'brief.md'), '---\n' + JSON.stringify(metadata) + '\n---\nRefused copy.');
  const result = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(result.exit, result.stderr).toBe(2);
  const { run } = result.json();
  expect((await invoke('status', run)).json()).toMatchObject({ status: 'refused', preparationReason: expect.any(String), run });
  for (const command of ['start', 'resume', 'guide']) expect((await invoke(command, run, ...(command === 'guide' ? ['fix it'] : []))).exit).toBe(1);
  await reclaimed(run);
});

it('a failure during pinning is already listed, refused and reclaimable without a valid pin', async () => {
  const pin = vi.spyOn(pins, 'pinRuntime').mockImplementation(async (_source, store, run) => {
    const journal = get(await openJournal({ database: join(context.home, 'state.sqlite'), storeRoot: store, run }, 'read'));
    expect(get(state.readPreparation(journal))).toMatchObject({ status: 'preparing' });
    // Include a partial pin to reproduce the gap before the former openJournal call.
    await mkdir(join(store, 'pins', run), { recursive: true }); await writeFile(join(store, 'pins', run, 'partial'), 'partial');
    return { ok: false, kind: 'unknown', detail: 'Synthetic pin failure' };
  });
  let result;
  try { result = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json')); }
  finally { pin.mockRestore(); }
  expect(result.exit, result.stderr).toBe(3);
  const { run } = result.json();
  const status = await invoke('status', run); expect(status.exit, status.stderr).toBe(0);
  expect(status.json()).toMatchObject({ status: 'refused', preparationReason: 'Synthetic pin failure' });
  await reclaimed(run);
}, 120_000);

it('an output collision names the holder; reclaiming the refused run preserves the holder bytes', async () => {
  const output = join(root, 'external.txt'); await writeFile(output, 'holder bytes');
  const metadata = { ...declaration, inputs: [], outputs: [{ path: output, kind: 'file', existing: 'replace' }] };
  await writeFile(join(root, 'brief.md'), '---\n' + JSON.stringify(metadata) + '\n---\nOutput collision.');
  const args = ['setup', join(root, 'brief.md'), '--config', join(root, 'config.json')];
  const holder = await invoke(...args); expect(holder.exit, holder.stderr).toBe(0);
  const result = await invoke(...args); expect(result.exit, result.stderr).toBe(1);
  const run = result.json().run;
  expect((await invoke('status', run)).json()).toMatchObject({ status: 'refused', preparationReason: expect.stringContaining(holder.json().run) });
  expect(await readFile(join(context.storeRoot, 'work', run, 'project', route), 'utf8')).toBe('original page\n');
  expect((await invoke('land', run)).exit).toBe(0);
  await reclaimed(run);
  expect(await readFile(output, 'utf8')).toBe('holder bytes');
  await reclaimed(holder.json().run);
  expect(await readFile(output, 'utf8')).toBe('holder bytes');
}, 26 * 60_000);

// Import failures occur before copy admission and still have a record owner.
it('an importer failure is listed and publicly reclaimed', async () => {
  if (process.getuid?.() === 0) return;
  await chmod(join(source, 'app', 'd', 'page.tsx'), 0);
  try {
    const failed = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
    expect(failed.exit, failed.stderr).toBe(3);
    const run = failed.json().run;
    expect((await invoke('status', run)).json()).toMatchObject({ status: 'refused', run });
    await reclaimed(run);
  } finally { await chmod(join(source, 'app', 'd', 'page.tsx'), 0o644); }
}, 26 * 60_000);

// A mistyped run id is an invalid operand before any recorded effect.
it.each([['status'], ['status', '--brief'], ['cancel'], ['land'], ['start'], ['resume']].map(extra => ({ extra })))(
  'a mistyped run id for $extra is invalid and writes nothing', async ({ extra }) => {
    const [command, ...options] = extra;
    const result = await invoke(command, 'run_mistyped', ...options);
    expect(result.exit, result.stderr).toBe(2);
    expect(JSON.parse(result.stderr.trim().split('\n').at(-1)!)).toMatchObject({ ok: false, kind: 'invalid' });
    await expect(access(context.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(context.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

it('an interrupted preparing owner is listed with its directory and cancel/land reclaim it without a pin', async () => {
  const { parseBrief } = await import('../../dist-rewrite/contract/brief.js');
  const run = 'run_interrupted';
  // A real child creates the journal and exits without admitting or refusing it.
  const module = new URL('../../dist-rewrite/records/state.js', import.meta.url).href;
  const identityModule = new URL('../../dist-rewrite/host/identity.mjs', import.meta.url).href;
  const payload = { project: source, authority: 'interrupted', brief: { bytes: { path: 'git/objects/' + 'a'.repeat(40), sha256: sha(briefBytes) },
    digest: sha(briefBytes), declaration: get(parseBrief(briefBytes)) } };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { createPreparation } from ${JSON.stringify(module)};
import { ownIdentity } from ${JSON.stringify(identityModule)};
const result = await createPreparation(${JSON.stringify({ database: join(context.home, 'state.sqlite'), storeRoot: context.storeRoot, run })},
  { ...${JSON.stringify(payload)}, owner: await ownIdentity() });
if (!result.ok) { console.error(result); process.exit(1); }
`], { env: { PATH: process.env.PATH!, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  // A committed record always has its directory, even if setup never pins or admits.
  expect((await stat(join(context.storeRoot, 'runs', run))).isDirectory()).toBe(true);
  const list = await invoke('status'); expect(list.exit, list.stderr).toBe(0);
  expect(list.json()).toEqual([expect.objectContaining({ ok: true, value: expect.objectContaining({ run, status: 'preparing' }) })]);
  const status = await invoke('status', run); expect(status.exit, status.stderr).toBe(0);
  expect(status.json()).toMatchObject({ status: 'preparing', run });
  await reclaimed(run);
}, 120_000);


it('setup accepts an explicit opaque requester and discloses the execution boundary once', async () => {
  const admitted = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'), '--requester=--x');
  expect(admitted.exit, admitted.stderr).toBe(0);
  expect(admitted.json().executionBoundary).toContain('All authors/providers/commands run with host-account rights.');
  expect(admitted.stdout.toString().split(admitted.json().executionBoundary)).toHaveLength(2);
  const status = (await invoke('status', admitted.json().run)).json();
  expect(status.requester).toBe('--x');
  const run = admitted.json().run;
  const journal = get(await openJournal({ database: join(context.home, 'state.sqlite'), storeRoot: context.storeRoot, run }, 'read'));
  const before = get(await readEvents(journal, 0)), marker = join(root, 'loaded-mutated-pin');
  const entry = join(context.storeRoot, 'pins', run, 'ops', 'main.js');
  const original = await readFile(entry, 'utf8');
  await chmod(entry, 0o644);
  await writeFile(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'loaded');\n` + original);
  const refused = await invoke('start', run);
  expect(refused.exit, refused.stderr).toBe(3);
  expect(existsSync(marker), 'a later operation verifies before importing the pin').toBe(false);
  expect(get(await readEvents(journal, 0))).toEqual(before);
  await reclaimed(admitted.json().run);
}, 120_000);

it('creation boundary reports prerequisites, uncertain INSERT and invocation-relative conflicts',async()=>{
  const {parseBrief}=await import('../../dist-rewrite/contract/brief.js');
  const prep={project:source,authority:'creation-phase',owner:await host.ownIdentity(),brief:{
    bytes:evidence.identifyEvidence(briefBytes),digest:sha(briefBytes),declaration:get(parseBrief(briefBytes))}};
  const location={database:join(context.home,'state.sqlite'),storeRoot:context.storeRoot,run:'Creation'};
  expect(await state.createPreparation({...location,database:'relative'},prep)).toMatchObject({ok:false,creation:{state:'not_attempted'}});
  await writeFile(context.home,'Occupied parent');
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:false,creation:{state:'not_attempted'}});
  await rm(context.home); await mkdir(context.home);
  await symlink(join(root,'brief.md'),location.database);
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:false,creation:{state:'not_attempted'}}); await rm(location.database);
  await writeFile(context.storeRoot,'Occupied store root');
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:false,creation:{state:'not_attempted'}});
  expect(get(state.withState(location.database,false,db=>({ok:true,value:db.prepare('SELECT root FROM runs').all()})))).toEqual([]);
  await rm(context.storeRoot);
  const uncertain={...location,run:'Unsettled'},prepare=DatabaseSync.prototype.prepare,execute=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;
  let connection:DatabaseSync|undefined;
  const statement=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(sql){
    const value=prepare.call(this,sql),db=this;
    return sql.startsWith('INSERT INTO runs')?{run(...args:never[]){value.run(...args);connection=db;throw Object.assign(Error('INSERT response lost'),{errcode:5});}} as never:value;
  });
  const rollback=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(sql){if(this===connection&&sql==='ROLLBACK')throw Error('Rollback unconfirmed');return execute.call(this,sql);});
  const closing=vi.spyOn(DatabaseSync.prototype,'close').mockImplementation(function(){if(this===connection)throw Error('Close unconfirmed');return close.call(this);});
  try {expect(await state.createPreparation(uncertain,prep)).toMatchObject({ok:false,kind:'unknown',creation:{state:'indeterminate',location:uncertain}});
    expect(existsSync(join(context.storeRoot,'runs',uncertain.run))).toBe(true);}
  finally {statement.mockRestore();rollback.mockRestore();closing.mockRestore();connection?.close();}
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:true,creation:{state:'confirmed',location}});
  expect(get(state.readPreparation(get(await openJournal(location,'read'))))).toMatchObject({status:'preparing'});
  const prior = get(await openJournal(location,'read'));
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:false,kind:'conflict',creation:{state:'rejected_or_aborted'}});
  // The SQL key independently refuses a collision, even when the private directory was removed.
  await rm(prior.root,{recursive:true});
  expect(await state.createPreparation(location,prep)).toMatchObject({ok:false,kind:'conflict',creation:{state:'rejected_or_aborted'}});
  expect(existsSync(prior.root)).toBe(false);
  expect(get(state.withState(location.database,false,db=>({ok:true,value:db.prepare('SELECT count(*) AS n FROM runs').get()})))).toEqual({n:1});
  for (const errcode of [2067, 1555, 275]) {
    const insert = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(sql) {
      if (sql.startsWith('INSERT INTO runs')) throw Object.assign(Error('Constraint refused'), { errcode });
      return prepare.call(this, sql);
    });
    try {
      const failure = await state.createPreparation({ ...location, run: 'Constraint' + errcode }, prep);
      expect(failure).toMatchObject({ ok: false, kind: errcode === 275 ? 'unknown' : 'conflict', creation: { state: 'rejected_or_aborted' } });
      if (!failure.ok && errcode === 275) expect(failure.detail).not.toContain('Run already exists');
    } finally { insert.mockRestore(); }
  }

});

it.each(['ack', 'readback', 'ack-and-readback'] as const)('creation %s failure retains its addressed receipt and directory for recovery', async fault => {
  const preload = join(root, 'commit-fault.mjs');
  await writeFile(preload, `
import {DatabaseSync} from 'node:sqlite';
const execute = DatabaseSync.prototype.exec;
let committed = false;
DatabaseSync.prototype.exec = function(sql) {
  const creating = sql === 'COMMIT' && this.prepare('SELECT root FROM runs WHERE cursor=0').get();
  const result = execute.call(this, sql);
  if (creating) { committed = true; if (${fault !== 'readback'}) throw Error('Creating COMMIT acknowledgement lost'); }
  if (committed && sql === 'BEGIN' && ${fault !== 'ack'}) throw Error('Creation readback unavailable');
  return result;
};
`);
  const child = spawnSync(process.execPath, ['--import', preload, resolve(import.meta.dirname, '../../dist-rewrite/cli.js'),
    'setup', join(root, 'brief.md'), '--project', source, '--config', join(root, 'config.json')], {
    cwd: source, env: { ...context.environment, FC_HOME: context.home, FLOWCREW_STORE_ROOT: context.storeRoot }, encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(3);
  const listed = (await invoke('status')).json();
  expect(listed).toHaveLength(1);
  const run = listed[0].value.run;
  const failure = JSON.parse(child.stdout);
  expect(failure).toMatchObject({run,effects:fault==='ack'?'setup':'maybe'});
  expect(failure.detail).toContain('flowcrew cancel '+run);
  expect(failure.detail).toContain('flowcrew land '+run);
  if(fault!=='ack') expect(failure).toMatchObject({confirmed:false,storeRoot:context.storeRoot,detail:expect.stringContaining('Do not retry')});
  expect(listed[0]).toMatchObject({ ok: true, value: { status: 'preparing', run } });
  expect(await readdir(join(context.storeRoot, 'runs'))).toEqual([run]);
  expect(existsSync(join(context.storeRoot, 'runs', run, 'git-common', 'HEAD'))).toBe(false);
  await reclaimed(run);
});

it.each(['cleanup','release'] as const)('a preparation control publishes committed events and attention after %s fails', async fault => {
  vi.spyOn(pins, 'pinRuntime').mockResolvedValue({ ok: false, kind: 'unknown', detail: 'Refused before pin' });
  const prepared = await invoke('setup', join(root, 'brief.md'), '--config', join(root, 'config.json'));
  expect(prepared.exit).toBe(3);
  const { run } = prepared.json();
  vi.restoreAllMocks();
  const record = state.recordOperation, release=state.release;
  let held: host.Claim | undefined;
  if(fault==='cleanup')vi.spyOn(state, 'recordOperation').mockImplementation((...args) => args[2].method === 'reclaimTask'
    ? Promise.resolve({ ok: false, kind: 'unknown', detail: 'Injected cleanup failure' }) : record(...args));
  else vi.spyOn(state,'release').mockImplementation(async claim=>{
    held=claim;
    return {ok:false,kind:'unknown',detail:'Injected release failure',
      closure:{state:'not_confirmed_closed',owner:claim.owner,observation:'unknown',members:[]}};
  });
  const failed = await invoke('land', run);
  expect(failed.exit, failed.stderr).toBe(3);
  const published = JSON.parse(await readFile(join(context.storeRoot, 'runs', run, 'status.json'), 'utf8'));
  const fresh = (await invoke('status', run)).json();
  expect(published.reclaimed, 'publication includes committed reclaim despite failed control').toEqual(fresh.reclaimed);
  expect(published.journalCursor).toBe(fresh.journalCursor);
  expect(published.status).toBe('cancelled');
  if(fault==='release')expect(published.attention).toMatchObject({reason:'closure_unconfirmed',
    obligations:expect.arrayContaining([expect.objectContaining({kind:'claim-unreleased'}),expect.objectContaining({kind:'closure-unconfirmed'})])});
  vi.restoreAllMocks();
  if(held)get(await release(held));
  expect((await invoke('land', run)).exit).toBe(0);
});


it('the executable selects the setup installation before decoding or writing', async () => {
  const selected = join(root, 'selected');
  await mkdir(join(selected, 'dist-rewrite', 'ops'), { recursive: true });
  await writeFile(join(selected, 'package.json'), '{"type":"module"}');
  await writeFile(join(selected, 'dist-rewrite', 'ops', 'main.js'), `export async function main(argv, context) {
    await context.stdout(Buffer.from(JSON.stringify({ selected: true, argv, runtimeRoot: context.runtimeRoot })));
    return 2;
  }`);
  const args = ['setup', 'unread-brief.md', '--requester=--x'];
  const entry = resolve(import.meta.dirname, '../../dist-rewrite/cli.js');
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), FC_HOME: context.home,
    FLOWCREW_STORE_ROOT: context.storeRoot, FLOWCREW_RUNTIME_ROOT: selected };
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: source, env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stdout, 'the selected installation owns decoding before writes').toContain('"selected":true');
  expect(JSON.parse(result.stdout)).toEqual({ selected: true, argv: args, runtimeRoot: selected });
  expect(await durable()).toEqual({});
  const missing = spawnSync(process.execPath, [entry, ...args], { cwd: source,
    env: { ...env, FLOWCREW_RUNTIME_ROOT: join(root, 'missing') }, encoding: 'utf8' });
  expect(missing.status, missing.stderr).toBe(2);
  await writeFile(join(selected, 'dist-rewrite', 'ops', 'main.js'), 'export const missing = true;');
  const incomplete = spawnSync(process.execPath, [entry, ...args], { cwd: source, env, encoding: 'utf8' });
  expect(incomplete.status, incomplete.stderr).toBe(2);
  expect(await durable()).toEqual({});
});


it('a live historical controller without a lock refuses cancel and land before signalling', async () => {
  const setup = await invoke('setup',join(root,'brief.md'),'--config',join(root,'config.json'));
  expect(setup.exit,setup.stderr).toBe(0);
  const run=setup.json().run, release=join(root,'legacy-release'), ready=join(root,'legacy-ready'), signalled=join(root,'legacy-signalled');
  const child=spawn(process.execPath,['-e',`const fs=require('node:fs');
process.on('SIGTERM',()=>fs.writeFileSync(process.argv[3],'signalled'));
fs.writeFileSync(process.argv[1],'ready');
const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(timer)},10);`,ready,release,signalled],
    {detached:true,stdio:'ignore'});
  const ended=new Promise(resolve=>child.once('exit',resolve));
  try {
    while(!existsSync(ready))await new Promise(done=>setTimeout(done,10));
    const journal=get(await openJournal({database:join(context.home,'state.sqlite'),storeRoot:context.storeRoot,run},'read'));
    const unit=get(await readProjection(journal)).launch.unit;
    const owner={...await host.identity(child.pid!),authority:'historical-controller'};
    const claim=get(await state.claim(join(journal.root,'control'),unit,{database:journal.database,holder:journal.root}));
    const writer=get(await state.openWriter(journal,claim,'control'));
    get(await state.appendEvents(writer,null,[{type:'run_observed',observation:{unit,state:'active',owner,evidence:[],detail:'Historical activation'}}]));
    get(await state.release(claim));
    const history=get(await readEvents(journal,0));
    for(const command of ['cancel','land']) {
      const result=await invoke(command,run); expect(result.exit,result.stderr).toBe(1);
      expect(result.stderr+result.stdout.toString()).toContain('Controller has no closure lock');
      expect(await host.observeController(owner)).toBe('active');
      expect(get(await readEvents(journal,0)).slice(0,history.length)).toEqual(history);
      expect(existsSync(signalled)).toBe(false);
      await access(join(context.storeRoot,'work',run,'project'));
    }
  } finally { await writeFile(release,'finish'); await ended; await reclaimed(run); }
});
