import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readResourceLeaseRegistry } from '../src/resource-leases.js';
import { recordedResourceRegistry, appendRecordedResourceLease } from './test-support/recorded-resource-registry.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file() { const root = mkdtempSync(join(tmpdir(), 'fc-recorded-resources-')); roots.push(root); return join(root, 'recorded.sqlite'); }

describe('retired resource scheduling and recorded registry reads', () => {
  it('keeps an absent registry query read-only', () => {
    const path = file();
    expect(readResourceLeaseRegistry(path).status).toBe('absent');
    expect(existsSync(path)).toBe(false);
  });
  it('renders archived active reservations without reconciling or rewriting them', () => {
    const path = file(); recordedResourceRegistry(path); appendRecordedResourceLease(path, 'recorded-run');
    const before = readFileSync(path), view = readResourceLeaseRegistry(path);
    expect(view.status).toBe('available');
    if (view.status === 'available') expect(view.snapshot.leases[0].owner.runId).toBe('recorded-run');
    expect(readFileSync(path)).toEqual(before);
  });
  it('refuses a malformed recorded schema while preserving the original bytes', () => {
    const path = file(); recordedResourceRegistry(path);
    const db = new DatabaseSync(path);
    try { db.prepare('UPDATE resource_registry SET data = ? WHERE id = 1').run('{"version":1}'); } finally { db.close(); }
    const before = readFileSync(path);
    expect(() => readResourceLeaseRegistry(path)).toThrow('RESOURCE_REGISTRY_INVALID');
    expect(readFileSync(path)).toEqual(before);
  });
});
