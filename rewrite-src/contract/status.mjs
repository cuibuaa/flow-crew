import {ignoreRetired} from './retirement.mjs';
import { nextLifecycle } from './lifecycle.mjs';
// Shared wire fields for journal files and public read-only availability output, bundled into the session hook.
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
    baseline:one('original-manifest'),
    delivery:record({original:admission,append:bool,nonempty:bool})},{provision:bool,mutation:one('tree','in-place')})),
  resources:array(record({path,access:one('exclusive-write','shared-write','stable-read')})),
  commands:array(record({id:text,scratch:path,env:dictionary},{grant}))
};
const authorityOptional = {backend,purposes:record({plan:grant,work:grant,gate:grant,command:grant}),
  providers:record({codex:roots,claude:roots}),aliases:array(record({source:path,destination:path,dev:number,ino:number,sourceDev:number,sourceIno:number,
  nlink:number,sourceNlink:number,writable:bool}))};
// Persisted views accept additive metadata from older writers; current fields still validate.
export const validAuthority = record(authorityFields, authorityOptional, true);
const identity = record({run:id,runtime:ref,authority:value => text(value) && !!value});
const condition = one(null,'gate','failure');
const stop = one('completed','accepted_blocked','gate_irreparable','command_missing','command_nonzero','command_unfinished',
  'outputs_unpreserved','backstop','attempt_failed','contract_refused','isolation_refused','cancelled','recovery_unknown','closure_unconfirmed','accounting_unsettled','claim_unreleased');
const gate = record({stage:id,attempt:id,scope:one('progress','delivery'),outcome:one('accepted','accepted_blocked',
  'rejected_repairable','rejected_irreparable'),answer:ref,cursor:value => natural(value) && value > 0},{result:id});
const positive = /** @param {any} value */ value => natural(value) && value > 0;
const birth = /** @param {any} value */ value => text(value) && !!value;
const owner = record({pid:positive,start:birth,boot:birth,group:positive,authority:birth}, {}, true);
const activation = record({state:one('active','inactive','unknown'),owner:nullable(owner),checkedAt:nullable(timestamp)});
const ending = one('delivered','invalid_answer','invalid_plan','work_failed','technical_failure','auth','refused',
  'input_too_large','quota','duration','cancelled','isolation_failure','closure_unknown','provider_unknown');
const backstopFields = {rule:one('C2'),gateThreshold:one(3),failureThreshold:one(4),scope:one('engine-outcomes'),
  gateSuffix:natural,failureSuffix:natural,bestPassCount:nullable(natural),segment:natural,
  settlement:nullable(text),obligation:nullable(text),condition};
const attentionFields = {reason:stop,detail:text,condition};
const attentionOptional = {obligations:array(record({kind:one('closure-unconfirmed','accounting-unsettled','claim-unreleased'),detail:text,members:array(record({pid:natural,state:text,parent:nullable(natural)}))},{owner:object}))};
const statusFields = {
  version:one(2,3,4),publishedAt:timestamp,run:id,identity,status:one('pending','running','parked','complete','accepted_blocked',
    'incomplete','failed','escalated','cancelled','interrupted','unknown'),statusSince:natural,currentStage:nullable(id),focus:nullable(id),journalCursor:natural,
  stopReason:nullable(stop),gates:array(gate),
  backstop:record(backstopFields,{pausedAt:timestamp}),
  step:record({startedAt:nullable(timestamp),elapsedMs:nullable(natural)},{label:nullable(text),stageLabel:nullable(text),attempt:nullable(id)}),
  usage:record({state:one('known','partial','unknown'),raw:array(ref),invocations:natural,activeDurationMs:nullable(natural)},
    {input:natural,output:natural,cached:natural,costUsd:value => number(value) && value >= 0}),
  attention:nullable(record(attentionFields,{...attentionOptional,cause:one('resume_refused')})),
  host:record({interpretation:array(text)},{activation,boot:text,readiness:one('applied','unavailable','refused')}),
  notification:record({session:one('bound','unbound'),scope:one('persistent-status; optional bound-session wake'),
    transport:one('unobserved')})
};
/** A work or plan stage must carry `carried`; a gate has none of them, so only a gate may omit them (older files still show some).
 * @param {Record<string, Check>} required @param {Record<string, Check>} optional @param {Record<string, Check>} carried @returns {Check} */
const withCarried = (required, optional, carried) => {
  const gate = record(required, {...optional, ...carried}), other = record({...required, ...carried}, optional);
  return value => (object(value) && value.purpose === 'gate' ? gate : other)(value);
};
const stageFields = {id,purpose:one('work','gate','plan'),role:id,after:array(id),
  commands:array(id),revision:id,state:one('pending','dormant','running','settled','skipped'),attempts:natural,
  lastEnding:nullable(ending),
  verdict:nullable(one('accepted','accepted_blocked','rejected_repairable','rejected_irreparable')),
  startedAt:nullable(timestamp),settledAt:nullable(timestamp)};
const segmentFields = {kind:one('attempt','pause'),startedAt:nullable(timestamp),endedAt:nullable(timestamp)};
const segmentOptional = {attempt:id,invocation:positive,ending};
const stageDefinition = withCarried({id,role:id,purpose:one('work','gate','plan'),after:array(id)},
  {commands:array(id),skills:array(id),baseCheckpoint:id,repair:record({stage:id,returnsTo:id})},{instruction:text});
const stageCarried = {goal:text,instruction:text};
const stageOptional = {replacedBy:id,summary:text,
  segments:array(record(segmentFields,{...segmentOptional,elapsedMs:natural})),
  commandProgress:array(record({command:id,state:one('passed','running','not_started','failed','unfinished')},{reused:text,source:text,basis:one('pre-existing','introduced')}))};
const invocationAddress = record({run:id,stage:id,attempt:id,invocation:positive});
const invocation = record({charge:one('plan','work','continuation','technical','correction','command'),address:value =>
  record({kind:one('stage'),run:id,stage:id,attempt:id,invocation:positive})(value) || record({kind:one('final'),run:id})(value)});
const activity = record({invocation,source:one('author','gate','command'),stage:nullable(id),state:one('current','ended'),lastEventAt:nullable(timestamp),
  lastTool:nullable(text),summary:nullable(text),toolRunning:bool,observation:one('observing','progress','quiet','unknown')},
  {command:id,notice:record({cursor:positive,message:one('no observed progress for 10 min')})});
const v4Optional = {activity:array(activity),guidance:array(record({guide:id,state:one('pending','delivered')},{invocation:invocationAddress})),checkpoints:record({count:natural,latestAt:nullable(timestamp)}),title:text,heldBytes:natural};
const statusOptional = {...v4Optional,startedAt:timestamp,lastActivityAt:timestamp,endedAt:timestamp,stages:array(withCarried(stageFields,stageOptional,stageCarried)),plan:record({revision:id,pending:record({stages:array(stageDefinition)},
  {observations:array(object)})}),journalStatus:one('pending','running','parked','complete','accepted_blocked','incomplete','failed','escalated','cancelled'),commandActivity:array(record({command:id,stage:nullable(id),state:one('observing','progress','quiet','unknown')},
  {notice:record({cursor:value => natural(value) && value > 0,message:one('no observed progress for 10 min')})})),unconfinedCommands:array(id),reclaimed:record({at:timestamp,delivery:path}),
  interruption:record({detail:one('interrupted by restart','interrupted'),resume:text}),requester:/** @param {any} value */ value => text(value) && /^[A-Za-z0-9._:-]{1,200}$/.test(value),authority:validAuthority};
const {focus,...fileFields} = statusFields;
// v2/v3 stored displayed stages and availability. v4 publishes journal facts only.
const historicalFields = {...fileFields,backstop:record(backstopFields),
  attention:nullable(record(attentionFields,attentionOptional))};
const historicalOptional = {...statusOptional,...Object.fromEntries(Object.keys(v4Optional).map(key => [key,one()]))};
const historicalStages = {...stageFields,state:one('pending','running','settled','skipped','parked','needs-correction')};
const historicalShape = record({...historicalFields,version:one(2,3)}, {...historicalOptional,focus,
  stages:array(withCarried(historicalStages,{...stageOptional,segments:array(record(segmentFields,segmentOptional))},stageCarried))}, true);
const journalShape = record({...statusFields,version:one(4),status:statusOptional.journalStatus}, statusOptional, true);
/** @param {any} value */
const fileShape = value => (value?.version === 4 ? journalShape : historicalShape)(value);
const displayedStages = array(withCarried({...stageFields,
  state:one('pending','running','settled','skipped','parked','needs-correction','interrupted','unknown')},stageOptional,stageCarried));
const historicalOutputShape = record({...historicalFields,focus},{...historicalOptional,stages:displayedStages},true);
const journalOutputShape = record(statusFields,{...statusOptional,stages:displayedStages},true);
/** @param {any} value */
const outputShape = value => (value?.version === 4 ? journalOutputShape : historicalOutputShape)(value);
/** @type {Record<string, (string|null)[]>} */
const reasons = {pending:[null],running:[null],parked:['backstop','attempt_failed','recovery_unknown','closure_unconfirmed','accounting_unsettled','claim_unreleased'],complete:['completed'],
  accepted_blocked:['accepted_blocked'],incomplete:['command_missing','command_nonzero','command_unfinished','outputs_unpreserved'],
  failed:['gate_irreparable','attempt_failed','contract_refused','isolation_refused'],escalated:['recovery_unknown'],cancelled:['cancelled']};
/** @param {any} value @param {Check} shape */
function validSnapshot(value, shape) {
  if (!shape(value) || value.version === 2 && !Object.hasOwn(value.host, 'readiness')
    || value.version !== 2 && (Object.hasOwn(value.host, 'readiness') || Object.hasOwn(value, 'unconfinedCommands'))
    || value.identity.run !== value.run || value.statusSince > value.journalCursor
    || !reasons[value.journalStatus ?? value.status]?.includes(value.stopReason)
    || value.notification.session !== (value.requester === undefined ? 'unbound' : 'bound')) return false;
  if (value.currentStage !== null && !(value.version === 4 ? ['running'] : ['running','parked']).includes(value.status)) return false;
  const obligations = value.attention?.obligations;
  const attention = !['pending','running'].includes(value.status) || !!obligations?.length;
  if (attention && value.attention === null || !attention && value.attention !== null && !value.interruption && value.host.activation?.state !== 'unknown' || value.attention && (obligations?.length || value.interruption || ['running','unknown'].includes(value.status) && value.host.activation?.state === 'unknown'
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
/** @param {any} value @returns {value is RunStatusFile} */
export const validStatus = value => validSnapshot(value,fileShape);
/** Keep only fields in the current view, including its nested authority.
 * @param {any} value @param {Record<string, Check>} required @param {Record<string, Check>} optional
 */
const project = (value, required, optional) => Object.fromEntries(Object.keys({...required,...optional})
  .filter(key => Object.hasOwn(value, key)).map(key => [key,value[key]]));
/** Project historical authority onto the content/execution facts used by new writes.
 * Validation is owned by validAuthority; this function never grants filesystem access.
 * @param {any} value @returns {import('./runtime.js').RunAuthority}
 */
export function currentAuthority(value) {
  const current = project(ignoreRetired(value, 'authority'), authorityFields, {backend});
  return /** @type {import('./runtime.js').RunAuthority} */ (current);
}
/** @param {unknown} value @returns {import('./brief.js').Result<RunStatusFile>} */
export function parseRunStatusFile(value) {
  return decodeStatus(value,fileShape,'status.json');
}
/** Decode displayed CLI single/list values; never feed them back through the availability overlay.
 * @param {unknown} value @returns {import('./brief.js').Result<RunStatusFile>}
 */
export function parsePublicRunStatus(value) {
  return decodeStatus(value,outputShape,'public status output');
}
/** @param {any} value @param {Check} shape @param {string} contract
 * @returns {import('./brief.js').Result<RunStatusFile>}
 */
function decodeStatus(value,shape,contract) {
  if (!validSnapshot(value,shape)) return {ok:false,kind:'invalid',detail:`Unsupported or invalid ${contract} v2/v3/v4`};
  // Historical writers published displayed state and aggregate stage times, not v4 journal facts.
  // Adapt once at the wire boundary; all readers consume these same intervals and focus.
  /** @type {Record<string, any>} */
  const current = {focus:value.version === 4 ? null : value.currentStage,...project(value, statusFields, statusOptional)};
  if (current.version !== 4 && current.stages) current.stages = current.stages.map(
    /** @param {import('./runtime.js').RunStageStatus} stage */ stage => {
      const running = stage.id === current.currentStage && stage.state === 'running';
      const startedAt = stage.startedAt ?? (running ? current.step.startedAt : null);
      return {...stage,...(stage.segments === undefined && startedAt !== null && (stage.settledAt !== null || running)
        ? {segments:[{kind:'attempt',startedAt,endedAt:stage.settledAt,
          ...(running && current.step.startedAt !== null && current.step.elapsedMs !== null
            ? {elapsedMs:Math.max(0,Date.parse(current.step.startedAt)-Date.parse(startedAt)+current.step.elapsedMs)} : {}),
          ...(stage.settledAt !== null && stage.lastEnding ? {ending:stage.lastEnding} : {})}]} : {})};
    });
  if (current.authority) current.authority = current.version !== 2 ? currentAuthority(current.authority)
    : project(current.authority, authorityFields, authorityOptional);
  return {ok:true,value:/** @type {RunStatusFile} */ (current)};
}
export const RUN_STATUS_LAYOUT = {runsDirectory:'runs',fileName:'status.json'};

/** Journal ending/disposition owns correction eligibility for both focus and display.
 * @param {import('./runtime.js').RunStageStatus} stage
 */
export const stageNeedsCorrection = stage => stage.lastEnding !== null && stage.lastEnding !== 'delivered'
  && !['settled','skipped'].includes(stage.state);

/** The only journal disposition/ending + observed availability + published focus -> display decision.
 * @param {import('./runtime.js').RunStageStatus} stage @param {RunStatusFile} snapshot
 * @returns {import('./runtime.js').RunStageStatus['state']}
 */
export function displayedStageState(stage, snapshot) {
  const raw = stage.state;
  return !stage.replacedBy && raw === 'running' && ['running','interrupted','unknown'].includes(snapshot.status)
    ? /** @type {'running'|'interrupted'|'unknown'} */ (snapshot.status)
    : (snapshot.journalStatus ?? snapshot.status) === 'parked' && !stage.replacedBy && stage.id === snapshot.focus
      && !['settled','skipped'].includes(raw) ? 'parked'
    : stageNeedsCorrection(stage) ? 'needs-correction'
    : raw === 'dormant' || raw === 'running' ? 'pending' : raw;
}
// One version dispatch owns native observation and the corresponding display projection.
/** @param {RunStatusFile} snapshot */
const recordedStatus = snapshot => snapshot;
/** @param {RunStatusFile} snapshot @param {(snapshot:RunStatusFile) => Promise<RunStatusFile>} observe */
const observedStatus = (snapshot, observe) => observe(snapshot);
const readContracts = {2:{observe:recordedStatus,display:recordedStatus},
  3:{observe:observedStatus,display:availableStatus},4:{observe:observedStatus,display:journalDisplay}};
/** @param {RunStatusFile} snapshot */
export const statusReadContract = snapshot => readContracts[snapshot.version];
/** @param {RunStatusFile} snapshot @returns {RunStatusFile} */
export function currentStatus(snapshot) { return statusReadContract(snapshot).display(snapshot); }

/** One projection of journal lifecycle and observed controller availability.
 * @param {RunStatusFile} snapshot @returns {RunStatusFile}
 */
function availableStatus(snapshot) {
  const journalStatus = snapshot.journalStatus ?? /** @type {import('./runtime.js').RunStatus} */ (snapshot.status);
  const state = snapshot.host.activation?.state ?? 'unknown';
  // A pending activation may already be restoring bytes before its first invocation.
  const executing = journalStatus === 'running' || journalStatus === 'pending' && !!snapshot.host.activation?.owner;
  const status = snapshot.interruption || executing && state === 'inactive' ? 'interrupted'
    : executing && state === 'unknown' ? 'unknown' : journalStatus;
  const interruption = status === 'interrupted' ? snapshot.interruption ?? {detail:'interrupted',resume:`flowcrew resume ${snapshot.run}`} : undefined;
  return {...snapshot,journalStatus,status,currentStage:status === 'running' ? snapshot.currentStage : null,
    ...(interruption ? {interruption} : {}),
    ...(status === 'running' && !snapshot.attention?.obligations?.length ? {attention:null} : {}),
    ...(status === 'running' ? {} : {step:{label:null,stageLabel:null,attempt:null,startedAt:null,elapsedMs:null}}),
    ...(['interrupted','unknown'].includes(status) ? {
      usage:{...snapshot.usage,activeDurationMs:null},
      attention:snapshot.attention?.obligations?.length || status === 'unknown' && snapshot.attention?.reason === 'recovery_unknown' ? snapshot.attention : {reason:'recovery_unknown',
        detail:`${interruption?.detail ?? 'controller observation unknown'}; flowcrew resume ${snapshot.run}`,condition:null}}
      : {})};
}
/** @param {RunStatusFile} snapshot @returns {RunStatusFile} */
function journalDisplay(snapshot) {
  const current = availableStatus(snapshot);
  return {...current,...(snapshot.stages ? {stages:snapshot.stages.map(stage => {
    const {commandProgress,...facts} = stage, state = displayedStageState(stage,{...snapshot,status:current.status});
    return {...facts,state,...(commandProgress && (state === 'running' || commandProgress.some(command => command.source || command.reused || command.basis)) ? {commandProgress} : {})};
  })} : {})};
}
/** Reader interpretation of the recorded boot; no state change or automatic resume.
 * @param {RunStatusFile} status @param {string | undefined} boot @returns {RunStatusFile}
 */
export function withCurrentBoot(status, boot) {
  const { interruption: _previous, ...snapshot } = status;
  const journalStatus = status.journalStatus ?? status.status;
  return currentStatus(boot && status.host.boot && boot !== status.host.boot
    && nextLifecycle(/** @type {import('./runtime.js').RunStatus} */ (journalStatus), 'resume') !== null && !status.reclaimed ? {...snapshot,
      step:{...snapshot.step,elapsedMs:null},usage:{...snapshot.usage,activeDurationMs:null},
      attention:{reason:'recovery_unknown',detail:`interrupted by restart; flowcrew resume ${status.run}`,condition:null},
      interruption:{detail:'interrupted by restart',resume:`flowcrew resume ${status.run}`}} : snapshot);
}
/** @param {RunStatusFile} status */
export function statusLabel(status) { return status.interruption?.detail ?? status.status; }

/** Quiet is an advisory notice, independent of lifecycle attention and stop reasons.
 * @param {RunStatusFile} status
 */
export const activityNotices = status => status.status === 'running'
  ? status.activity?.length ? status.activity.filter(item=>item.state === 'current' && item.observation === 'quiet' && item.notice)
    : (status.commandActivity ?? []).filter(item=>item.state === 'quiet' && item.notice) : [];
