import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { FrozenReplayCorpus, parseReplayArguments, requireFreshTemporaryDirectory, sha256 } from '../scripts/engine-principles-inputs.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-tooling-spec-'));
  roots.push(root); return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function corpus(root: string, overrides: object = {}): FrozenReplayCorpus {
  const bytes = 'declared document';
  writeFileSync(join(root, 'snapshot'), bytes);
  writeFileSync(join(root, 'corpus.json'), JSON.stringify({ files: [{ path: 'native-key', run_id: 'fixture-run',
    relative_path: 'dispatch.yaml', readable: true, captured_size: Buffer.byteLength(bytes),
    sha256: sha256(bytes), snapshot: join(root, 'snapshot'), ...overrides }] }));
  return new FrozenReplayCorpus(root);
}

describe('offline replay input integrity', () => {
  it('rejects duplicate, unknown and valueless arguments instead of selecting an arbitrary value', () => {
    expect(parseReplayArguments(['--out', 'evidence'], ['--out'])).toEqual({ '--out': 'evidence' });
    expect(() => parseReplayArguments(['--out', 'a', '--out', 'b'], ['--out'])).toThrow('duplicate argument');
    expect(() => parseReplayArguments(['--other', 'a'], ['--out'])).toThrow('unexpected argument');
    expect(() => parseReplayArguments(['--out', '--other'], ['--out'])).toThrow('missing value');
    expect(() => parseReplayArguments([], ['--out'])).toThrow('missing --out');
  });
  it('accepts a fresh temporary child and refuses an existing scratch directory', () => {
    const root = fixture();
    expect(() => requireFreshTemporaryDirectory(join(root, 'fresh'))).not.toThrow();
    expect(() => requireFreshTemporaryDirectory(root)).toThrow('fresh owned os.tmpdir child');
  });
  it('reads the exact selected prefix and detects mutation, short bytes and unselected keys', () => {
    const root = fixture(), selected = corpus(root);
    writeFileSync(join(root, 'snapshot'), 'declared document\nnew mutable tail');
    expect(selected.read('native-key')).toBe('declared document');
    writeFileSync(join(root, 'snapshot'), 'corrupt document!');
    expect(() => selected.read('native-key')).toThrow('Frozen-prefix mismatch');
    writeFileSync(join(root, 'snapshot'), 'short');
    expect(() => selected.read('native-key')).toThrow('Frozen-prefix mismatch');
    expect(() => selected.read('other-key')).toThrow('Unselected/unreadable');
  });
  it('checks snapshot_document_key against both carrier and native stdout hashes', () => {
    const selected = corpus(fixture());
    const row = { source_path: 'absent-native-log', line: 1, stdout_sha256: sha256('declared document'),
      snapshot_document_key: 'native-key' };
    expect(selected.nativeDocument(row)).toBe('declared document');
    expect(() => selected.nativeDocument({ ...row, stdout_sha256: sha256('another document') })).toThrow('Native stdout binding mismatch');
    expect(() => selected.nativeDocument({ ...row, snapshot_document_key: 'unselected' })).toThrow('Unselected/unreadable');
  });
  it('checks a native log line when no extracted document key was selected', () => {
    const root = fixture(), text = 'stage declaration';
    const bytes = JSON.stringify({ item: { aggregated_output: text } });
    const selected = corpus(root, { captured_size: Buffer.byteLength(bytes), sha256: sha256(bytes) });
    writeFileSync(join(root, 'snapshot'), bytes);
    expect(selected.nativeDocument({ source_path: 'native-key', line: 1, stdout_sha256: sha256(text) })).toBe(text);
    expect(() => selected.nativeDocument({ source_path: 'native-key', line: 0, stdout_sha256: sha256(text) })).toThrow('Invalid native source line');
  });
  it('refuses malformed and duplicate carrier declarations before processing decisions', () => {
    const root = fixture();
    expect(() => corpus(root, { captured_size: -1 })).toThrow('Invalid readable carrier');
    corpus(root);
    const manifest = JSON.parse(readFileSync(join(root, 'corpus.json'), 'utf8'));
    manifest.files.push(manifest.files[0]);
    writeFileSync(join(root, 'corpus.json'), JSON.stringify(manifest));
    expect(() => new FrozenReplayCorpus(root)).toThrow('Duplicate frozen carrier');
  });
  it('keeps explicit null attribution readable for non-run carriers without inventing a run ID', () => {
    const selected = corpus(fixture(), { run_id: null, relative_path: 'setup.json' });
    expect(selected.files[0].run_id).toBeNull();
    expect(selected.read('native-key')).toBe('declared document');
  });
});

describe('transactional build owner boundary', () => {
  it.each(['EIO', 'EPERM'])('preserves an existing owner lock when signal-zero reports %s', code => {
    const root = fixture(), project = join(root, 'project'), repository = resolve(import.meta.dirname, '..');
    mkdirSync(join(project, 'scripts'), { recursive: true }); mkdirSync(join(project, '.cache'));
    cpSync(join(repository, 'src'), join(project, 'src'), { recursive: true });
    copyFileSync(join(repository, 'scripts/build.ts'), join(project, 'scripts/build.ts'));
    copyFileSync(join(repository, 'package.json'), join(project, 'package.json'));
    symlinkSync(join(repository, 'node_modules'), join(project, 'node_modules'), 'dir');
    const lock = join(project, '.cache/build.lock'), lockBytes = JSON.stringify({ pid: 424242 });
    writeFileSync(lock, lockBytes);
    const injection = join(project, 'probe-error.mjs');
    writeFileSync(injection, `process.kill=()=>{const error=new Error('controlled probe');error.code=${JSON.stringify(code)};throw error};`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', injection, 'scripts/build.ts'], {
      cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'store'), FLOWCREW_DAEMON_SOCKET: join(root, 'unavailable.sock') },
      encoding: 'utf8', timeout: 10000,
    });
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain('Another build is publishing this checkout');
    expect(readFileSync(lock, 'utf8')).toBe(lockBytes);
    expect(existsSync(join(project, 'dist'))).toBe(false);
  });
});
