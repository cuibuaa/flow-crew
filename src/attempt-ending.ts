/** Budget policy consumes structured endings, never diagnostic prose. Process
 * termination remains evidence (and compatibility data), not another policy. */
export const ENDING_CAUSES = ['complete', 'host_restart', 'process_death', 'environment_gap',
  'provider_quota', 'work_unfinished', 'work_failed', 'cancelled', 'engine_void', 'launch_conflict', 'unknown'] as const;
export type EndingCause = typeof ENDING_CAUSES[number];
export interface EndingFacts {
  exitCode?: number;
  processSignal?: string | null;
  engineVoid?: boolean;
  launchConflict?: boolean;
  cancelled?: boolean;
  interrupted?: boolean;
  fromBoot?: string;
  toBoot?: string;
  providerQuota?: boolean;
  environmentGap?: boolean;
  unfinished?: boolean;
}
export function classifyEnding(facts: EndingFacts): EndingCause {
  if (facts.engineVoid) return 'engine_void';
  if (facts.launchConflict) return 'launch_conflict';
  if (facts.cancelled) return 'cancelled';
  if (facts.interrupted) return facts.fromBoot && facts.toBoot
    ? facts.fromBoot !== facts.toBoot ? 'host_restart' : 'process_death' : 'unknown';
  if (facts.providerQuota) return 'provider_quota';
  if (facts.environmentGap) return 'environment_gap';
  if (facts.processSignal && facts.exitCode !== 0 && !facts.unfinished) return 'process_death';
  if (facts.exitCode !== undefined && facts.exitCode !== 0) return 'work_failed';
  if (facts.unfinished) return 'work_unfinished';
  return facts.exitCode === 0 ? 'complete' : 'unknown';
}
