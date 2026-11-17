// Pure lifecycle reducer, shared by SQL reduction and the builtins-only status reader.
/** @typedef {import('../contract/runtime.js').RunStatus} RunStatus */
/** @typedef {'pending'|'running'|'parked'|'completed'|'failed'|'cancelled'} Lifecycle */
/** @typedef {'run'|'park'|'complete'|'fail'|'cancel'|'resume'|'obligation'|'observe'} LifecycleFact */
/** @type {Record<Lifecycle, Record<LifecycleFact, Lifecycle | null>>} */
const lifecycleTable = {
  pending:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'pending', observe: 'pending' },
  running:   { run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'running', obligation: 'parked', observe: 'running' },
  parked:    { run: null, park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'parked', observe: 'parked' },
  completed: { run: null, park: null, complete: null, fail: null, cancel: 'completed', resume: null, obligation: 'completed', observe: 'completed' },
  failed:    { run: null, park: null, complete: null, fail: null, cancel: 'failed', resume: null, obligation: 'failed', observe: 'failed' },
  cancelled: { run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'cancelled', observe: 'cancelled' },
};
/** @param {RunStatus} status @returns {Lifecycle} */
export function lifecycle(status) {
  if (status === 'complete' || status === 'accepted_blocked') return 'completed';
  if (status === 'incomplete' || status === 'escalated') return 'failed';
  return status;
}
/** @param {RunStatus | Lifecycle} status @param {LifecycleFact} fact @returns {Lifecycle | null} */
export const nextLifecycle = (status, fact) =>
  lifecycleTable[status === 'completed' ? status : lifecycle(status)][fact];
/** @param {RunStatus} status */
export const isFinal = (status) => nextLifecycle(status, 'resume') === null;
