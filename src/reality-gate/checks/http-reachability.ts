import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, result, stringValuesAtPath } from './_utils.js';

interface Params {
  url?: string | { from_field?: string; json_file?: string };
  status?: number;
}

export default class HttpReachabilityCheck implements RealityCheck {
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    const expected = params.status;
    if (typeof expected !== 'number') return result(false, 'status must be a number');
    const urls = this.urls(params, context);
    if (urls.length === 0) return result(false, 'no URLs resolved');
    const evidence: Array<{ url: string; status?: number; error?: string }> = [];
    for (const url of urls) {
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        evidence.push({ url, status: response.status });
      } catch (err) {
        evidence.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const failures = evidence.filter((item) => item.status !== expected);
    return result(failures.length === 0, failures.length === 0 ? `${urls.length} URL(s) returned ${expected}` : `${failures.length}/${urls.length} URL(s) did not return ${expected}`, { urls: evidence });
  }

  private urls(params: Params, context: CheckContext): string[] {
    if (typeof params.url === 'string') return [params.url];
    if (params.url && typeof params.url.from_field === 'string' && typeof params.url.json_file === 'string') {
      return stringValuesAtPath(readJsonFile(params.url.json_file, context), params.url.from_field);
    }
    return [];
  }
}
