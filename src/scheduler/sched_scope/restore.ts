// Boundary: Replace one project leaf from proven preimage bytes/Git identity and verify restoration; never recursively erase an unexpected directory or infer absence.
import { basename, dirname, join, relative } from "node:path";
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from '../../engine-fs.js';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from "node:crypto";
import { artifactRootContains } from '../../artifact-location.js';
import { prospectivePhysicalPath } from '../../engine-owned-carriers.js';
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { spawnSync } from "node:child_process";
import { type RepairFileImage, compareRepairFileContents, describeRepairError, gitObjectIdForPath, readRepairFileImage, repairFileMaterializedBytes } from './file-images.js';

interface ProjectPathRestoreResult {
  restored: boolean;
  failure?: string;
  retainedPath?: string;
}

let rollbackReplacementSequence = 0;

export function restoreProjectPath(
  projectDir: string,
  rawPath: string,
  before: RepairFileImage,
  retentionRoot?: string,
): ProjectPathRestoreResult {
  const normalized = normalizedProjectPath(rawPath);
  if (!normalized) return { restored: false, failure: `cannot restore non-project path ${rawPath}` };
  if (before.inspectionFailure) {
    return { restored: false, failure: `preimage state is unavailable for ${normalized}: ${before.inspectionFailure}` };
  }
  let temporary: string | undefined;
  let retainedPath: string | undefined;
  try {
    // Resolve the parent, not the leaf: rollback may replace an outward leaf
    // symlink, but must never restore through an outward directory alias.
    const root = realpathSync(projectDir);
    const parent = prospectivePhysicalPath(join(root, dirname(normalized)));
    if (!artifactRootContains(root, parent)) {
      return { restored: false, failure: `refused to restore through an ancestor outside the project at ${normalized}` };
    }
    if (before.restorationParent && before.restorationParent !== parent) {
      return { restored: false, failure: `admitted parent identity changed at ${normalized}` };
    }
    const absolute = join(parent, basename(normalized));
    let currentIsDirectory = false;
    try { currentIsDirectory = lstatSync(absolute).isDirectory(); } catch { /* absent */ }
    const retainReplacement = (): void => {
      const owner = retentionRoot ?? tmpdir();
      mkdirSync(owner, { recursive: true });
      const retained = join(mkdtempSync(join(owner, 'replacement-')), 'contents');
      // Rename without traversing or deleting unknown contents. The run keeps
      // this displaced entry independently of temporary preimage cleanup.
      renameSync(absolute, retained);
      retainedPath = retained;
    };
    if (before.type === 'directory') {
      // The frozen tree's topology was observed. Replace only a leaf alias;
      // never traverse its replacement target or recursively erase a tree.
      if (!currentIsDirectory) {
        try { lstatSync(absolute); retainReplacement(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      mkdirSync(absolute, { recursive: true, mode: before.mode });
      return { restored: compareRepairFileContents(before, readRepairFileImage(root, normalized)) === 'equal',
        ...(retainedPath ? { retainedPath } : {}) };
    }
    if (!before.exists) {
      if (before.provenance !== 'observed') {
        return {
          restored: false,
          failure: `preimage absence was not observed for ${normalized}; refusing destructive rollback`,
        };
      }
      if (currentIsDirectory) retainReplacement();
      else rmSync(absolute, { force: true });
      const after = readRepairFileImage(root, normalized);
      return !after.exists && !after.inspectionFailure
        ? { restored: true, ...(retainedPath ? { retainedPath } : {}) }
        : { restored: false, failure: `new path ${normalized} remained after removal` };
    }
    const bytes = repairFileMaterializedBytes(before);
    const gitBlob = before.type === 'file' && before.gitObjectId && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(before.gitObjectId)
      ? before.gitObjectId : undefined;
    if (bytes === undefined && before.backingPath === undefined && !gitBlob) {
      return {
        restored: false,
        failure: before.materializationFailure
          ?? `preimage content is unavailable for ${normalized}`,
      };
    }
    mkdirSync(dirname(absolute), { recursive: true });
    rollbackReplacementSequence++;
    const token = createHash('sha256')
      .update(`${process.pid}\0${Date.now()}\0${rollbackReplacementSequence}\0${normalized}`)
      .digest('hex')
      .slice(0, 16);
    temporary = join(dirname(absolute), `.${basename(absolute)}.flowcrew-restore-${token}`);
    if (before.symlink) {
      if (!bytes) throw new Error(`symbolic-link preimage bytes are unavailable for ${normalized}`);
      symlinkSync(bytes, temporary);
    } else if (before.backingPath) {
      copyFileSync(before.backingPath, temporary);
      if (before.mode !== undefined) chmodSync(temporary, before.mode);
    } else if (gitBlob) {
      const descriptor = openSync(temporary, 'wx', before.mode ?? 0o600);
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync('git', ['cat-file', 'blob', gitBlob], {
          cwd: projectDir, stdio: ['ignore', descriptor, 'pipe'], timeout: 15_000,
          maxBuffer: 1_048_576,
        });
      } finally { closeSync(descriptor); }
      if (result.status !== 0 || result.error) throw new Error(`Git preimage ${gitBlob} could not be read`);
      if (before.mode !== undefined) chmodSync(temporary, before.mode);
    } else {
      if (!bytes) throw new Error(`regular-file preimage bytes are unavailable for ${normalized}`);
      writeFileSync(temporary, bytes, { flag: 'wx', mode: before.mode ?? 0o600 });
      if (before.mode !== undefined) chmodSync(temporary, before.mode);
    }
    const stagedMatches = gitBlob
      ? gitObjectIdForPath(projectDir, temporary) === gitBlob
      : compareRepairFileContents(before, readRepairFileImage(root, relative(root, temporary))) === 'equal';
    if (!stagedMatches) {
      return { restored: false, failure: `staged preimage verification failed for ${normalized}` };
    }
    if (currentIsDirectory) retainReplacement();
    renameSync(temporary, absolute);
    temporary = undefined;
    return (gitBlob
      ? gitObjectIdForPath(projectDir, absolute) === gitBlob
      : compareRepairFileContents(before, readRepairFileImage(root, normalized)) === 'equal')
      ? { restored: true, ...(retainedPath ? { retainedPath } : {}) }
      : { restored: false, failure: `restored content verification failed for ${normalized}` };
  } catch (error) {
    return { restored: false, failure: `could not restore ${normalized}: ${describeRepairError(error)}`,
      ...(retainedPath ? { retainedPath } : {}) };
  } finally {
    if (temporary) {
      try { rmSync(temporary, { force: true }); } catch { /* target was never removed; cleanup is best effort */ }
    }
  }
}
