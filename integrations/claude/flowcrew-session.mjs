import {observeStatus} from '../../rewrite-src/host/identity.mjs';
// Standalone Claude Code hook. The explicit configuration file argument declares
// { storeRoots: [absolute paths], tasksRoot: absolute path to Claude's tasks }.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** @typedef {import('../../rewrite-src/contract/runtime.js').RunStatusFile} RunStatusFile */
/** @typedef {{storeRoots: string[], tasksRoot: string}} Config */
/** @typedef {{storeRoot: string, run: string, id: string, created: boolean, closed: boolean, reported?: string}} Slot */
/** @typedef {{key: string, run: string, status?: RunStatusFile, closed: boolean}} Observation */

import { parseRunStatusFile, parsePublicRunStatus, statusLabel, activityNotices as notices } from '../../rewrite-src/contract/status.mjs';
/** @param {unknown} value */
export const valid = value => parsePublicRunStatus(value).ok;
const terminal = new Set(['complete', 'accepted_blocked', 'incomplete', 'failed', 'cancelled']);
const actionable = new Set([...terminal, 'parked', 'escalated']);
/** @param {any} value */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {any} value @param {string[]} required @param {string[]} optional */
const fields = (value, required, optional = []) => object(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
/** @param {any} value @param {RegExp} pattern */
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
/** @param {any} value */
const id = value => matches(value, /^[A-Za-z][A-Za-z0-9_-]*$/);
/** @param {any} value */
const requester = value => matches(value, /^[A-Za-z0-9._:-]{1,200}$/);
/** @param {any} value */
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** @param {import('node:fs').PathOrFileDescriptor | URL} path @returns {any} */
function read(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') return undefined; throw error; }
}

// Publish complete, durable bytes. Task publications retain their inode BEFORE
// rename, so recovery and concurrent writers need no post-publication confirmation.
/** @param {string} path @param {string} root @param {string} taskId */
function publication(path, root, taskId) {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return join(root, 'created', `${taskId}-${dev}-${ino}`);
  } catch (error) {
    if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** @param {string} path @param {any} value @param {boolean} exclusive @param {string} [owner] */
function publish(path, value, exclusive = false, owner) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const previous = owner && publication(path, owner, value.id);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (owner) {
      durableDirectory(join(owner, 'created'));
      install(temporary, /** @type {string} */ (publication(temporary, owner, value.id)));
    }
    if (exclusive) linkSync(temporary, path); else renameSync(temporary, path);
    const parent = openSync(dirname(path), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    // The new proof and task name are durable before retiring the old proof.
    // A crash before retirement retains both; after it, the new inode is proven.
    if (previous) {
      try { unlinkSync(previous); }
      catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code !== 'ENOENT') throw error; }
      const proofs = openSync(dirname(previous), 'r');
      try { fsyncSync(proofs); } finally { closeSync(proofs); }
    }
  } catch (error) {
    if (exclusive && (/** @type {NodeJS.ErrnoException} */ (error)).code === 'EEXIST') return false;
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* A leftover temporary file carries no task/state authority. */ }
  }
  return true;
}

/** @param {string} directory */
function entries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') return []; throw error; }
}

/** @param {RunStatusFile} status */
const activityDetails = status => notices(status).map(item => `${'source' in item ? `${item.source} ${item.lastTool ?? 'execution'}` : `command ${item.command}`}; stage ${item.stage ?? 'none'}: ${item.notice?.message}`).join('; ');
/** @param {RunStatusFile} status */
const details = status => `${statusLabel(status)}${status.stopReason === null ? '' : ` (${status.stopReason})`}; stage ${status.focus === null ? 'none' : status.focus === status.currentStage ? status.step.stageLabel ?? status.focus : status.focus}; `
  + `C2 gate ${status.backstop.gateSuffix}/3, failure ${status.backstop.failureSuffix}/4; usage ${status.usage.state}; `
  + (status.attention ? `attention: ${status.attention.detail}; ` : '')
  + (activityDetails(status) ? `${activityDetails(status)}; ` : '')
  + `now ${status.step.label ?? 'unknown'}; `
  + (status.activity?.filter(item=>item.state === 'current').map(item=>`${item.source} ${item.lastTool ?? 'execution'}: ${item.summary ?? 'progress unknown'}; last progress ${item.lastEventAt ?? 'unknown'}`).join('; ') ?? '')
  + `step elapsed ${status.step.elapsedMs ?? 'unknown'} ms; historical workflow snapshot published ${status.publishedAt}; cursor ${status.journalCursor}; statusSince ${status.statusSince}`;

/** Action identity excludes additive observation metadata and object field order.
 * @param {RunStatusFile} status */
const actionIdentity = status => [
  status.attention && [status.attention.reason, status.attention.detail, status.attention.condition,
    (status.attention.obligations ?? []).map(({kind,detail,owner,members}) => [kind,detail,
      owner && [owner.pid,owner.start,owner.boot,owner.group,owner.authority],
      members.map(({pid,state,parent}) => [pid,state,parent]).sort((a,b) => Number(a[0])-Number(b[0]))])],
  status.interruption && [status.interruption.detail,status.interruption.resume]
];
/** @param {Observation} observation */
const transition = ({ key, status }) => status ? JSON.stringify([key, statusLabel(status), status.statusSince, actionIdentity(status), ...notices(status).map(item => item.notice?.cursor)]) : '';

// A pure step; folding these steps over an observed sequence is the Wake policy.
/** @param {readonly Observation[]} observed @param {Readonly<Record<string, Slot>>} runs */
export function decideWake(observed, runs) {
  const reports = observed.filter(item => item.status && (actionable.has(item.status.status) || item.status.interruption || statusLabel(item.status) === 'unknown' || notices(item.status).length > 0)
    && runs[item.key]?.reported !== transition(item));
  const kind = reports.length ? 'report' : observed.some(item => item.status ? !terminal.has(item.status.status) : !item.closed) ? 'wait' : 'done';
  const next = { ...runs };
  for (const item of reports) next[item.key] = { ...runs[item.key], reported: transition(item) };
  return { kind, reports, runs: next };
}

// Immutable reservations and per-run slots replace the session read/modify/write.
// The closed marker is immutable; it never allocates IDs or claims wakes.
/** @param {string} path */
const priorEntry = path => { try { return read(path); } catch { return null; } };
/** @param {string} left @param {string} right */
function sameFile(left, right) {
  try { const a = statSync(left), b = statSync(right); return a.dev === b.dev && a.ino === b.ino; }
  catch { return false; }
}
/** @param {string} path */
function durableDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** @param {string} source @param {string} target */
function install(source, target) {
  try { linkSync(source, target); }
  catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code !== 'EEXIST') throw error; }
  const fd = openSync(dirname(target), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** @param {Config} config @param {string} session */
async function sync(config, session) {
  const owner = `claude:${session}`, directory = join(config.tasksRoot, session);
  const records = join(directory, '.flowcrew-state'), reservations = join(records, 'ids');
  durableDirectory(reservations);
  /** @type {Map<string, {storeRoot: string, run: string, status?: RunStatusFile, withdrawn?: boolean}>} */
  const sources = new Map();
  for (const file of entries(records)) {
    if (!file.isDirectory() || file.name === 'ids') continue;
    const identity = read(join(records, file.name, 'slot-0'));
    if (!identity) continue; // An unlinked reservation establishes no run ownership.
    if (digest([identity.storeRoot, identity.run]) !== file.name) throw new Error('Invalid FlowCrew run identity');
    sources.set(file.name, identity);
  }
  for (const storeRoot of config.storeRoots) for (const run of entries(join(storeRoot, 'runs'))) {
    if (!run.isDirectory() || !id(run.name)) continue;
    const key = digest([storeRoot, run.name]);
    let status;
    try { status = read(join(storeRoot, 'runs', run.name, 'status.json')); } catch { /* unavailable */ }
    const parsed = parseRunStatusFile(status);
    const supported = parsed.ok && parsed.value.run === run.name;
    if (status?.requester === owner) sources.set(key, { storeRoot, run: run.name, status: supported && parsed.ok ? await observeStatus(parsed.value) : undefined });
    else if (supported && sources.has(key)) sources.set(key, { storeRoot, run: run.name, withdrawn: true });
  }
  /** @type {Observation[]} */
  const observed = [];
  /** @type {Record<string, Slot>} */
  const runs = {};
  for (const [key, source] of sources) {
    const { storeRoot, run, status } = source, root = join(records, key);
    durableDirectory(root);
    const closed = read(join(root, 'closed')) === true;
    const text = status ? details(status) : 'unavailable; status.json missing, invalid or unreadable';
    /** @param {string} taskId */
    const entry = taskId => ({ id: taskId, subject: `FlowCrew ${run}`, description: text, activeForm: `FlowCrew ${run}: ${text}`,
      status: !status ? 'in_progress' : terminal.has(status.status) ? 'completed' : status.status === 'pending' ? 'pending' : 'in_progress',
      blocks: [], blockedBy: [] });
    const generations = entries(root).filter(file => /^slot-[0-9]+$/.test(file.name)).map(file => Number(file.name.slice(5)));
    let generation = generations.length ? Math.max(...generations) : 0;
    for (;;) {
      const slotPath = join(root, `slot-${generation}`);
      /** @type {Slot | undefined} */
      let slot = read(slotPath);
      if (!slot) {
        if (source.withdrawn) break;
        // The exclusive reservation contains the complete initial entry. A crash
        // before the slot is linked wastes an ID, never another process's task.
        let number = 1;
        for (;;) {
          const taskId = `flowcrew-${number++}`;
          if (entries(directory).some(file => file.name === `${taskId}.json`)) continue;
          if (!publish(join(reservations, taskId), entry(taskId), true)) continue;
          publish(slotPath, { storeRoot, run, id: taskId, created: false, closed }, true);
          slot = read(slotPath); break; // Another process may have won this slot.
        }
      }
      if (!slot) throw new Error('Missing FlowCrew slot');
      const path = join(directory, `${slot.id}.json`), reserved = join(reservations, slot.id);
      const withdrawn = join(root, `withdrawn-${slot.id}`);
      if (read(withdrawn)) { if (source.withdrawn || !status) break; generation++; continue; }
      let before = priorEntry(path);
      // One owner for updates and withdrawal: ID plus a retained inode, never
      // editable task text. Retaining the link also prevents inode reuse.
      const owns = () => {
        if (before?.id !== slot.id) return false;
        if (sameFile(path, reserved)) return true;
        const proof = publication(path, root, slot.id);
        return Boolean(proof && sameFile(path, proof)); // A vanished entry has no owner.
      };
      if (source.withdrawn) {
        if (owns()) { try { unlinkSync(path); } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code !== 'ENOENT') throw error; } }
        publish(withdrawn, true, true); break;
      }
      if (before !== undefined && !owns()) { generation++; continue; }
      if (before === undefined) {
        install(reserved, path);
        if (!sameFile(path, reserved)) { generation++; continue; }
        before = priorEntry(path);
      }
      if (!status && closed) {
        if (before?.status !== 'completed') publish(path, { ...before, status: 'completed' }, false, root);
        observed.push({ key, run, closed }); runs[key] = { ...slot, closed }; break;
      }
      const next = { ...before, ...entry(slot.id), blocks: before?.blocks ?? [], blockedBy: before?.blockedBy ?? [] };
      if (JSON.stringify(before) !== JSON.stringify(next)) publish(path, next, false, root);
      const isClosed = closed || Boolean(status && terminal.has(status.status));
      if (isClosed) publish(join(root, 'closed'), true, true);
      observed.push({ key, run, status, closed: isClosed }); runs[key] = { ...slot, created: true, closed: isClosed };
      break;
    }
  }
  return { observed, runs };
}

/** @param {readonly Observation[]} observed */
export function statusLine(observed) {
  const active = observed.filter(({ status, closed }) => status ? !terminal.has(status.status) : !closed);
  return active.length ? `FlowCrew: ${active.map(({ run, status }) => `${run} ${status ? `${statusLabel(status)}${status.focus ? `/${status.focus === status.currentStage ? status.step.stageLabel ?? status.focus : status.focus}` : ''}${status.step.label ? `; now ${status.step.label}` : ''}` : 'unavailable'}`).join(' | ')}\n` : '';
}

// Each transition has its own immutable claim. Filesystem exclusivity decides
// the winner across Stop/statusline/Wake/SessionStart without a session lock.
/** @param {Config} config @param {string} session @param {string} event */
export async function observe(config, session, event) {
  const { observed, runs } = await sync(config, session);
  const claims = join(config.tasksRoot, session, '.flowcrew-wakes');
  durableDirectory(claims);
  for (const item of observed) if (read(join(claims, digest(transition(item))))) runs[item.key].reported = transition(item);
  const decision = decideWake(observed, runs);
  if (event === 'Wake') {
    const reports = [];
    for (const item of decision.reports) {
      if (publish(join(claims, digest(transition(item))), true, true)) reports.push(item);
    }
    decision.reports = reports;
    decision.kind = reports.length ? 'report' : observed.some(item => item.status ? !terminal.has(item.status.status) : !item.closed) ? 'wait' : 'done';
  }
  return { ...decision, observed, line: statusLine(observed) };
}

/** @param {Config} config @param {string} session @param {() => Promise<unknown>} pause */
export async function waitForWake(config, session, pause = () => sleep(1000)) {
  for (;;) {
    const snapshot = await observe(config, session, 'Wake');
    if (snapshot.kind !== 'wait') return {
      code: snapshot.kind === 'report' ? 2 : 0,
      stderr: snapshot.reports.length ? `${snapshot.reports.map(({ run, status }) => `FlowCrew ${run}: ${details(/** @type {RunStatusFile} */ (status))}`).join('\n')}\nHandle these FlowCrew results or requests for attention in this session.\n` : '',
    };
    await pause(); // Cadence only; never an age, duration or deadline verdict.
  }
}

/** @param {any} payload @param {any} config @param {string} event */
export async function runHook(payload, config, event = 'Stop') {
  try {
    const session = payload?.session_id;
    if (!matches(session, /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/) || !requester(`claude:${session}`)) throw new Error('Invalid Claude session_id');
    if (!fields(config, ['storeRoots', 'tasksRoot']) || !Array.isArray(config.storeRoots) || !config.storeRoots.length
      || ![...config.storeRoots, config.tasksRoot].every(path => typeof path === 'string' && isAbsolute(path))
      || new Set(config.storeRoots).size !== config.storeRoots.length) throw new Error('Expected absolute storeRoots and tasksRoot in hook config');
    if (!['Stop', 'SessionStart', 'Wake', '--statusline'].includes(event)) throw new Error('Unknown hook event');
    if (event === 'Wake') return { ...await waitForWake(config, session), stdout: '' };
    const snapshot = await observe(config, session, event);
    return { code: 0, stderr: '', stdout: event === '--statusline' ? snapshot.line : '' };
  } catch (error) {
    return { code: 0, stderr: `FlowCrew hook unavailable: ${(/** @type {Error} */ (error)).message}\n`, stdout: event === '--statusline' ? 'FlowCrew: unavailable\n' : '' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    if (process.argv.length !== 4) throw new Error('Expected hook event and configuration file');
    const result = await runHook(JSON.parse(input), read(process.argv[3]), process.argv[2]);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`FlowCrew hook unavailable: ${(/** @type {Error} */ (error)).message}\n`);
    if (process.argv[2] === '--statusline') process.stdout.write('FlowCrew: unavailable\n');
  }
}
