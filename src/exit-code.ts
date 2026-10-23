/** Command results: only an unconfirmed outcome may use 2. */
export const EXIT_CODE = {
  completed: 0,
  failed: 1,
  outcomeUnknown: 2,
} as const;

// Status probes (daemon/dashboard status): 0 fresh, 1 unavailable/invalid usage,
// 2 stale, nonresponsive or unverified. Session-push hook/wake retain their
// external blocking-error contract: 2 requests frontend intervention.
