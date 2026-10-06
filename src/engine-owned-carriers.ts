import { lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Resolve components, including links whose final target does not yet exist.
 * Do not collapse a link's '..' before expanding preceding component links. */
export function prospectivePhysicalPath(path: string): string {
  let cursor = parse(path).root;
  let pending = path.slice(cursor.length).split(sep);
  let links = 0;
  while (pending.length) {
    const component = pending.shift()!;
    if (!component || component === '.') continue;
    if (component === '..') { cursor = dirname(cursor); continue; }
    const next = join(cursor, component);
    let entry;
    try { entry = lstatSync(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entry?.isSymbolicLink()) {
      if (++links > 40) throw new Error(`ARTIFACT_PATH_SYMLINK_LOOP: too many symbolic links resolving ${path}`);
      const link = readlinkSync(next);
      if (isAbsolute(link)) cursor = parse(link).root;
      pending = [...link.slice(isAbsolute(link) ? cursor.length : 0).split(sep), ...pending];
    } else {
      if (entry && pending.length && !entry.isDirectory()) throw new Error(`ARTIFACT_PATH_NOT_DIRECTORY: ${next} is not a directory`);
      cursor = next;
    }
  }
  return cursor;
}

export const RUN_INDEX_FILENAME = 'run-index.sqlite';
export const RESOURCE_LEASE_REGISTRY_FILENAME = 'resource-leases.v1.sqlite';
const registeredSqlitePaths = new Set<string>();

/** Trusted native providers enroll custom databases before publication. This
 * records ownership only; it never opens, initializes or rewrites the database. */
export function registerEngineOwnedSqlitePath(path: string): void {
  registeredSqlitePaths.add(resolve(path));
}

function sqlitePaths(storeRoot: string): string[] {
  const paths = new Set([join(resolve(storeRoot), RUN_INDEX_FILENAME),
    join(resolve(storeRoot), RESOURCE_LEASE_REGISTRY_FILENAME), ...registeredSqlitePaths]);
  // Keep both SQLite's supplied spelling and its physical name. This also
  // reserves a future target reached through a dangling link or missing parent.
  for (const path of paths) paths.add(prospectivePhysicalPath(path));
  return [...paths];
}

/** SQLite owns the main name and its entire companion prefix, including future
 * rollback/super journals. A missing file does not make that name an output. */
export function isEngineOwnedGlobalPath(path: string, storeRoot: string): boolean {
  const target = prospectivePhysicalPath(resolve(path));
  return sqlitePaths(storeRoot).some((file) => target === file || target.startsWith(`${file}-`));
}

export function containsEngineOwnedGlobalPath(path: string, storeRoot: string): boolean {
  return isEngineOwnedGlobalPath(path, storeRoot) || sqlitePaths(storeRoot).some((file) => {
    const rel = relative(resolve(path), file);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  });
}

/** Existing identities plus reserved parent entries. Parents are not recursive
 * grants: trusted publishers may create future companions while children have
 * no write/remove/create authority in that namespace. Unknown scans refuse. */
export function engineOwnedGlobalCarriers(storeRoot: string): string[] {
  const paths = new Set<string>();
  for (const file of sqlitePaths(storeRoot)) {
    let parent = dirname(file);
    while (true) {
      try { lstatSync(parent); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
        parent = dirname(parent);
      }
    }
    try {
      lstatSync(parent);
      paths.add(parent);
      for (const name of readdirSync(dirname(file))) {
        if (name === basename(file) || name.startsWith(`${basename(file)}-`)) paths.add(join(parent, name));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return [...paths];
}

/**
 * The run namespace reserved for engine publications, including future members.
 * Admission and the child write boundary use this same predicate. Stage output
 * and request slots are capabilities; acknowledged history never is.
 */
export function isEngineOwnedRunPath(path: string, stage: { id: string; is_gate?: boolean }): boolean {
  if (!path || /^(?:run-history\.v1\.jsonl|\.run-reservation\.json|\.run-state\.lock)(?:\/|$)/.test(path)) return true;
  if (/^(?:run\.json|events\.jsonl|workflow\.yaml|task_brief\.md|brief_criteria\.json|validation_baseline\.json|validation_delta|dispatch_admission\.json|run_history\.jsonl|plan_history(?:\/|$)|audit_findings(?:\/|$)|signals(?:\/|$)|resource_leases|supervisor_state\.json|supervisor_usage\.json)/.test(path)) return true;
  if (/^(?:stage_evidence|gate_reevaluation|dispatch_rejections|plan_retry|declared_outputs|guidance_history|supervisor_rejections|discarded|approvals|\.rollback-preimages)(?:\/|$)/.test(path)
    || /^(?:iteration_log\.md|run_event_status\.json|attempt_summary_refresh\.json|criterion_discharges\.json|supervisor_guidance\.md|scheduler\.pid|scheduler\.identity\.json|scheduler-heartbeat\.json|scheduler-loop-stall\.json|\.reality-gate\.json|\.reality-gate\.failures\.md|approvals\.jsonl|user_input\.md|blockage_ledger\.json|repeated_blockage\.json|plan_retry_state\.json|rollback_change_journal\.jsonl|gate_contract\.json|supervisor_log\.md|summary\.md|progress\.md|verdict\.json)(?:\/|$)/.test(path)) return true;
  if (/^(?:research_round_input_error\.json|research_round_contract_repair\.json|research_integrity_rejections\.json|research_terminal_ready\.json|research_continue\.json|research_gate_exhausted\.json|goal_met\.json|repair_diff\.json|campaign_revision_request\.jsonl|post_terminate_hook\.log)(?:\/|$)/.test(path)) return true;
  if (/^stages(?:\/|$)/.test(path)) {
    if (!path.startsWith(`stages/${stage.id}/`)) return true;
    if (/^stages\/[^/]+\/(?:status\.json|input\.md|invocations(?:\/|$)|attempt_generation\.json|plan_revision_decision_|scope_revision_decision_|approval_resolution|attempt_deadline_|constraint_audit|write_boundary_|command_activity\.json|session\.json|artifact_contract\.json|guidance_consumed\.md|guidance\.md|live\.log|trace\.jsonl)/.test(path)) return true;
  }
  return /^verdict_/.test(path) && !(stage.is_gate && path === `verdict_${stage.id}.json`);
}

/** A directory grant also owns every possible child, not just today's entries. */
export function containsEngineOwnedRunPath(path: string, stage: { id: string; is_gate?: boolean }): boolean {
  return isEngineOwnedRunPath(path, stage) || path === `stages/${stage.id}`;
}
