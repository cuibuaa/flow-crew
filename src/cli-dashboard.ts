import type { DashboardStatusResponse } from './dashboard.js';

interface TextWriter {
  write(chunk: string): unknown;
}

export interface DashboardCommandOptions {
  stdout?: TextWriter;
  stderr?: TextWriter;
  fetch?: typeof globalThis.fetch;
  /** Test seam for an already-resolved dashboard origin. */
  baseUrl?: string;
  timeoutMs?: number;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(writer: TextWriter): void {
  writer.write('Usage: flowcrew dashboard status [--port N]\n');
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
  const subcommand = args[1];
  if (args.includes('--help') || args.includes('-h')) {
    usage(stdout);
    return 0;
  }
  if (subcommand !== 'status') {
    usage(stderr);
    return 1;
  }

  const portValue = valueAfter(args, '--port') ?? process.env.PORT ?? '3000';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    stderr.write(`Invalid dashboard port: ${portValue}\n`);
    return 1;
  }
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/dashboard/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    stdout.write(`UNREACHABLE: dashboard did not answer at ${baseUrl} (${error instanceof Error ? error.message : String(error)}).\n`);
    return 1;
  }
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
