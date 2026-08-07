import { execFileSync } from 'node:child_process';
import { findExecutableOnPath } from './adapters/availability.js';
import { fcGlobalDir } from './store.js';
import {
  REGISTRY_COMPACTION_THRESHOLDS,
  TaskRegistry,
  type RegistryMaintenanceReport,
} from './task-registry.js';

interface WritableLike {
  write(chunk: string): unknown;
}

export interface SupervisorBackendReport {
  kind: 'systemd-user' | 'portable-shim';
  message: string;
}

export interface SupervisorBackendProbeOptions {
  findCommand?: (command: string) => string | undefined;
  runCommand?: (command: string, args: string[]) => void;
}

/**
 * The wrapper requires both `systemctl` and the `systemd-run` launcher, while
 * their mere presence does not prove that this process has a usable user
 * manager. Otherwise the portable shim remains the backend.
 */
export function detectSupervisorBackend(
  options: SupervisorBackendProbeOptions = {},
): SupervisorBackendReport {
  const findCommand = options.findCommand ?? findExecutableOnPath;
  const runCommand = options.runCommand ?? ((command, args) => {
    execFileSync(command, args, { stdio: 'ignore', timeout: 2_000 });
  });
  const systemctl = findCommand('systemctl');
  const systemdRun = findCommand('systemd-run');
  if (systemctl && systemdRun) {
    try {
      runCommand(systemctl, ['--user', 'show-environment']);
      return {
        kind: 'systemd-user',
        message: 'portable Node shim with an available systemd user-session cgroup wrapper',
      };
    } catch { /* no usable user manager; portable supervision remains available */ }
  }
  return {
    kind: 'portable-shim',
    message: 'portable Node shim (systemd user session unavailable; no systemd dependency)',
  };
}

export interface DoctorMaintenanceOptions {
  registry?: TaskRegistry;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

const MAINTENANCE_FLAGS = new Set(['--repair-registry', '--compact-registry', '--apply']);

/**
 * Registry maintenance is intentionally separate from the general doctor
 * probes: it is deterministic, injectable for tests, and never mutates unless
 * the operator supplies `--apply`.
 */
export function cmdDoctorMaintenance(
  argv: string[],
  options: DoctorMaintenanceOptions = {},
): number {
  const args = argv[0] === 'doctor' ? argv.slice(1) : argv;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const unknown = args.filter((arg) => !MAINTENANCE_FLAGS.has(arg));
  const repair = args.includes('--repair-registry');
  const compact = args.includes('--compact-registry');
  const apply = args.includes('--apply');

  if (unknown.length > 0 || repair === compact) {
    if (unknown.length > 0) stderr.write(`Unknown doctor option(s): ${unknown.join(', ')}\n`);
    else if (repair && compact) stderr.write('Choose one registry maintenance operation at a time.\n');
    stderr.write('Usage: flowcrew doctor --repair-registry|--compact-registry [--apply]\n');
    return 2;
  }

  const registry = options.registry ?? new TaskRegistry({ baseDir: fcGlobalDir() });
  let report: RegistryMaintenanceReport;
  try {
    report = repair ? registry.repair({ apply }) : registry.compact({ apply });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  printReport(report, stdout);
  return 0;
}

function printReport(report: RegistryMaintenanceReport, stdout: WritableLike): void {
  const mode = report.applied ? 'APPLIED' : 'DRY-RUN';
  stdout.write(`\nFlowCrew registry ${report.operation} — ${mode}\n`);
  stdout.write(`Registry: ${report.registryPath}\n`);
  stdout.write(
    `Before: ${report.before.bytes} bytes / ${report.before.records} records / `
    + `${report.before.tasks} tasks / ${report.before.unreadableRecords} unreadable\n`,
  );
  stdout.write(
    `Compaction trigger: ${REGISTRY_COMPACTION_THRESHOLDS.bytes} bytes (64 MiB) or `
    + `${REGISTRY_COMPACTION_THRESHOLDS.records} records; recommended=${report.before.compactRecommended ? 'yes' : 'no'}\n`,
  );

  for (const action of report.actions) {
    stdout.write(`  line ${action.line}: ${action.kind} — ${action.detail}\n`);
  }

  if (!report.changed) {
    stdout.write('No registry rewrite is needed; no backup or quarantine file was created.\n');
  } else {
    stdout.write(`${report.applied ? 'Evidence backup' : 'Would create evidence backup'}: ${report.backupPath}\n`);
    if (report.quarantinePath) {
      stdout.write(`${report.applied ? 'Quarantine' : 'Would create quarantine'}: ${report.quarantinePath}\n`);
    }
    if (!report.applied) {
      stdout.write(`No files changed. Re-run with --apply to perform this ${report.operation}.\n`);
    }
  }

  stdout.write(
    `Summary: repaired=${report.repairedRecords} quarantined=${report.quarantinedRecords} `
    + `removed=${report.removedRecords}; after=${report.after.records} records/${report.after.tasks} tasks/`
    + `${report.after.unreadableRecords} unreadable\n`,
  );
}
