import { ownIdentity } from '../rewrite-src/host/process.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { MonitorConfig } from './server.js';
import { parseArgs } from 'node:util';
import { startMonitor } from './server.js';

/** Trusted CLI composition; the HTTP reader owns no fence, SQL, eligibility or host signal. */
export function cancelWithCli(cli: string, environment: NodeJS.ProcessEnv): NonNullable<MonitorConfig['cancel']> {
  return (location, _status) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli,'cancel',location.run], {
      shell:false,env:{...environment,FLOWCREW_STORE_ROOT:location.storeRoot},stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => {stdout += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
    child.once('error', reject); child.once('close', exit => done({exit,stdout,stderr}));
  });

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {

try {
  const { values } = parseArgs({ options: {
    'store-root': { type: 'string', multiple: true },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string' },
  }, allowPositionals: false });
  if (!values.port || !/^[0-9]+$/.test(values.port)) throw new Error('Supply --port <0..65535>');
  const cli = resolve(import.meta.dirname, '../../dist-rewrite/cli.js');
  const cancel = cancelWithCli(cli, process.env);
  const server = await startMonitor({ boot: await ownIdentity().then(owner => owner.boot, () => undefined), storeRoots: values['store-root'] ?? [], host: values.host, port: Number(values.port),cancel:existsSync(cli) ? cancel : undefined });
  const address = server.address();
  if (address && typeof address !== 'string') {
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    process.stdout.write(`FlowCrew monitor: http://${host}:${address.port}\n`);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); });
} catch (error) {
  process.stderr.write(`Monitor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

}
