/** Signal-zero liveness used by build ownership and run identity. Only ESRCH proves death. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // signal 0 has exactly one portable death proof: ESRCH. EPERM means the
    // process exists but this user cannot signal it; unfamiliar probe failures
    // must remain fail-closed rather than being upgraded into death evidence.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
