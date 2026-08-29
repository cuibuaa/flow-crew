import { watch } from 'node:fs';

/**
 * Observe an atomic filesystem publication without making elapsed time part of
 * the verdict. The checks on both sides of watch installation close the usual
 * check/subscription race; later checks are driven by filesystem events.
 */
export async function waitForPathEvent<T>(
  directory: string,
  observe: () => T | undefined,
): Promise<T> {
  const initial = observe();
  if (initial !== undefined) return initial;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const watcher = watch(directory, check);
    watcher.unref();
    watcher.once('error', (error) => {
      if (settled) return;
      settled = true;
      watcher.close();
      reject(error);
    });

    function check(): void {
      if (settled) return;
      let value: T | undefined;
      try {
        value = observe();
      } catch (error) {
        settled = true;
        watcher.close();
        reject(error);
        return;
      }
      if (value === undefined) return;
      settled = true;
      watcher.close();
      resolve(value);
    }

    check();
  });
}
