import { it, expect } from 'vitest';
import { writeFile, readFile, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { nativeGuarantees } from "../../dist-rewrite/host/confine.js";
import { fixture } from "../fixtures/rewrite-host.js";
it('P1 exact external file and P2 records deny with inherited B1 stream fds', async () => {
  const f = await fixture();
  try {
    const exact = join(f.outside, 'exact'), sibling = join(f.outside, 'sibling');
    await writeFile(exact, 'original');
    await writeFile(sibling, 'protected');
    const frozen = join(f.work, 'frozen');
    await writeFile(frozen, 'frozen');
    const guarantee = nativeGuarantees[process.platform as keyof typeof nativeGuarantees];
    expect(guarantee).toBeDefined();
    const grant = { writableRoots: [f.work, exact], protectedRoots: [f.records, frozen] };
    const code = String.raw`
      const fs=require('fs'),p=require('path'),result={};
      const op=(name,fn)=>{try{fn();result[name]={ok:true}}catch(e){result[name]={ok:false,errno:e.code}}};
      const [root,out,records]=process.argv.slice(1);
      op('inside',()=>fs.writeFileSync(p.join(root,'inside'),'yes'));
      op('exactWrite',()=>fs.writeFileSync(p.join(out,'exact'),'new'));
      op('append',()=>fs.appendFileSync(p.join(out,'exact'),'!'));
      op('truncate',()=>fs.truncateSync(p.join(out,'exact'),2));
      result.content=fs.readFileSync(p.join(out,'exact'),'utf8');
      op('sibling',()=>fs.writeFileSync(p.join(out,'sibling'),'bad'));
      op('unlink',()=>fs.unlinkSync(p.join(out,'exact')));
      op('recreate',()=>fs.symlinkSync(p.join(out,'sibling'),p.join(out,'exact')));
      if(result.recreate.ok)result.link=fs.readlinkSync(p.join(out,'exact'));
      op('record',()=>fs.writeFileSync(p.join(records,'forbidden'),'bad'));
      for(const name of ['sibling','frozen']){
        const file=name==='sibling'?p.join(out,name):p.join(root,name);
        op(name+'Unlink',()=>fs.unlinkSync(file));
        op(name+'Rename',()=>fs.renameSync(file,p.join(root,name+'-moved')));
      }
      op('frozenWrite',()=>fs.writeFileSync(p.join(root,'frozen'),'bad'));
      process.stdout.write(JSON.stringify(result));process.stderr.write('exact-stderr\n');
    `;
    const receipt = await f.launch(code, { grant, args: [f.work, f.outside, f.records] });
    const observed = JSON.parse(await f.text(receipt.stdout));
    await f.evidence('P1-P2-B1', { receipt, observed, stderr: await f.text(receipt.stderr) });
    expect(receipt.state).toBe('closed');
    expect(receipt.exit).toBe(0);
    for (const name of ['inside', 'exactWrite', 'append', 'truncate'])
      expect(observed[name].ok, name).toBe(true);
    for (const name of ['sibling', 'record', 'siblingUnlink', 'siblingRename', 'frozenUnlink', 'frozenRename', 'frozenWrite'])
      expect(observed[name].ok, name).toBe(false);
    expect(observed.content).toBe('ne');
    expect(observed.unlink.ok).toBe(guarantee.exactFileUnlink);
    expect(observed.recreate.ok).toBe(guarantee.exactFileRecreate);
    if (guarantee.exactFileRecreate) expect(observed.link).toBe(sibling);
    else expect(await readFile(exact, 'utf8')).toBe('ne');
    // Rename gets its own existing source: ENOENT after unlink is not confinement evidence.
    await rm(exact, { force: true });
    await writeFile(exact, 'rename source');
    const moved = await f.launch("try{require('fs').renameSync(process.argv[1],process.argv[2]);console.log(true)}catch{console.log(false)}",
      { grant, args: [exact, join(f.work, 'moved')] });
    expect(moved).toMatchObject({ state: 'closed', exit: 0 });
    const renamed = JSON.parse(await f.text(moved.stdout));
    expect(renamed).toBe(guarantee.exactFileRename);
    expect(await readFile(guarantee.exactFileRename ? join(f.work, 'moved') : exact, 'utf8')).toBe('rename source');
    expect(await readFile(frozen, 'utf8')).toBe('frozen');
    process.stderr.write('Native evidence P1-file-guarantee ' + JSON.stringify({ platform: process.platform,
      unlink: observed.unlink.ok, rename: renamed, recreate: observed.recreate.ok, disclosedDifference: process.platform === 'darwin' }) + '\n');
    await f.evidence('P1-file-guarantee', { guarantee, observed, moved });
    expect(await readFile(sibling, 'utf8')).toBe('protected');
    expect(await f.text(receipt.stderr)).toBe('exact-stderr\n');
  }
  finally {
    await f.close();
  }
});
it('P2 mandatory existing and absent denials; ordinary bytes remain writable', async () => {
  const f = await fixture();
  try {
    const mandatory = ['.git/hooks/probe', '.git/config', '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc',
     '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.vscode/settings.json', '.idea/probe', '.claude/commands/probe', '.claude/agents/probe'];
    for (const name of [...mandatory, '.git/objects/ordinary', 'ordinary']) {
      const path = join(f.work, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'original');
    }
    const code = ("const fs=require('fs'),p=require('path');const names=JSON.parse(process.argv[1]);" +
      "const values={};for(const name of names){try{fs.writeFileSync(p.join(process.cwd()," +
      "name),'changed');values[name]=true}catch(e){values[name]=e.code}}console.log(JSON.str" +
      "ingify(values))");
    const receipt = await f.launch(code, { args: [JSON.stringify([...mandatory, '.git/hooks/absent', '.git/objects/ordinary', 'ordinary'])] });
    const values = JSON.parse(await f.text(receipt.stdout));
    for (const name of [...mandatory, '.git/hooks/absent'])
      expect(values[name], name).not.toBe(true);
    expect(values['.git/objects/ordinary']).toBe(true);
    expect(values.ordinary).toBe(true);
    await rm(join(f.work, '.bashrc'));
    await rm(join(f.work, '.mcp.json'));
    const absent = await f.launch(code, { args: [JSON.stringify(['.bashrc', '.mcp.json', 'records/absent'])] });
    const absentValues = JSON.parse(await f.text(absent.stdout));
    for (const value of Object.values(absentValues))
      expect(value).not.toBe(true);
    await f.evidence('P2', { values, absentValues });
  }
  finally {
    await f.close();
  }
});
it('P3 negative alias; P3b in-run link denial; P3c listed alias is readable and read-only', async () => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'model'), unsafe = join(f.work, 'unsafe'), safe = join(f.work, 'safe'), late = join(f.work, 'late');
    await writeFile(source, 'original');
    await link(source, unsafe);
    await link(source, safe);
    const code = ("const fs=require('fs');const [unsafe,safe,source,late]=process.argv.slice(1);const " +
      "value={};for(const [name,fn] of [['unsafe',()=>fs.writeFileSync(unsafe,'changed')]," +
      "['safe',()=>fs.writeFileSync(safe,'bad')],['late',()=>fs.linkSync(source," +
      "late)]]){try{fn();value[name]=true}catch(e){value[name]=e.code}}value.read=fs.readFil" +
      "eSync(safe,'utf8');console.log(JSON.stringify(value));");
    const receipt = await f.launch(code, { grant: { ...f.grant, protectedRoots: [f.records, safe] }, args: [unsafe, safe, source, late] });
    const value = JSON.parse(await f.text(receipt.stdout));
    expect(value.unsafe).toBe(true);
    expect(value.safe).not.toBe(true);
    expect(value.late).toBe(process.platform === 'linux' ? 'EXDEV' : 'EPERM');
    expect(value.read).toBe('changed');
    expect(await readFile(source, 'utf8')).toBe('changed');
    await f.evidence('P3-P3b-P3c', { value });
  }
  finally {
    await f.close();
  }
});
import { vi } from 'vitest';
import { prepareAliases, admitAliases, prepareGrant } from "../../dist-rewrite/host/confine.js";
import { checkReadiness, launchInvocation, nativeTool } from "../../dist-rewrite/host/process.js";
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { createServer } from 'node:net';
import { symlink, lstat, access, rm, rename } from 'node:fs/promises';
import { known } from "../fixtures/rewrite-host.js";
it('P1 missing roots and root identity replacement refuse before payload; approved provision succeeds', async () => {
  const f = await fixture();
  try {
    const root = join(f.outside, 'new'), marker = join(f.work, 'effect');
    const grant = { writableRoots: [f.work, root], protectedRoots: [f.records] };
    const program = { argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], cwd: f.work,
     env: { PATH: process.env.PATH! }, writableRoots: grant.writableRoots };
    expect(await launchInvocation(grant, program, f.ports, new AbortController().signal)).toMatchObject({ ok: false });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(root);
    const receipt = known(await launchInvocation(grant, program, f.ports, new AbortController().signal));
    expect(receipt.exit).toBe(0);
    const result = await prepareGrant(grant, program, { ...f.ports, putEvidence: async (bytes) => {
     const ref = await f.ports.putEvidence(bytes); await rename(root, root + '-old'); await mkdir(root); return ref; } });
    expect(result).toMatchObject({ ok: false, kind: 'conflict', detail: 'Writable root identity changed' });
    await f.evidence('P1-roots', { result });
  }
  finally {
    await f.close();
  }
});
it('P2 wrong controller cwd negative control proves adapter resets cwd before every wrap', async () => {
  const f = await fixture();
  const original = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);
  try {
    await writeFile(join(f.work, '.bashrc'), 'protected');
    const spy = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockImplementation(async (...args) => { process.chdir(f.outside);
     return original(...args); });
    const code = `try{require('fs').writeFileSync('.bashrc','changed');console.log(true)}catch{console.log(false)}`;
    const unsafe = await f.launch(code);
    expect(await f.text(unsafe.stdout)).toBe('true\n');
    spy.mockRestore();
    process.chdir(f.outside);
    const safe = await f.launch(code);
    expect(await f.text(safe.stdout)).toBe('false\n');
    await f.evidence('P2-cwd', { unsafe, safe });
  }
  finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
it('P3 admission preserves declared zero-copy links, copies a writable protected file, refuses unknown and changed aliases', async () => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'model'), safe = join(f.work, 'safe'), mutable = join(f.work, 'mutable'), unknown = join(f.work, 'unknown');
    await writeFile(source, 'model');
    const aliases = known(prepareAliases([{ source, destination: safe, writable: false }, { source, destination: mutable, writable: true }]));
    expect((await lstat(safe)).ino).toBe((await lstat(source)).ino);
    expect((await lstat(mutable)).ino).not.toBe((await lstat(source)).ino);
    expect(admitAliases([source], [f.work], aliases).ok).toBe(true);
    const grant = { writableRoots: [f.work], protectedRoots: [f.records, safe], aliases };
    const receipt = await f.launch(("const fs=require('fs');fs.writeFileSync(process.argv[1],'private');let denied=false;" +
      "try{fs.writeFileSync(process.argv[2],'bad')}catch{denied=true}console.log(denied)"), { grant, args: [mutable, safe] });
    expect(await f.text(receipt.stdout)).toBe('true\n');
    expect(await readFile(source, 'utf8')).toBe('model');
    await link(source, unknown);
    expect(admitAliases([source], [f.work], aliases)).toMatchObject({ ok: false, detail: expect.stringContaining('Unknown protected alias') });
    await expect(f.launch('process.exit(0)', { grant })).rejects.toThrow('alias authority changed');
    await f.evidence('P3-admission', { aliases, receipt });
  }
  finally {
    await f.close();
  }
});
it('P7 A7 declared TMPDIR is exact, undeclared TMPDIR is private scratch; all declared env keys apply last', async () => {
  const f = await fixture();
  try {
    const cache = join(f.outside, 'shared-cache'), tmp = join(cache, 'tmp');
    await mkdir(tmp, { recursive: true });
    const grant = { writableRoots: [f.work, cache], protectedRoots: [f.records] };
    const code = ("const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.env.TMPDIR," +
      "'marker'),'written');console.log(JSON.stringify({tmp:process.env.TMPDIR," +
      "proxy:process.env.HTTPS_PROXY,claude:process.env.CLAUDE_CODE_TMPDIR}))");
    const declared = await f.launch(code, { grant, env: { TMPDIR: tmp, HTTPS_PROXY: 'declared-exact', CLAUDE_CODE_TMPDIR: join(cache,
     'declared-context') } });
    expect(JSON.parse(await f.text(declared.stdout))).toEqual({ tmp, proxy: 'declared-exact', claude: join(cache, 'declared-context') });
    expect(await readFile(join(tmp, 'marker'), 'utf8')).toBe('written');
    const implicit = await f.launch(code, { grant, program: { env: { PATH: process.env.PATH!, HOME: f.home } } });
    expect(JSON.parse(await f.text(implicit.stdout)).tmp).toBe(f.scratch);
    expect(await readFile(join(f.scratch, 'marker'), 'utf8')).toBe('written');
    await f.evidence('P7-A7', { declared, implicit });
  }
  finally {
    await f.close();
  }
});
it('P6 HTTPS GET with declared TMPDIR: two allowed targets, restricted-domain control and broad wildcard refusal', async () => {
  const f = await fixture();
  try {
    const cache = join(f.outside, 'shared-cache'), tmp = join(cache, 'tmp');
    await mkdir(tmp, { recursive: true });
    const grant = { ...f.grant, writableRoots: [f.work, cache] };
    // Keep Linux's default trust-store coverage. Strict Seatbelt excludes trustd;
    // macOS must show the default failure and verified HTTPS with explicit public PEM roots.
    const ca = join(f.work, 'public-roots.pem');
    await writeFile(ca, rootCertificates.join('\n'));
    const results: any[] = [];
    const get = async (host: string, explicitCA = false) => { const receipt = await f.launch('', { grant, program: { argv: ['curl', ...(explicitCA ? ['--cacert', ca] : []), '-sS', '--max-time',
     '20', '-o', '/dev/null', '-w', '%{http_code}', 'https://' + host] }, env: { TMPDIR: tmp } }); const item = { host, explicitCA, receipt,
     stdout: await f.text(receipt.stdout), stderr: await f.text(receipt.stderr) }; results.push(item); return item; };
    for (const host of ['example.com', 'example.org']) {
      const defaults = await get(host);
      const guarantee = nativeGuarantees[process.platform as keyof typeof nativeGuarantees];
      expect(defaults.receipt.exit, defaults.stderr).toBe(guarantee.defaultTrustHttps ? 0 : 60);
      expect(defaults.stdout).toBe(guarantee.defaultTrustHttps ? '200' : '000');
      process.stderr.write('Native evidence P6-default-trust ' + JSON.stringify({ platform: process.platform, host,
        exit: defaults.receipt.exit, status: defaults.stdout }) + '\n');
      if (!guarantee.defaultTrustHttps) {
        const explicit = await get(host, true);
        expect(explicit.receipt.exit, explicit.stderr).toBe(0);
        expect(explicit.stdout).toBe('200');
        process.stderr.write('Native evidence P6-explicit-ca ' + JSON.stringify({ platform: process.platform, host,
          exit: explicit.receipt.exit, status: explicit.stdout }) + '\n');
      }
    }
    await (await import("../../dist-rewrite/host/process.js")).closeController();
    const original = SandboxManager.initialize.bind(SandboxManager);
    const spy = vi.spyOn(SandboxManager, 'initialize').mockImplementation(config => original({ ...config, network: {
     allowedDomains: ['example.com'], deniedDomains: [], allowAllUnixSockets: false } }));
    const explicitCA = !nativeGuarantees[process.platform as keyof typeof nativeGuarantees].defaultTrustHttps;
    const listed = await get('example.com', explicitCA), unlisted = await get('example.org', explicitCA);
    expect(listed.receipt.exit, listed.stderr).toBe(0);
    expect(unlisted.receipt.exit).not.toBe(0);
    spy.mockRestore();
    expect(SandboxRuntimeConfigSchema.safeParse({ network: { allowedDomains: ['*'], deniedDomains: [] }, filesystem: { allowWrite: [],
     denyWrite: [], denyRead: [], allowRead: [] } }).success).toBe(false);
    await f.evidence('P6', { results, certificateValidation: true });
  }
  finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
it('P9 real readiness refuses missing prerequisite, failed native launch and missing scratch without executing workload', async () => {
  const f = await fixture();
  const originalPath = process.env.PATH;
  try {
    const marker = join(f.work, 'unexpected'), program = { argv: [process.execPath, '-e',
     `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], cwd: f.work, env: { PATH: process.env.PATH!, HOME: f.home },
     writableRoots: f.grant.writableRoots };
    if (process.platform === 'linux') {
      const initialize = SandboxManager.initialize.bind(SandboxManager);
      const hiddenPath = vi.spyOn(SandboxManager, 'initialize').mockImplementation(async (config, ...args) =>
        initialize({ ...config, bwrapPath: join(f.outside, 'missing-bwrap') }, ...args));
      const missing = await checkReadiness(f.grant, program, f.ports, new AbortController().signal);
      hiddenPath.mockRestore();
      expect(missing).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('bwrap') });
      await f.evidence('P9-missing', { missing });
      await (await import("../../dist-rewrite/host/process.js")).closeController();
    }
    const native = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockResolvedValue({ argv: ['/usr/bin/false'], env: {} } as any);
    const denied = await checkReadiness(f.grant, program, f.ports, new AbortController().signal);
    expect(denied.state).toBe('unavailable');
    expect(denied.detail).toContain('Status and inspection remain available');
    native.mockRestore();
    const raw = await checkReadiness(f.grant, { ...program, argv: [process.execPath, '-e',
      "console.error('synthetic native diagnostic');process.exit(23)"] }, f.ports, new AbortController().signal);
    expect(raw.detail).toMatch(/^Cannot start confined work: synthetic native diagnostic/);
    expect(raw.detail).toContain('Host prerequisite checklist:');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const absent = await checkReadiness(f.grant, program, { ...f.ports, scratch: join(f.work, 'absent') }, new AbortController().signal);
    expect(absent.state).not.toBe('applied');
    await f.evidence('P9-refusal', { denied, absent });
  }
  finally {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    await f.close();
  }
});
it('P10 outside Unix-socket writer is blocked; unsafe library-only control exposes the escape', async () => {
  const f = await fixture(), socket = join(f.outside, 'writer.sock'), target = join(f.outside, 'escaped');
  const server = createServer(client => client.on('data', async (bytes) => { await writeFile(target, bytes); client.end('written'); }));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const code = ("const c=require('net').connect(process.argv[1],()=>c.write('changed'));c.on('data'," +
      "d=>{console.log(String(d));c.end()});c.on('error',e=>{console.error(e.code);" +
      "process.exitCode=1});");
    const blocked = await f.launch(code, { args: [socket] });
    expect(blocked.exit).not.toBe(0);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await (await import("../../dist-rewrite/host/process.js")).closeController();
    const initialize = SandboxManager.initialize.bind(SandboxManager), spy = vi.spyOn(SandboxManager,
     'initialize').mockImplementation((config, ask) => initialize({ ...config, network: { ...config.network, allowAllUnixSockets: true } }, ask));
    const unsafe = await f.launch(code, { args: [socket] });
    expect(unsafe.exit).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('changed');
    spy.mockRestore();
    await f.evidence('P10', { blocked, unsafe });
  }
  finally {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
import { createCodexAdapter } from "../../dist-rewrite/exec/codex.js";
import { createClaudeAdapter } from "../../dist-rewrite/exec/claude.js";
import { interpretAuthority, authorityGrant } from "../../dist-rewrite/exec/policy.js";
it('P7 fake providers preserve flags/env/stdin/streams and only their own homes for plan, work and gate; commands get neither', async () => {
  const f = await fixture();
  try {
    const project = join(f.work, 'project'), bin = join(f.outside, 'bin'), homes = { codex: join(f.home, 'codex'), claude: join(f.home,
     'claude') };
    for (const path of [project, bin, ...Object.values(homes)])
      await mkdir(path);
    const script = ("#!" +
      `${process.execPath}` +
      "\nconst fs=require('fs'),p=require('path');const writes={};for(const backend of " +
      "['codex','claude']){try{fs.writeFileSync(p.join(process.env[backend.toUpperCase()+'_T" +
      "EST_HOME'],'state'),'written');writes[backend]=true}catch{writes[backend]=false}};" +
      "const answer={argv:process.argv.slice(2),stdin:fs.readFileSync(0).toString()," +
      "exact:process.env.EXACT,hasProxy:!!process.env.HTTPS_PROXY,writes};" +
      "try{fs.writeFileSync(process.env.FROZEN_TEST_PATH,'bad');" +
      "answer.frozenWrite=true}catch{answer.frozenWrite=false};" +
      "process.stderr.write('synthetic-stderr\\n');const backend=p.basename(process.argv[1]);" +
      "if(backend==='codex'){console.log(JSON.stringify({type:'item.completed'," +
      "item:{type:'agent_message',text:JSON.stringify(answer)}}));" +
      "console.log(JSON.stringify({type:'turn.completed'}));}else " +
      "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false," +
      "structured_output:answer}));\n");
    for (const backend of ['codex', 'claude'])
      await writeFile(join(bin, backend), script, { mode: 0o700 });
    await writeFile(join(project, 'frozen'), 'frozen');
    const brief = { criteria: [{ id: 'correct', text: 'review' }], inputs: [{ id: 'frozen', path: 'frozen', kind: 'file' as const,
     frozen: true }], outputs: [], commands: [{ id: 'verify', argv: ['synthetic'], env: {}, inputs: [], required: true }], results: [],
     allowBlocked: false, body: 'synthetic' };
    const table = known(interpretAuthority(brief, { sharedCaches: [], devices: [], providerHomes: { codex: [homes.codex],
     claude: [homes.claude] } }, { project, protectedRoots: [f.records], workRoot: f.work }, []));
    const input = known(await f.ports.putEvidence(Buffer.from('exact stdin\n'))), observations: any[] = [];
    const environment = { PATH: bin + ':' + process.env.PATH!, HOME: f.home, EXACT: 'literal $ ; space', CODEX_TEST_HOME: homes.codex,
     CLAUDE_TEST_HOME: homes.claude, FROZEN_TEST_PATH: join(project, 'frozen') };
    for (const purpose of ['plan', 'work', 'gate'] as const)
      for (const backend of ['codex', 'claude'] as const) {
        const scratch = join(f.work, purpose + '-' + backend);
        await mkdir(scratch);
        const grant = authorityGrant(table, purpose, scratch, backend);
        const adapter = (backend === 'codex' ? createCodexAdapter : createClaudeAdapter)({ journal: f.journal, process: f.ports,
         privateEnvironment: environment });
        const result = known(await adapter.invoke({ ...grant, project, scratch, input, role: { id: 'role', backend, description: '',
         prompt: 'synthetic', model: 'fixture', effort: 'fixture' }, attempt: { run: f.location.run, stage: purpose, attempt: 'Attempt',
         invocation: 1 }, preferences: { model: 'fixture-model', effort: 'fixture-effort', source: { model: 'role', effort: 'role' } }, schema: {
         type: 'object', properties: {}, additionalProperties: false, required: [] }, abort: new AbortController().signal }));
        expect(result).toMatchObject({ ending: 'delivered', exit: 0, closure: 'dead' });
        const answer = JSON.parse(await f.text(result.answerBytes!));
        expect(answer.stdin).toBe('exact stdin\n');
        expect(answer.exact).toBe(environment.EXACT);
        expect(answer.hasProxy).toBe(true);
        expect(answer.frozenWrite).toBe(false);
        expect(answer.writes[backend]).toBe(true);
        expect(answer.writes[backend === 'codex' ? 'claude' : 'codex']).toBe(false);
        if (backend === 'codex')
          expect(answer.argv).toEqual(expect.arrayContaining(['--sandbox', 'danger-full-access', '--model', 'fixture-model']));
        else
          expect(answer.argv).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--model',
           'fixture-model', '--effort', 'fixture-effort']));
        observations.push({ backend, purpose, result, answer });
      }
    // Ordinary authored command uses the same physical boundary without provider roots.
    const normal = await f.launch(("const fs=require('fs'),p=require('path'),out={};for(const home of " +
      "process.argv.slice(1,3)){try{fs.writeFileSync(p.join(home,'command'),'bad');" +
      "out[home]=true}catch{out[home]=false}}try{fs.writeFileSync(process.argv[3],'bad');" +
      "out.frozen=true}catch{out.frozen=false}console.log(JSON.stringify(out))"), { grant: authorityGrant(table, 'command', f.scratch,
       undefined, undefined, 'verify'), args: [...Object.values(homes), join(project, 'frozen')], program: { cwd: project } });
    expect(Object.values(JSON.parse(await f.text(normal.stdout)))).toEqual([false, false, false]);
    expect(await readFile(join(project, 'frozen'), 'utf8')).toBe('frozen');
    await f.evidence('P7-providers', { observations, normal });
  }
  finally {
    await f.close();
  }
});
it('P7 nested native confinement refuses inside the outer sandbox', async () => {
  const f = await fixture();
  try {
    const argv = process.platform === 'linux' ? ['bwrap', '--ro-bind', '/', '/', '/usr/bin/true'] : ['sandbox-exec', '-p',
     '(version 1)(allow default)', '/usr/bin/true'];
    const receipt = await f.launch('', { program: { argv } });
    expect(receipt.exit).not.toBe(0);
    await f.evidence('P7-nesting', { receipt, stderr: await f.text(receipt.stderr) });
  }
  finally {
    await f.close();
  }
});
import { evidenceRepository } from "../../dist-rewrite/records/evidence.js";
it('private Git uses invocation-local writable refs/index/objects; protected common refs/hooks/config stay unchanged', async () => {
  const f = await fixture();
  try {
    const common = evidenceRepository(f.journal), privateDir = join(f.scratch, 'git');
    const code = ("const cp=require('child_process'),fs=require('fs');const writes={};for(const name of " +
      "['config','hooks/probe','refs/heads/forged']){try{fs.writeFileSync(process.argv[1]+'/" +
      "'+name,'bad');writes[name]=true}catch{writes[name]=false}}console.log(JSON.stringify(" +
      "{dir:process.env.GIT_DIR,index:process.env.GIT_INDEX_FILE," +
      "objects:process.env.GIT_OBJECT_DIRECTORY," +
      "alternate:process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,writes}));");
    const receipt = await f.launch(code, { grant: { ...f.grant, git: { worktree: f.work, commonDir: common, privateDir,
     baseCommit: null } }, args: [common] });
    const observed = JSON.parse(await f.text(receipt.stdout));
    expect(receipt.exit).toBe(0);
    expect(observed).toMatchObject({ dir: privateDir, index: join(privateDir, 'index'), objects: join(privateDir, 'objects'),
     alternate: join(common, 'objects') });
    expect(Object.values(observed.writes)).toEqual([false, false, false]);
    // Git executable itself uses the same environment/grant, through the public launch port.
    const privateDir2 = join(f.scratch, 'git-command');
    const result = await f.launch('', { grant: { ...f.grant, git: { worktree: f.work, commonDir: common, privateDir: privateDir2,
     baseCommit: null } }, program: { argv: ['git', 'status', '--porcelain'] } });
    expect(result.exit, await f.text(result.stderr)).toBe(0);
    await f.evidence('private-Git', { receipt, observed, result });
  }
  finally {
    await f.close();
  }
});
it('P7 admitted character device works through the same physical grant as files and directories', async () => {
  const f = await fixture();
  try {
    const grant = { ...f.grant, writableRoots: [...f.grant.writableRoots, '/dev/null'] };
    const receipt = await f.launch("require('node:fs').writeFileSync('/dev/null','device');console.log('written')", { grant });
    expect(receipt).toMatchObject({ state: 'closed', exit: 0, grant: 'applied' });
    expect(await f.text(receipt.stdout)).toBe('written\n');
    await f.evidence('P7-device', { receipt });
  }
  finally {
    await f.close();
  }
});

it('A8 run root longer than 108 bytes keeps system-temp bridge sockets and private child scratch', async () => {
  const f = await fixture('long-run-root-'.repeat(10));
  try {
    expect(Buffer.byteLength(f.work)).toBeGreaterThan(108);
    const systemTmp = process.env.TMPDIR;
    const receipt = await f.launch("console.log(process.env.TMPDIR)", { program: { env: {} } });
    expect(receipt).toMatchObject({ state: 'closed', exit: 0 });
    expect((await f.text(receipt.stdout)).trim()).toBe(f.scratch);
    expect(process.env.TMPDIR).toBe(systemTmp);
    await f.evidence('A8-long-run-root', { rootBytes: Buffer.byteLength(f.work), receipt });
  }
  finally { await f.close(); }
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

it('host bootstrap PATH resolves package helpers before the payload declaration applies', async () => {
  const f = await fixture();
  const sh = await nativeTool('sh');
  // Reproduce SRT's macOS relative env helper on Linux, independently of bwrap.
  const wrapper = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockImplementation(async command =>
    ({ argv: [sh, '-c', 'env ' + command], env: {} }));
  try {
    const path = join(f.work, 'payload-only');
    await mkdir(path);
    const receipt = await f.launch('console.log(process.env.PATH)', { env: { PATH: path } });
    expect(receipt, await f.text(receipt.stderr)).toMatchObject({ state: 'closed', exit: 0 });
    expect((await f.text(receipt.stdout)).trim()).toBe(path);
    const undeclared = await f.launch('console.log(Object.hasOwn(process.env,"PATH"))', { program: { env: {} } });
    expect(undeclared, await f.text(undeclared.stderr)).toMatchObject({ state: 'closed', exit: 0 });
    expect(await f.text(undeclared.stdout)).toBe('false\n');
  } finally {
    wrapper.mockRestore();
    await f.close();
  }
});
