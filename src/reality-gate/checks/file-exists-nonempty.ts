import { existsSync, statSync } from 'node:fs';
import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, resolvePath, result, stringValuesAtPath } from './_utils.js';

interface Params {
  paths?: string[] | { from_manifest?: string; field?: string };
}

export default class FileExistsNonemptyCheck implements RealityCheck {
  static meta = { description: 'Assert that listed files exist and are non-empty.', params: 'paths: string[] | { from_manifest: string, field: string }' };
  async run(raw: object, context: CheckContext) {
    const paths = this.paths(raw as Params, context);
    if (paths.length === 0) return result(false, 'No paths resolved; provide `params.paths` or fix the declared manifest field, then rerun the check.');
    const evidence = paths.map((path) => {
      const resolved = resolvePath(path, context);
      if (!existsSync(resolved)) return { path, resolved, exists: false, size: 0 };
      const size = statSync(resolved).size;
      return { path, resolved, exists: true, size };
    });
    const failures = evidence.filter((item) => !item.exists || item.size <= 0);
    const failureSummary = failures.slice(0, 10).map((item) =>
      `${JSON.stringify(item.path.slice(0, 180))} (${item.exists ? `empty, size=${item.size}` : 'missing'})`).join(', ');
    const omitted = failures.length - Math.min(failures.length, 10);
    return result(
      failures.length === 0,
      failures.length === 0
        ? `${paths.length} file(s) exist and are nonempty`
        : `${failures.length}/${paths.length} file(s) missing or empty: ${failureSummary}${omitted > 0 ? ` (+${omitted} more)` : ''}. Create each missing file or write non-empty content; remove a path from the declaration only if the contract does not require it.`,
      { files: evidence },
    );
  }

  private paths(params: Params, context: CheckContext): string[] {
    if (Array.isArray(params.paths)) return params.paths.filter((value): value is string => typeof value === 'string');
    if (params.paths && typeof params.paths.from_manifest === 'string' && typeof params.paths.field === 'string') {
      return stringValuesAtPath(readJsonFile(params.paths.from_manifest, context), params.paths.field);
    }
    return [];
  }
}
