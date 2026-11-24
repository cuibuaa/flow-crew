import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, known } from '../fixtures/rewrite-host.js';
import { evidenceRepository } from '../../dist-rewrite/records/evidence.js';

it('P7 A7 declared TMPDIR is exact, undeclared TMPDIR is private scratch; all declared env keys apply last', async () => {
  const f = await fixture();
  try {
    const cache = join(f.outside, 'shared-cache'), tmp = join(cache, 'tmp');
    await mkdir(tmp, { recursive: true });
    const code = ("const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.env.TMPDIR," +
      "'marker'),'written');console.log(JSON.stringify({tmp:process.env.TMPDIR," +
      "proxy:process.env.HTTPS_PROXY,claude:process.env.CLAUDE_CODE_TMPDIR}))");
    const declared = await f.launch(code, { env: { TMPDIR: tmp, HTTPS_PROXY: 'declared-exact', CLAUDE_CODE_TMPDIR: join(cache,
     'declared-context') } });
    expect(JSON.parse(await f.text(declared.stdout))).toEqual({ tmp, proxy: 'declared-exact', claude: join(cache, 'declared-context') });
    expect(await readFile(join(tmp, 'marker'), 'utf8')).toBe('written');
    const implicit = await f.launch(code, { program: { env: { PATH: process.env.PATH!, HOME: f.home } } });
    expect(JSON.parse(await f.text(implicit.stdout)).tmp).toBe(f.scratch);
    expect(await readFile(join(f.scratch, 'marker'), 'utf8')).toBe('written');
    await f.evidence('P7-A7', { declared, implicit });
  }
  finally {
    await f.close();
  }
});

it('A9 absolute host helpers preserve a declared PATH without env or sh', async () => {
  const f = await fixture();
  try {
    const path = join(f.work, 'provider-only');
    await mkdir(path);
    const receipt = await f.launch('console.log(process.env.PATH)', { env: { PATH: path } });
    await f.evidence('A9-exact-PATH', { receipt, stderr: await f.text(receipt.stderr), path });
    expect(receipt, await f.text(receipt.stderr)).toMatchObject({ state: 'closed', exit: 0 });
    expect((await f.text(receipt.stdout)).trim()).toBe(path);
  }
  finally { await f.close(); }
});


it('absent PATH, CA and proxy keys stay absent; TMPDIR defaults only when absent', async () => {
  const f = await fixture();
  try {
    f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
    const script = 'console.log(JSON.stringify(process.env))';
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts (CoreFoundation, not the engine), so the
    // engine's environment is what remains after that one OS key is set aside; any other key still counts.
    const engine = async (stream: Parameters<typeof f.text>[0]) => Object.fromEntries(
      Object.entries(JSON.parse(await f.text(stream)) as Record<string, string>).filter(([key]) => !(process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING')));
    const implicit = await f.launch(script, { program: { env: {} } });
    expect(implicit).toMatchObject({ state: 'closed', exit: 0 });
    expect(implicit).not.toHaveProperty('grant');
    expect(await engine(implicit.stdout)).toEqual({ TMPDIR: f.scratch, FLOWCREW_INVOCATION: implicit.owner!.authority });
    const declared = { PATH: '', TMPDIR: '', SSL_CERT_FILE: 'literal.pem', HTTPS_PROXY: 'literal-proxy', CLAUDE_CODE_TMPDIR: 'literal-temp' };
    const exact = await f.launch(script, { program: { env: declared } });
    expect(await engine(exact.stdout)).toEqual({ ...declared, FLOWCREW_INVOCATION: exact.owner!.authority });
  } finally { await f.close(); }
});

it('an author-launched subprocess reaches a test-owned Unix socket outside its project', async () => {
  const f = await fixture(), socket = join(f.outside, 'writer.sock'), target = join(f.outside, 'observed');
  const server = createServer(client => client.on('data', bytes => { void writeFile(target, bytes).then(() => client.end('written')); }));
  process.chdir(f.outside);
  await new Promise<void>(resolve => server.listen('writer.sock', resolve));
  try {
    const child = "process.chdir(require('path').dirname(process.argv[1]));const c=require('net').connect('writer.sock',()=>c.write('host feedback'));c.on('data',d=>{console.log(String(d));c.end()});c.on('error',e=>{console.error(e);process.exitCode=1});";
    const author = "const c=require('child_process').spawnSync(process.execPath,['-e',process.argv[1],process.argv[2]],{encoding:'utf8'});process.stdout.write(c.stdout);process.stderr.write(c.stderr);process.exit(c.status??1);";
    const receipt = await f.launch(author, { args: [child, socket] });
    expect(receipt).toMatchObject({ state: 'closed', exit: 0 });
    expect(await f.text(receipt.stdout)).toBe('written\n');
    expect(await readFile(target, 'utf8')).toBe('host feedback');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

it('private Git refs/index/objects use invocation scratch and normal git leaves common metadata unchanged', async () => {
  const f = await fixture();
  try {
    const commonDir = evidenceRepository(f.journal), privateDir = join(f.scratch, 'git');
    const before = await readFile(join(commonDir, 'HEAD'));
    const receipt = await f.launch("const cp=require('child_process');const r=cp.spawnSync('git',['status','--porcelain'],{encoding:'utf8'});if(r.status!==0){console.error(r.stderr);process.exit(1)}console.log(JSON.stringify({dir:process.env.GIT_DIR,index:process.env.GIT_INDEX_FILE,objects:process.env.GIT_OBJECT_DIRECTORY,alternate:process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES}));", {
      context: { git: { worktree: f.work, commonDir, privateDir, baseCommit: null } }
    });
    expect(receipt, await f.text(receipt.stderr)).toMatchObject({ exit: 0, state: 'closed' });
    expect(JSON.parse(await f.text(receipt.stdout))).toEqual({ dir: privateDir, index: join(privateDir, 'index'), objects: join(privateDir, 'objects'), alternate: join(commonDir, 'objects') });
    expect(await readFile(join(commonDir, 'HEAD'))).toEqual(before);
  } finally { await f.close(); }
});
