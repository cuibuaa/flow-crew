import { identity, nativeSpawn, nativeTool, nativeExec } from '../../../dist-rewrite/host/process.js';
import { putEvidence, evidenceRepository } from '../../../dist-rewrite/records/evidence.js';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function constructGated(journal, gates) {
  const python = ("import os,sys,time,subprocess\nrepo,gates,git=sys.argv[1:4]\nopen(os.path.join(gates," +
    "'native'),'w').write(str(os.getpid()))\nwhile not os.path.exists(os.path.join(gates," +
    "'go')):time.sleep(.01)\nr=subprocess.run(['/usr/bin/nice','-n','19',git," +
    "'--git-dir='+repo,'hash-object','--no-filters','-w','--stdin'],input=b'gated-object'," +
    "stdout=subprocess.PIPE,check=True)\nopen(os.path.join(gates,'object')," +
    "'w').write(r.stdout.decode().strip())\nwhile not os.path.exists(os.path.join(gates," +
    "'finish')):time.sleep(.01)\n");
  const { child, done } = await nativeSpawn([await nativeTool('python3'), '-I', '-S', '-B', '-c', python, evidenceRepository(journal),
   gates, await nativeTool('git')], { env: {} });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end();
  if (await done !== 0)
    return { ok: false, kind: 'unknown', detail: 'Native constructor interrupted' };
  return putEvidence(journal, Buffer.from('gated-object'));
}
export async function publishAndKill(journal) { await putEvidence(journal, Buffer.from('durable-before-fact')); process.kill(process.pid,
 'SIGKILL'); }
export async function touch(pathname) { await fs.writeFile(pathname, 'effect'); return { ok: true, value: true }; }
export async function awaitRelease(gates) { await fs.writeFile(path.join(gates, 'ready'), 'ready'); while (!await fs.access(path.join(gates,
 'go')).then(() => true, () => false))
  await new Promise(r => setTimeout(r, 10)); return { ok: true, value: true }; }

export async function concurrentNativeChildren() {
  const sleep = await nativeTool('sleep');
  await Promise.all(Array.from({ length: 8 }, () => nativeExec([sleep, '1'], { env: {} })));
  return { ok: true, value: true };
}

export function completed() { return {ok:true,value:true}; }

export async function dyingNativeChild(dying = true) {
  const {default:promises}=await import('node:fs/promises');
  const {syncBuiltinESMExports}=await import('node:module');
  const read=promises.readFile;
  let child,exited,sampled=false;
  promises.readFile=async function(file,...args) {
    const raw=await read.call(this,file,...args);
    if(child && String(file)===`/proc/${child.pid}/stat`) {
      if(dying)await exited;sampled=true;
      const cut=raw.lastIndexOf(')')+2,fields=raw.slice(cut).split(' ');
      fields[2]='-1'; // Observed kernel dying-task snapshot; ChildProcess already owns exit 0.
      return raw.slice(0,cut)+fields.join(' ');
    }
    return raw;
  };
  syncBuiltinESMExports();
  try {
    const native=nativeSpawn([process.execPath,'-e',dying?'':'setInterval(()=>{},1000)'],{env:{}});child=native.child;
    exited=new Promise(done=>child.once('exit',done));child.stdin.end();child.stdout.resume();child.stderr.resume();
    const exit=await native.done;
    return {ok:true,value:{exit,sampled}};
  } finally {promises.readFile=read;syncBuiltinESMExports();}
}

export async function completedWithMember() {
  process.send({ member: await identity() });
  return completed();
}
export function exitWithoutResult() { process.exit(23); }

export async function heldZombie(pythonFile, releasePath, marker) {
  await nativeExec([await nativeTool('python3'), '-I', '-S', '-B', pythonFile, releasePath, marker], { env: {} });
  return completed();
}
