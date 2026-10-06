/** Offline tool inputs: exact arguments and authenticated frozen carrier bytes.
 * These readers never interpret a recorded command or mutate a run store.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export function parseReplayArguments(
  argv: string[], required: string[], optional: string[] = [],
): Record<string, string> {
  const allowed = new Set([...required, ...optional]);
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowed.has(flag)) throw new Error(`unexpected argument: ${flag}`);
    if (Object.hasOwn(values, flag)) throw new Error(`duplicate argument: ${flag}`);
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values[flag] = value;
  }
  for (const flag of required) if (!values[flag]) throw new Error(`missing ${flag}`);
  return values;
}

export function requireFreshTemporaryDirectory(path: string): void {
  const temporaryRoot = realpathSync(tmpdir());
  const target = resolve(path);
  const parent = realpathSync(dirname(target));
  const location = relative(temporaryRoot, join(parent, target.slice(dirname(target).length + 1)));
  if (!location || location === '..' || location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(location) || existsSync(target)) {
    throw new Error('Replay requires a fresh owned os.tmpdir child');
  }
}

export interface FrozenCarrier {
  path: string;
  run_id: string | null;
  relative_path: string;
  readable: boolean;
  captured_size?: number;
  sha256?: string;
  snapshot?: string | null;
  original_path?: string;
  [key: string]: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export class FrozenReplayCorpus {
  readonly files: FrozenCarrier[];
  readonly sources: Record<string, { bytes: number; sha256: string }> = {};
  private readonly byPath = new Map<string, FrozenCarrier>();

  constructor(private readonly directory: string) {
    const manifest = object(this.json('corpus.json'), 'corpus manifest');
    if (!Array.isArray(manifest.files)) throw new Error('Invalid corpus manifest: expected files array');
    this.files = manifest.files.map((entry, index) => {
      const row = object(entry, `carrier ${index}`);
      if (typeof row.path !== 'string' || !row.path || row.run_id !== null && typeof row.run_id !== 'string'
          || typeof row.relative_path !== 'string' || typeof row.readable !== 'boolean') {
        throw new Error(`Invalid carrier ${index}: declare path, run_id, relative_path and readable`);
      }
      if (this.byPath.has(row.path)) throw new Error(`Duplicate frozen carrier ${row.path}`);
      if (row.readable && (!Number.isSafeInteger(row.captured_size) || Number(row.captured_size) < 0
          || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
          || row.snapshot != null && (typeof row.snapshot !== 'string' || !row.snapshot)
          || row.original_path !== undefined && typeof row.original_path !== 'string')) {
        throw new Error(`Invalid readable carrier ${row.path}: declare captured_size and sha256`);
      }
      const carrier = row as unknown as FrozenCarrier;
      this.byPath.set(carrier.path, carrier);
      return carrier;
    });
  }

  json(name: string): any {
    if (isAbsolute(name) || name.includes('/') || name.includes('\\') || name === '..') {
      throw new Error(`Invalid corpus document name ${name}`);
    }
    const bytes = readFileSync(join(this.directory, name));
    this.sources[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    return JSON.parse(bytes.toString('utf8'));
  }

  read(key: string): string {
    const row = this.byPath.get(key);
    if (!row?.readable) throw new Error(`Unselected/unreadable carrier ${key}`);
    const bytes = readFileSync(row.snapshot ?? row.original_path ?? row.path).subarray(0, row.captured_size);
    if (bytes.length !== row.captured_size || sha256(bytes) !== row.sha256) {
      throw new Error(`Frozen-prefix mismatch ${key}`);
    }
    return bytes.toString('utf8');
  }

  nativeDocument(row: {
    source_path: string; line: number; stdout_sha256: string; snapshot_document_key?: string;
  }): string {
    let text: unknown;
    if (row.snapshot_document_key !== undefined) {
      if (!row.snapshot_document_key) throw new Error('Invalid native snapshot_document_key');
      text = this.read(row.snapshot_document_key);
    } else {
      if (!Number.isSafeInteger(row.line) || row.line < 1) throw new Error('Invalid native source line');
      const event = JSON.parse(this.read(row.source_path).split(/\r?\n/)[row.line - 1]);
      text = event.item?.aggregated_output;
    }
    if (typeof text !== 'string' || sha256(text) !== row.stdout_sha256) {
      throw new Error('Native stdout binding mismatch');
    }
    return text;
  }
}
