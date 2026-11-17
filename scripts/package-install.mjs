// Package sources come exclusively from the Git index, exported by git checkout-index; unstaged working-tree bytes are excluded.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'flowcrew-package-')));
const elapsed = performance.now();
const producer = join(root, 'producer');
// Resolve before the isolated consumer HOME is selected; reuse the user's public npm cache.
const npmCache = process.env.npm_config_cache ?? join(process.env.HOME, '.npm');
const execute = promisify(execFile);
const run = async (command, argv, options = {}) => {
  const result = await execute('nice', ['-n', '19', command, ...argv], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(root, 'npm-home'), TMPDIR: root,
      npm_config_userconfig: join(root, 'user.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc') },
    maxBuffer: 16 * 1024 * 1024, ...options
  });
  return result.stdout;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checkoutIdentity = () => {
  const stat = lstatSync(checkout);
  return { path: checkout, realpath: realpathSync(checkout), device: stat.dev, inode: stat.ino };
};
const checkoutBefore = checkoutIdentity(), checkoutSamples = [];
let checkoutFailure = null;
const sampleCheckout = () => {
  try {
    const identity = checkoutIdentity();
    checkoutSamples.push({ atMs: performance.now() - elapsed, ...identity });
    assert.deepEqual(identity, checkoutBefore, 'package acceptance changed checkout path identity');
  } catch (error) { checkoutFailure ??= String(error); }
};
sampleCheckout();
// Step 7p recorded 3,332 observations at this interval; sample while async children run too.
const checkoutSampler = setInterval(sampleCheckout, 25);
try {
  await run('git', ['-C', checkout, 'checkout-index', '--all', `--prefix=${producer}/`]);
  // Build dependencies are a private copy too; preserve their internal relative symlinks.
  await fs.cp(join(checkout, 'node_modules'), join(producer, 'node_modules'),
    { recursive: true, verbatimSymlinks: true });
  await run('npm', ['run', 'build'], { cwd: producer });
  const packed = JSON.parse(await run('npm', ['pack', producer, '--pack-destination', root, '--ignore-scripts', '--json', '--offline',
    '--cache', npmCache]))[0];
  const tarball = join(root, packed.filename), prefix = join(root, 'prefix');
  await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '--cache', npmCache, tarball]);
  const sourcePrefix = join(root, 'source-prefix');
  await run('npm', ['install', '--prefix', sourcePrefix, '--install-links', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '--cache', npmCache, producer]);
  const sourceInstalled = join(sourcePrefix, 'node_modules', 'flowcrew');
  assert.equal(await fs.realpath(sourceInstalled), sourceInstalled, 'source installation must be a real copy');
  const installed = join(prefix, 'node_modules', 'flowcrew');
  const metadata = JSON.parse(await fs.readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=22.22.2');
  assert.equal(metadata.main, metadata.bin.flowcrew);
  // Build closure belongs to package acceptance, never a public runtime-release verb.
  const closure = [];
  for (const file of packed.files) {
    if (!file.path.startsWith('dist-rewrite/') && !file.path.startsWith('dist-monitor/') && !file.path.startsWith('config/')) continue;
    const expected = hash(await fs.readFile(join(producer, file.path)));
    assert.equal(hash(await fs.readFile(join(installed, file.path))), expected, file.path);
    closure.push({ path: file.path, sha256: expected });
  }
  assert(closure.some(file => file.path === metadata.bin.flowcrew));
  await fs.writeFile(join(root, 'closure.json'), JSON.stringify(closure));
  const project = join(root, 'project'); await fs.mkdir(project);
  const brief = join(project, 'brief.md');
  await fs.writeFile(brief, '---\n' + JSON.stringify({ criteria: [{ id: 'reviewed', text: 'Synthetic package acceptance' }],
    inputs: [], outputs: [], commands: [], results: [], allowBlocked: false }) + '\n---\nNo provider call.\n');
  const home = join(root, 'home'); await fs.mkdir(home);
  const entry = join(prefix, 'node_modules', '.bin', 'flowcrew');
  const driver = join(root, 'installed-driver.mjs');
  await fs.writeFile(driver, String.raw`import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const [installed, entry, brief, producer, sourceEntry, sourceInstalled] = process.argv.slice(2);
await assert.rejects(fs.stat(producer),{code:'ENOENT'},'temporary producer and dependencies are unavailable');
const load = path => import(pathToFileURL(join(installed,'dist-rewrite',path)).href);
const host = await load('host/process.js'), pin = await load('records/pin.js');
// Same history-derived hang backstop as vitest.config.ts, including synchronous fixture children.
const invoke = (args, expected=0, env={}, executable=entry) => {
 const result=spawnSync('nice',['-n','19',executable,...args],{encoding:'utf8',timeout:26*60_000,killSignal:'SIGKILL',env:{...process.env,...env},cwd:dirname(brief)});
 assert.equal(result.status,expected,result.stderr+result.stdout);return result;
};
const help=invoke(['--help']).stdout;
assert(!help.includes('unit-entry'));assert(!help.includes('release'));assert(!help.includes('--intent'));
assert.equal(JSON.parse(invoke(['setup',brief]).stdout).readiness.state,'applied');
assert.deepEqual(JSON.parse(invoke(['status']).stdout),[]);
const withoutRg=join(dirname(brief),'without-rg');await fs.mkdir(withoutRg);
for(const tool of ['nice','node','env','sh',...(process.platform==='linux'?['bwrap','socat']:[])])
 await fs.symlink(await host.nativeTool(tool),join(withoutRg,tool));
const missingTool=invoke(['doctor'],1,{PATH:withoutRg}).stdout;
if(process.platform==='linux') assert(missingTool.includes('Missing native prerequisite: rg'));
assert(missingTool.includes('No provider or declared command was started'));
const config=JSON.parse(await fs.readFile(join(installed,'config/runtime.json'),'utf8'));
const bin=join(dirname(brief),'bin');await fs.mkdir(bin);
// Inert executable only; it never invokes a model or a provider CLI.
const fake=join(bin,'claude');await fs.writeFile(fake,"#!NODE\nconst fs=require('node:fs');\nconst schema=JSON.parse(process.argv[process.argv.indexOf('--json-schema')+1]);\nconst kind=schema.properties.kind.const;\nconst prompt=JSON.parse(fs.readFileSync(0,'utf8'));\nif(kind==='gate'){process.stdout.write('synthetic gate waiting; no model call\\n');setInterval(()=>{},1000);}\nelse {\n const answer=kind==='plan'?{baseRevision:schema.properties.answer.properties.baseRevision.const,plan:{stages:[\n  {id:'work',role:'work',purpose:'work',after:[],instruction:'Synthetic package work',skills:[]},\n  {id:'gate',role:'gate',purpose:'gate',after:['work'],instruction:'Synthetic independent gate',skills:[],commands:[]}\n ]}}:{status:'delivered',summary:'Synthetic work',caveats:[],remainingWork:[],blocks:null};\n console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{kind,answer},\n usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0},total_cost_usd:0}));\n}\n".replace('NODE',process.execPath),{mode:0o755});
const custom=join(dirname(brief),'runtime.json');
await fs.writeFile(custom,JSON.stringify({...config,providerHomes:{codex:[],claude:[]},roles:config.roles.map(role=>({...role,backend:'claude',model:'synthetic',effort:'low'}))}));
const humanEnv={PATH:bin+':'+process.env.PATH};
const base=join(process.env.HOME,'.local/state/flowcrew'),store=join(base,'store');
const before=performance.now();
const human=JSON.parse(invoke(['start',brief,'--config',custom,'--requester','claude:installed-session'],0,humanEnv).stdout);
const startMs=performance.now()-before,run=human.run;
assert(run.startsWith('run_'));
const state=await load('records/state.js');
const database=join(base,'state.sqlite'),journal=(await state.openJournal({database,storeRoot:store,run},'read')).value;
const projection=(await state.readProjection(journal)).value,runtime=projection.launch.runtime,pinned=dirname(join(store,runtime.path));
const size=async path=>{const s=await fs.stat(path);if(!s.isDirectory())return s.size;
 let bytes=0;for(const name of await fs.readdir(path))bytes+=await size(join(path,name));return bytes;};
const pinBytes=await size(pinned);
let cancelled=false;
try {
 assert.equal(JSON.parse(invoke(['status',run],0,humanEnv).stdout).run,run);
 assert.equal(JSON.parse(invoke(['resume',run],0,humanEnv).stdout).detail,'Already running');
 // Replace the installed runtime with a second install, whose internal executor cannot operate.
 // The public adapter must itself select the original pin; no test supplies a pinned module path.
 await fs.rm(join(installed,'dist-rewrite'),{recursive:true});
 await fs.cp(join(sourceInstalled,'dist-rewrite'),join(installed,'dist-rewrite'),{recursive:true});
 const main=join(installed,'dist-rewrite/ops/main.js');
 const replacement=await fs.readFile(main,'utf8');
 assert(replacement.includes('export async function execute('));
 await fs.writeFile(main,replacement.replace('export async function execute(', 'export async function replacedExecute(')
   +'\nexport async function execute() { throw Error("replacement executor selected"); }\n');
 for(;;){const current=(await state.readProjection(journal)).value;
  if(current.checkpoints.some(c=>c.state==='safe')&&current.invocations.some(i=>i.address.stage==='gate'))break;
  assert(['pending','running'].includes(current.status),'Synthetic work did not reach its gate: '+JSON.stringify({status:current.status,attempts:current.attempts.map(a=>a.ending),checkpoints:current.checkpoints.map(c=>c.state)}));
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 const guidance=JSON.parse(invoke(['guide',run,'Pinned runtime after installation replacement'],0,humanEnv).stdout);
 assert.equal(guidance.state,'acknowledged');
 const after=(await state.readProjection(journal)).value;
 assert(after.intents.some(i=>i.kind==='guide'&&i.id===guidance.intent.id));
 assert.deepEqual((await pin.verifyRuntime(store,runtime)).value,runtime);
 // Cancel deliberately belongs to the current installation, including when a pin is lost.
 await fs.writeFile(main,replacement);
 const monitor=spawn('nice',['-n','19',process.execPath,join(installed,'dist-monitor/rewrite-monitor/cli.js'),
   '--store-root',store,'--port','0'],{env:{...process.env,...humanEnv},stdio:['ignore','pipe','pipe']});
 const closed=new Promise(resolve=>monitor.once('close',resolve));let errors='';monitor.stderr.on('data',b=>errors+=b);
 try {
  const url=await new Promise((resolve,reject)=>{let text='';monitor.stdout.on('data',b=>{text+=b;
    const match=text.match(/http:\/\/[^\s]+/);if(match)resolve(match[0]);});
    monitor.once('error',reject);closed.then(()=>reject(Error('Monitor exited before listening: '+errors)));});
  const page=await (await fetch(url)).text();assert(page.includes(run));assert(page.includes('class="cancel"'));
  const response=await fetch(url+'/cancel/0/'+run,{method:'POST',headers:{Origin:url}});
  const text=await response.text();assert.equal(response.status,200,text);assert(text.includes('CLI exit 0'));cancelled=true;
 } finally {monitor.kill('SIGTERM');await closed;}
 assert.equal(JSON.parse(invoke(['cancel',run],0,humanEnv).stdout).detail,'Already ended');
 assert.equal(JSON.parse(invoke(['status',run]).stdout).status,'cancelled');
 const preserved=JSON.parse(invoke(['land',run],0,humanEnv).stdout);assert.equal(preserved.state,'preserved');
 const reclaimed=JSON.parse(invoke(['land',run,'--reclaim'],0,humanEnv).stdout);assert.equal(reclaimed.state,'reclaimed');
 assert.equal(JSON.parse(invoke(['status',run],0,{},sourceEntry).stdout).status,'cancelled');
 assert.equal(JSON.parse(invoke(['cancel',run],0,{},sourceEntry).stdout).detail,'Already ended');
 assert.equal(JSON.parse(invoke(['setup',brief],0,{},sourceEntry).stdout).readiness.state,'applied');
 const hook=await import(pathToFileURL(join(installed,'dist-rewrite/flowcrew-session.mjs')).href);
 assert(hook.valid(JSON.parse(invoke(['status',run]).stdout)));
 const hookConfig={storeRoots:[store],tasksRoot:join(dirname(brief),'tasks')};
 const hookConfigPath=join(dirname(brief),'flowcrew-session.json');
 await fs.writeFile(hookConfigPath,JSON.stringify(hookConfig));
 const hookResult=spawnSync('nice',['-n','19',process.execPath,join(installed,'dist-rewrite/flowcrew-session.mjs'),'Stop',hookConfigPath],{
   encoding:'utf8',timeout:26*60_000,killSignal:'SIGKILL',env:process.env,input:JSON.stringify({session_id:'installed-session'})});
 assert.equal(hookResult.status,0,hookResult.stderr);assert.equal(hookResult.stderr,'');
 assert((await hook.observe(hookConfig,'installed-session','--statusline')).observed.some(item=>item.run===run&&item.status.status==='cancelled'));
 console.log(JSON.stringify({run,pinBytes,startMs,runtime,publicPinSelection:true,publicLand:preserved,publicReclaim:reclaimed,
   packedMonitorCancel:true,producerUnavailable:true}));
} finally {
 await fs.copyFile(join(sourceInstalled,'dist-rewrite/ops/main.js'),join(installed,'dist-rewrite/ops/main.js'));
 if(!cancelled)invoke(['cancel',run],0,humanEnv);await host.closeController();
}
`);
  const environment = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root };
  // An installed file reaching back into its build/install producer now finds nothing.
  await fs.rm(producer, { recursive: true });
  const output = await run(process.execPath, [driver, installed, entry, brief, producer,
    join(sourcePrefix, 'node_modules', '.bin', 'flowcrew'), sourceInstalled], { env: environment });
  process.stdout.write(output);
  console.log(JSON.stringify({ packageBytes: packed.size, closureFiles: closure.length, wallMs: performance.now() - elapsed }));
} finally {
  clearInterval(checkoutSampler);
  sampleCheckout();
  console.log(JSON.stringify({ checkoutIdentity: { before: checkoutBefore, after: checkoutSamples.at(-1),
    sampleCount: checkoutSamples.length, samples: checkoutSamples, failure: checkoutFailure } }));
  try { assert.equal(checkoutFailure, null, 'package acceptance must leave checkout path identity unchanged throughout'); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
