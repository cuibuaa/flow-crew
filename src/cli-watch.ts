import { createWatchState, pollWatch, type WatchAlert, type WatchPollDependencies, type WatchPollResult } from './watch.js';

type Writer = { write(chunk: string): unknown };

export const DEFAULT_WATCH_POLL_MS = 45_000;
export const MIN_WATCH_POLL_MS = 1_000;
export const MAX_WATCH_POLL_MS = 3_600_000;

interface ParsedWatchArgs {
  help: boolean;
  once: boolean;
  pollMs: number;
}

export interface CliWatchDependencies extends WatchPollDependencies {
  stdout?: Writer;
  stderr?: Writer;
  sleep?: (milliseconds: number) => Promise<void>;
}

function optionValue(args: string[], index: number, option: string): { value: string; consumed: number } {
  const current = args[index];
  const inlinePrefix = `${option}=`;
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return { value, consumed: 2 };
}

export function parseWatchArgs(args: string[]): ParsedWatchArgs {
  let help = false;
  let once = false;
  let pollMs = DEFAULT_WATCH_POLL_MS;
  const start = args[0] === 'watch' ? 1 : 0;
  for (let index = start; index < args.length;) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      index += 1;
      continue;
    }
    if (argument === '--once') {
      once = true;
      index += 1;
      continue;
    }
    if (argument === '--poll' || argument.startsWith('--poll=')) {
      const parsed = optionValue(args, index, '--poll');
      if (!/^(?:\d+|\d+\.\d+)$/.test(parsed.value)) {
        throw new Error('--poll must be a number of seconds');
      }
      pollMs = Number(parsed.value) * 1_000;
      if (!Number.isFinite(pollMs)
        || pollMs < MIN_WATCH_POLL_MS
        || pollMs > MAX_WATCH_POLL_MS) {
        throw new Error(`--poll must be between ${MIN_WATCH_POLL_MS / 1_000} and ${MAX_WATCH_POLL_MS / 1_000} seconds`);
      }
      index += parsed.consumed;
      continue;
    }
    throw new Error(`unknown watch option: ${argument}`);
  }
  return { help, once, pollMs };
}

export function watchUsage(): string {
  return [
    'Usage: flowcrew watch [--once] [--poll <seconds>]',
    'Reports a first-pass heartbeat and edge-triggered stall judgements for live runs, plus status contradictions for readable runs.',
    `Poll interval must be between ${MIN_WATCH_POLL_MS / 1_000} and ${MAX_WATCH_POLL_MS / 1_000} seconds (default ${DEFAULT_WATCH_POLL_MS / 1_000}).`,
  ].join('\n');
}

function oneLine(value: string): string {
  const compact = value.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function alertLine(alert: WatchAlert): string {
  const run = oneLine(alert.runId);
  if (alert.kind === 'terminal_status_mismatch') {
    return `[STATUS MISMATCH] ${run}: lifecycle status ${oneLine(alert.lifecycleStatus)}; `
      + `terminal artifact ${JSON.stringify(oneLine(alert.terminalArtifact))} declares ${oneLine(alert.terminalStatus)}`;
  }
  if (alert.kind === 'stage_attempts') {
    return `[STALL] ${run} stage ${oneLine(alert.stageId)} reached attempt ${alert.attempts}`;
  }
  return `[STALL] ${run} gate ${oneLine(alert.gateId)} rejected ${alert.rejections}x on ${oneLine(alert.metric)}, `
    + `${alert.previousScore} -> ${alert.latestScore} against threshold ${alert.threshold} -- not converging`;
}

export function formatWatchPoll(result: WatchPollResult): string[] {
  const lines: string[] = [];
  if (result.heartbeat) {
    const stats = result.heartbeat.stats;
    const diagnostics: string[] = [];
    if (stats.unreadableRuns > 0) diagnostics.push(`${stats.unreadableRuns} unreadable run entr${stats.unreadableRuns === 1 ? 'y' : 'ies'}`);
    if (stats.invalidVerdicts > 0) diagnostics.push(`${stats.invalidVerdicts} invalid verdict${stats.invalidVerdicts === 1 ? '' : 's'}`);
    if (stats.archiveReadErrors > 0) diagnostics.push(`${stats.archiveReadErrors} archive read error${stats.archiveReadErrors === 1 ? '' : 's'}`);
    if (stats.rootReadErrors > 0) diagnostics.push('runs root unavailable');
    lines.push(`[WATCH] armed · ${stats.entries} entries · ${stats.readableRuns} readable · `
      + `${stats.liveRuns} live run(s) · scan ${(stats.elapsedMs / 1_000).toFixed(2)}s`
      + (diagnostics.length > 0 ? ` · diagnostics: ${diagnostics.join(', ')}` : ''));
  }
  for (const alert of result.alerts) lines.push(alertLine(alert));
  return lines;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function cmdWatchWithDeps(args: string[], overrides: CliWatchDependencies): Promise<number> {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const wait = overrides.sleep ?? sleep;
  let parsed: ParsedWatchArgs;
  try {
    parsed = parseWatchArgs(args);
  } catch (error) {
    stderr.write(`watch: ${errorMessage(error)}\n`);
    stderr.write(`${watchUsage()}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${watchUsage()}\n`);
    return 0;
  }

  let state = createWatchState();
  let polling = true;
  while (polling) {
    const result = pollWatch(state, overrides);
    state = result.state;
    for (const line of formatWatchPoll(result)) stdout.write(`${line}\n`);
    if (parsed.once) polling = false;
    else await wait(parsed.pollMs);
  }
  return 0;
}

export async function cmdWatch(args: string[]): Promise<number> {
  return cmdWatchWithDeps(args, {});
}
