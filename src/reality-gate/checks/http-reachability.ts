import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, result, stringValuesAtPath } from './_utils.js';

interface Params {
  url?: string | { from_field?: string; json_file?: string };
  status?: number;
}

export default class HttpReachabilityCheck implements RealityCheck {
  static meta = { description: 'GET a URL and require an expected HTTP status.', params: 'url: string | { from_field, json_file }, status: number' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    const expected = params.status;
    if (typeof expected !== 'number') return result(false, '`params.status` must be a number; set the expected HTTP status and rerun the check.');
    const urls = this.urls(params, context);
    if (urls.length === 0) return result(false, 'No URLs resolved; provide `params.url` or fix its JSON source field, then rerun the check.');
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
    const failureSummary = failures.slice(0, 8).map((item) =>
      `${displayUrl(item.url)} ${item.error ? `failed (${item.error})` : `returned ${item.status ?? 'no status'} (expected ${expected})`}`).join(', ');
    const omitted = failures.length - Math.min(failures.length, 8);
    return result(
      failures.length === 0,
      failures.length === 0
        ? `${urls.length} URL(s) returned ${expected}`
        : `${failures.length}/${urls.length} URL(s) failed: ${failureSummary}${omitted > 0 ? ` (+${omitted} more)` : ''}. Check the endpoint, network, and expected status, then rerun the check.`,
      { urls: evidence },
    );
  }

  private urls(params: Params, context: CheckContext): string[] {
    if (typeof params.url === 'string') return [params.url];
    if (params.url && typeof params.url.from_field === 'string' && typeof params.url.json_file === 'string') {
      return stringValuesAtPath(readJsonFile(params.url.json_file, context), params.url.from_field);
    }
    return [];
  }
}

function displayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, '[redacted]');
    return parsed.toString().slice(0, 240);
  } catch {
    return value.slice(0, 240);
  }
}
