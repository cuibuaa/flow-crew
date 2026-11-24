/**
 * Live invocation contract (0.12.0). Shared by the loop (guidance), provider adapters (mid-turn steering and live
 * events) and observers (activity, status, monitor). Adapters produce; the loop and observers consume.
 */

/** Outcome of queueing text into a running author turn through the provider's native mid-turn input. */
export type SteerOutcome = 'delivered' | 'refused' | 'ended';

export interface LiveInvocation {
  /**
   * Queue text into the running author turn. Resolves 'delivered' once the provider accepted it into the active turn,
   * 'refused' when the provider rejected same-turn input (the text was not consumed), 'ended' when the turn already ended.
   */
  steer(text: string): Promise<SteerOutcome>;
}

export type ActivityKind = 'tool-start' | 'tool-end' | 'message' | 'turn-end';

/** One decoded provider event, observed while the invocation is still running. */
export interface ActivityEvent {
  /** ISO time at which FlowCrew observed the event. */
  readonly at: string;
  readonly kind: ActivityKind;
  /** Provider tool name, when the event concerns a tool. */
  readonly tool?: string;
  /** At most 200 characters: the head of a command or message. Never credentials or environment values. */
  readonly summary?: string;
}

export interface LiveHooks {
  /** Called once, when the provider is ready to accept steering for this invocation. */
  readonly onLive?: (live: LiveInvocation) => void;
  /** Called for each decoded provider event while the invocation runs, in observation order. */
  readonly onActivity?: (event: ActivityEvent) => void;
}
