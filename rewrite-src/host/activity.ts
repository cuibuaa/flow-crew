import { stat } from 'node:fs/promises';
import type { Owner, Invocation, AttemptAddress } from '../contract/runtime.js';
import type { ActivityEvent } from '../contract/live.js';
import { identity } from './process.js';

// Existing observation window; silence is advisory, never an execution deadline.
export const INACTIVITY_WINDOW_MS = 10 * 60_000;
export const INACTIVITY_MESSAGE = 'no observed progress for 10 min';
export interface ActivitySample { readonly stdout: number; readonly stderr: number; readonly lastEventAt?: string | null; }
export type ActivityState = 'observing' | 'progress' | 'quiet' | 'unknown';
export interface ExecutionActivity {
  readonly invocation: Invocation;
  readonly source: 'author' | 'gate' | 'command';
  readonly command?: string;
  readonly stage: string | null;
  readonly state: 'current' | 'ended';
  readonly lastEventAt: string | null;
  readonly lastTool: string | null;
  readonly summary: string | null;
  readonly toolRunning: boolean;
  readonly observation: ActivityState;
  readonly sample?: { readonly at: number; readonly value: ActivitySample; readonly progressAt: number };
  readonly notice?: { readonly cursor: number; readonly message: 'no observed progress for 10 min' };
}
export interface GuideDelivery { readonly guide: string; readonly invocation: AttemptAddress; }
export interface GuideStatus { readonly guide: string; readonly state: 'pending' | 'delivered'; readonly invocation?: AttemptAddress; }
// Additive consumer facts. The frozen live adapter contract is unchanged.
declare module '../contract/runtime.js' {
  interface RunProjection { readonly guideDeliveries?: readonly GuideDelivery[]; }
  interface RunStatusFile { readonly guidance?: readonly GuideStatus[]; readonly activity?: readonly ExecutionActivity[]; }
}

/** A provider message during a tool does not establish progress of that tool. */
export function authorActivity(previous: ExecutionActivity, event: ActivityEvent): ExecutionActivity {
  if (previous.state === 'ended' || event.kind === 'message') return previous;
  const {notice:_notice,...current}=previous;
  return { ...current, lastEventAt: event.kind === 'turn-end' ? previous.lastEventAt : event.at, lastTool: event.tool ?? previous.lastTool,
    summary: event.summary?.slice(0, 200) ?? previous.summary,
    toolRunning: event.kind === 'tool-start',
    state: event.kind === 'turn-end' ? 'ended' : 'current', observation: 'progress' };
}
export function quietObservation(activity: ExecutionActivity, at: number): ActivityState {
  const elapsed=activity.lastEventAt === null ? NaN : at-Date.parse(activity.lastEventAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'unknown';
  return activity.state === 'current' && activity.toolRunning && elapsed >= INACTIVITY_WINDOW_MS
    ? 'quiet' : 'progress';
}
/** Byte progress is attributable only to an engine command's own streams. No CPU tree scan. */
export async function sampleActivity(owner: Owner): Promise<ActivitySample | null> {
  try {
    const before = await identity(owner.pid);
    if (before.start !== owner.start || before.boot !== owner.boot || before.group !== owner.group || !owner.streams) return null;
    const [stdout, stderr, after] = await Promise.all([stat(owner.streams.stdout), stat(owner.streams.stderr), identity(owner.pid)]);
    if (before.start !== after.start || before.boot !== after.boot || before.group !== after.group || !stdout.isFile() || !stderr.isFile()) return null;
    const eventTimes = [stdout,stderr].filter(stream=>stream.size > 0).map(stream=>stream.mtimeMs);
    return { stdout: stdout.size, stderr: stderr.size,
      lastEventAt:eventTimes.length ? new Date(Math.max(...eventTimes)).toISOString() : null };
  } catch { return null; }
}
/** Existing cadence supplies time; polling never refreshes the last progress time. */
export class ActivityWindow {
  constructor(public sample?: NonNullable<ExecutionActivity['sample']>) {}
  observe(at: number, value: ActivitySample | null): ActivityState {
    const previous = this.sample;
    if (!value || previous && (at < previous.at || value.stdout < previous.value.stdout || value.stderr < previous.value.stderr)) {
      this.sample = undefined; return 'unknown';
    }
    const progress = !previous || value.stdout > previous.value.stdout || value.stderr > previous.value.stderr;
    this.sample = { at, value, progressAt: progress ? at : previous.progressAt };
    return progress ? previous ? 'progress' : 'observing'
      : at - this.sample.progressAt >= INACTIVITY_WINDOW_MS ? 'quiet' : 'observing';
  }
}
