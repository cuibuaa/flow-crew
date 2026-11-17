import { nextLifecycle } from '../records/lifecycle.mjs';
// Canonical wire decoder; only builtins, also bundled verbatim into the session hook.
/** @typedef {import('./runtime.js').RunStatusFile} RunStatusFile */
/** @typedef {(value: any) => boolean} Check */
/** @param {any} value */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {Record<string, Check>} required @param {Record<string, Check>} optional @param {boolean} extensible @returns {Check} */
const record = (required, optional = {}, extensible = false) => value => object(value)
  && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
  && Object.entries(optional).every(([key, check]) => value[key] === undefined || check(value[key]))
  && (extensible || Object.keys(value).every(key => Object.hasOwn(required, key) || Object.hasOwn(optional, key)));
/** @param {Check} check @returns {Check} */
const array = check => value => Array.isArray(value) && value.every(check);
/** @param {any[]} values @returns {Check} */
const one = (...values) => value => values.includes(value);
/** @param {Check} check @returns {Check} */
const nullable = check => value => value === null || check(value);
/** @type {Check} */
const text = value => typeof value === 'string';
/** @type {Check} */
const bool = value => typeof value === 'boolean';
/** @type {Check} */
const natural = value => Number.isSafeInteger(value) && value >= 0;
/** @type {Check} */
const number = value => typeof value === 'number' && Number.isFinite(value);
/** @type {Check} */
const id = value => text(value) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
/** @type {Check} */
const path = value => text(value) && (value.startsWith('/') ? value.slice(1) : value).split('/').every(/** @param {string} s */ s => !!s && s !== '.' && s !== '..' && !/[\x00-\x1f\x7f\\:*?\[\]{}]/.test(s));
/** @type {Check} */
const hash = value => text(value) && /^[a-f0-9]{64}$/.test(value);
const ref = record({path: value => path(value) && value.split('/').every(/** @param {string} s */ s =>
  !!s && s !== '.' && s !== '..' && !/[\\:*?\[\]{}]/.test(s)), sha256: hash});
/** @type {Check} */
const timestamp = value => text(value) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value.slice(0,10);
const backend = one('codex', 'claude'), roots = array(path), grant = record({writableRoots: roots, protectedRoots: roots});
const original = one('absent','file','directory','other'), admission = one('absent','present','either');
/** @type {Check} */
const dictionary = value => object(value) && Object.values(value).every(text);
const authorityFields = {
  project: path, interpretation: array(text),
  preferences: array(record({role:id, backend, settings:record({source:record({model:one('role','settings','builtin'),
    effort:one('role','settings','builtin')})},{model:text,effort:text})})),
  parents:array(record({path, original, mode:value => natural(value) && value <= 0o7777})),
  outputs:array(record({path,absolute:path,kind:one('file','directory'),admission,original,write:one('project','exact'),
    provision:bool,baseline:one('original-manifest'),mutation:one('tree','in-place'),
    delivery:record({original:admission,append:bool,nonempty:bool})})),
  resources:array(record({path,access:one('exclusive-write','shared-write','stable-read')})),
  purposes:record({plan:grant,work:grant,gate:grant,command:grant}),providers:record({codex:roots,claude:roots}),
  commands:array(record({id:text,scratch:path,grant,env:dictionary}))
};
const authorityOptional = {backend,aliases:array(record({source:path,destination:path,dev:number,ino:number,sourceDev:number,sourceIno:number,
  nlink:number,sourceNlink:number,writable:bool}))};
// Persisted views accept additive metadata from older writers; current fields still validate.
export const validAuthority = record(authorityFields, authorityOptional, true);
const identity = record({run:id,runtime:ref,authority:value => text(value) && !!value});
const condition = one(null,'gate','failure');
const stop = one('completed','accepted_blocked','gate_irreparable','command_missing','command_nonzero','command_unfinished',
  'outputs_unpreserved','backstop','attempt_failed','contract_refused','isolation_refused','cancelled','recovery_unknown','closure_unconfirmed','accounting_unsettled','claim_unreleased');
const gate = record({stage:id,attempt:id,scope:one('progress','delivery'),outcome:one('accepted','accepted_blocked',
  'rejected_repairable','rejected_irreparable'),answer:ref,cursor:value => natural(value) && value > 0},{result:id});
const statusFields = {
  version:one(2),publishedAt:timestamp,run:id,identity,status:one('pending','running','parked','complete','accepted_blocked',
    'incomplete','failed','escalated','cancelled'),statusSince:natural,currentStage:nullable(id),journalCursor:natural,
  stopReason:nullable(stop),gates:array(gate),
  backstop:record({rule:one('C2'),gateThreshold:one(3),failureThreshold:one(4),scope:one('engine-outcomes'),
    gateSuffix:natural,failureSuffix:natural,bestPassCount:nullable(natural),segment:natural,
    settlement:nullable(text),obligation:nullable(text),condition}),
  step:record({startedAt:nullable(timestamp),elapsedMs:nullable(natural)}),
  usage:record({state:one('known','partial','unknown'),raw:array(ref),invocations:natural,activeDurationMs:nullable(natural)},
    {input:natural,output:natural,cached:natural,costUsd:value => number(value) && value >= 0}),
  attention:nullable(record({reason:stop,detail:text,condition},{obligations:array(record({kind:one('closure-unconfirmed','accounting-unsettled','claim-unreleased'),detail:text,members:array(record({pid:natural,state:text,parent:nullable(natural)}))},{owner:object}))})),
  host:record({readiness:one('applied','unavailable','refused'),interpretation:array(text)},{boot:text}),
  notification:record({session:one('bound','unbound'),scope:one('persistent-status; optional bound-session wake'),
    transport:one('unobserved')})
};
const statusOptional = {reclaimed:record({at:timestamp,delivery:path}),
  interruption:record({detail:one('interrupted by restart'),resume:text}),requester:/** @param {any} value */ value => text(value) && /^[A-Za-z0-9._:-]{1,200}$/.test(value),authority:validAuthority};
const shape = record(statusFields, statusOptional, true);
/** @type {Record<string, (string|null)[]>} */
const reasons = {pending:[null],running:[null],parked:['backstop','attempt_failed','recovery_unknown','closure_unconfirmed','accounting_unsettled','claim_unreleased'],complete:['completed'],
  accepted_blocked:['accepted_blocked'],incomplete:['command_missing','command_nonzero','command_unfinished','outputs_unpreserved'],
  failed:['gate_irreparable','attempt_failed','contract_refused','isolation_refused'],escalated:['recovery_unknown'],cancelled:['cancelled']};
/** @param {any} value @returns {value is RunStatusFile} */
export function validStatus(value) {
  if (!shape(value) || value.identity.run !== value.run || value.statusSince > value.journalCursor
    || !reasons[value.status].includes(value.stopReason)
    || value.currentStage !== null && !['running','parked'].includes(value.status)
    || value.notification.session !== (value.requester === undefined ? 'unbound' : 'bound')) return false;
  const obligations = value.attention?.obligations;
  const attention = !['pending','running'].includes(value.status) || !!obligations?.length;
  if (attention && value.attention === null || !attention && value.attention !== null && !value.interruption || value.attention && (obligations?.length || value.interruption
    ? (obligations?.length ? value.attention.reason !== obligations[0].kind.replaceAll('-','_') : value.attention.reason !== 'recovery_unknown') || value.attention.condition !== null
    : value.attention.reason !== value.stopReason || value.attention.condition !== value.backstop.condition)) return false;
  const c = value.stopReason === 'backstop' ? value.backstop.gateSuffix >= 3 ? 'gate'
    : value.backstop.failureSuffix >= 4 ? 'failure' : undefined : null;
  if (c === undefined || value.backstop.condition !== c) return false;
  const keys = new Set();
  return value.gates.every(/** @param {any} g */ g => {
    const key = JSON.stringify([g.stage,g.attempt]);
    if (keys.has(key) || g.cursor > value.journalCursor || g.scope === 'progress' && g.result !== undefined) return false;
    keys.add(key); return true;
  });
}
/** Keep only fields in the current view, including its nested authority.
 * @param {any} value @param {Record<string, Check>} required @param {Record<string, Check>} optional
 */
const project = (value, required, optional) => Object.fromEntries(Object.keys({...required,...optional})
  .filter(key => Object.hasOwn(value, key)).map(key => [key,value[key]]));
/** @param {unknown} value @returns {import('./brief.js').Result<RunStatusFile>} */
export function parseRunStatusFile(value) {
  if (!validStatus(value)) return {ok:false,kind:'invalid',detail:'Unsupported or invalid status.json v2'};
  const current = project(value, statusFields, statusOptional);
  if (current.authority) current.authority = project(current.authority, authorityFields, authorityOptional);
  return {ok:true,value:/** @type {RunStatusFile} */ (current)};
}
export const RUN_STATUS_LAYOUT = {runsDirectory:'runs',fileName:'status.json'};

/** Reader interpretation of existing activation identity, with no state change or automatic resume.
 * @param {RunStatusFile} status @param {string | undefined} boot @returns {RunStatusFile}
 */
export function withCurrentBoot(status, boot) {
  if (!boot) return status;
  const { interruption: _previous, ...snapshot } = status;
  return boot && status.host.boot && boot !== status.host.boot && nextLifecycle(status.status, 'resume') !== null
    && !status.reclaimed ? {...snapshot,
      step:{...snapshot.step,elapsedMs:null},
      attention:{reason:'recovery_unknown',detail:`interrupted by restart; flowcrew resume ${status.run}`,condition:null},
      interruption:{detail:'interrupted by restart',resume:`flowcrew resume ${status.run}`}} : snapshot;
}
