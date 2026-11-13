import { get } from 'node:http';
import { EXIT_CODE } from './exit-code.js';
import { parseCommandArgs, commandUsage } from './cli-args.js';
import type { DashboardStatusResponse } from './dashboard.js';

interface TextWriter {
  write(chunk: string): unknown;
}

export interface DashboardCommandOptions {
  stdout?: TextWriter;
  stderr?: TextWriter;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Wait for the complete local response; elapsed time cannot establish absence. */
export function requestDashboardStatus(url: string, options?: Pick<RequestInit, 'signal'>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false, signal: options?.signal ?? undefined, headers: { Accept: 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(new Response([204, 205, 304].includes(res.statusCode ?? 0) ? null : text, { status: res.statusCode })); }
        catch (error) { reject(error); }
      });
      res.on('close', () => {
        if (!res.complete) reject(new Error('Dashboard response closed before completion'));
      });
    });
    req.on('error', reject);
    req.on('close', () => reject(new Error('Dashboard connection closed before completion')));
  });
}

function usage(writer: TextWriter): void {
  writer.write(`${commandUsage('dashboard status')}\n`);
}

function isStatusResponse(value: unknown): value is DashboardStatusResponse {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<DashboardStatusResponse>;
  return (status.freshness === 'fresh' || status.freshness === 'stale' || status.freshness === 'unverified')
    && Number.isInteger(status.pid) && (status.pid ?? 0) > 0
    && typeof status.startedAt === 'string';
}

function hash(build: DashboardStatusResponse['loadedBuild']): string {
  return build?.hash ?? 'UNVERIFIED';
}

export async function cmdDashboard(args: string[], options: DashboardCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const subcommand = args[1]?.startsWith('-') ? undefined : args[1];
  let parsed;
  try { parsed = parseCommandArgs(`dashboard${subcommand ? ` ${subcommand}` : ''}`, args); }
  catch (error) { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  if (parsed.help) {
    usage(stdout);
    return 0;
  }
  if (subcommand !== 'status') {
    usage(stderr);
    return 1;
  }

  const portValue = parsed.values.get('--port') ?? process.env.PORT ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    stderr.write(`Invalid dashboard port: ${portValue}\n`);
    return 1;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? requestDashboardStatus;

  const controller = new AbortController();
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/dashboard/status`, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      stdout.write(`UNFINISHED: declared dashboard observation allowance exhausted at ${baseUrl}.\n`);
      return EXIT_CODE.inProgress;
    }
    stdout.write(`UNREACHABLE: dashboard did not answer at ${baseUrl} (${error instanceof Error ? error.message : String(error)}).\n`);
    return 1;
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    stdout.write(`UNVERIFIED: dashboard status endpoint returned HTTP ${response.status}.\n`);
    return 2;
  }

  let status: unknown;
  try {
    status = await response.json();
  } catch {
    stdout.write('UNVERIFIED: dashboard status endpoint did not return JSON.\n');
    return 2;
  }
  if (!isStatusResponse(status)) {
    stdout.write('UNVERIFIED: dashboard status endpoint returned an incomplete identity.\n');
    return 2;
  }

  stdout.write('RESPONSIVE: dashboard returned its startup build identity.\n');
  stdout.write(`pid: ${status.pid}\n`);
  stdout.write(`startedAt: ${status.startedAt}\n`);
  stdout.write(`loaded_build: ${hash(status.loadedBuild)}\n`);
  stdout.write(`disk_build: ${hash(status.diskBuild)}\n`);
  if (status.freshness === 'fresh') {
    stdout.write('FRESH: disk dist matches the build loaded by the running dashboard.\n');
    return 0;
  }
  if (status.freshness === 'stale') {
    stdout.write('STALE: disk dist differs from the build loaded by the running dashboard.\n');
    stdout.write(`Next step: kill ${status.pid} && PORT=${port} flowcrew start\n`);
    return 2;
  }
  stdout.write(`UNVERIFIED: ${status.reason ?? 'dashboard freshness could not be proved'}.\n`);
  return 2;
}
