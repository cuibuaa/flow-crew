// Pure lifecycle reducer, shared by SQL reduction and the builtins-only status reader.
/** @typedef {import('./runtime.js').RunStatus} RunStatus */
/** @typedef {'preparing'|'refused'|'pending'|'running'|'parked'|'completed'|'failed'|'cancelled'} Lifecycle */
/** @typedef {'run'|'park'|'complete'|'fail'|'cancel'|'resume'|'obligation'|'observe'} LifecycleFact */
/** @type {Record<Lifecycle, Record<LifecycleFact, Lifecycle | null> & { final: boolean }>} */
const lifecycleTable = {
  preparing: { final: false, run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'preparing', observe: 'preparing' },
  refused:   { final: true, run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'refused', observe: 'refused' },
  pending:   { final: false, run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'pending', observe: 'pending' },
  running:   { final: false, run: 'running', park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'running', obligation: 'parked', observe: 'running' },
  parked:    { final: false, run: null, park: 'parked', complete: 'completed', fail: 'failed', cancel: 'cancelled', resume: 'pending', obligation: 'parked', observe: 'parked' },
  completed: { final: true, run: null, park: null, complete: null, fail: null, cancel: 'completed', resume: null, obligation: 'completed', observe: 'completed' },
  failed:    { final: true, run: null, park: null, complete: null, fail: null, cancel: 'failed', resume: null, obligation: 'failed', observe: 'failed' },
  cancelled: { final: true, run: null, park: null, complete: null, fail: null, cancel: 'cancelled', resume: null, obligation: 'cancelled', observe: 'cancelled' },
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
export const isFinal = (status) => lifecycleTable[lifecycle(status)].final;
