import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findScopeConflict, parseDeclaredScope, selectRunnableBatch } from '../src/scheduler/sched_admission/frontier.js';
import { scopeLanguagesMayOverlap, scopeMatchesProjectPath, type ParsedScope } from '../src/scheduler/sched_admission/scope-services.js';
import { firstDeclaredInputScopeConflict } from '../src/scheduler/sched_scope/path-capabilities.js';
import type { StageConfig } from '../src/scheduler.js';

function stage(id: string, scope?: string[]): StageConfig {
  return { id, scope, role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false };
}

describe('shared scope language', () => {
  it.each([true, false])('admits an explicit reader beside a missing scope (reader first: %s)', readerFirst => {
    const reader = stage('reader', []), missing = stage('missing');
    const ready = readerFirst ? [reader, missing] : [missing, reader];
    const batch = selectRunnableBatch(ready);
    expect(batch.selected).toEqual(ready);
    expect(batch.deferred).toEqual([]);
  });

  it.each([undefined, ['src/**']])('serializes a missing scope beside another possible writer (%j)', scope => {
    for (const ready of [[stage('missing'), stage('writer', scope)], [stage('writer', scope), stage('missing')]]) {
      const batch = selectRunnableBatch(ready);
      expect(batch.selected).toEqual([ready[0]]);
      expect(batch.deferred).toMatchObject([{ stage: ready[1], conflict: { reason: expect.stringContaining('no declared scope') } }]);
    }
  });

  it('admits a wildcard-prefix tree beside an incompatible literal path', () => {
    const batch = selectRunnableBatch([
      stage('writer', ['workspace-*/**']),
      stage('publisher', ['skills/publish.md']),
    ]);
    expect(batch.selected.map(item => item.id)).toEqual(['writer', 'publisher']);
    expect(batch.deferred).toEqual([]);
    const scope = parseDeclaredScope('workspace-*/**');
    expect(scopeMatchesProjectPath(scope, 'workspace-one/result.txt')).toBe(true);
    expect(scopeMatchesProjectPath(scope, 'skills/publish.md')).toBe(false);
  });

  it('proves incompatible wildcard segment languages disjoint before a globstar', () => {
    expect(findScopeConflict(stage('left', ['outputs/a*/**']), stage('right', ['outputs/b*/**']))).toBeUndefined();
  });

  it('preserves punctuation as literal content in a read-only input tree', () => {
    const inputPath = 'data/[raw]';
    const inputTree: ParsedScope = { kind: 'tree', raw: inputPath, value: inputPath };
    const input = { path: inputPath, resolvedPath: inputPath, kind: 'tree' as const };
    expect(scopeMatchesProjectPath(inputTree, 'data/[raw]/file.txt')).toBe(true);
    expect(scopeMatchesProjectPath(inputTree, 'data/r/file.txt')).toBe(false);
    expect(scopeLanguagesMayOverlap(inputTree, parseDeclaredScope('data/r/file.txt'))).toBe(false);
    expect(firstDeclaredInputScopeConflict(['data/r/file.txt'], [input])).toBeUndefined();
    expect(scopeLanguagesMayOverlap(inputTree, parseDeclaredScope('data/*/file.txt'))).toBe(true);
    expect(firstDeclaredInputScopeConflict(['data/*/file.txt'], [input])).toMatchObject({
      inputPath, inputKind: 'tree', comparison: 'declared_path',
    });
  });

  it.each([
    ['dist/**', 'dist/.manifest.json', 'dist/.manifest.json'],
    ['src/store.ts', 'src/store.ts', 'src/store.ts'],
    ['src/worker.ts', 'src/worker.ts', 'src/worker.ts'],
    ['spec/runner.test.ts', 'spec/runner.test.ts', 'spec/runner.test.ts'],
    ['workspace-*/**', 'workspace-check/result.txt', 'workspace-check/result.txt'],
    ['src/**/**/store.ts', 'src/store.ts', 'src/store.ts'],
    ['src/{left,right}/**', 'src/right/file.ts', 'src/right/file.ts'],
    ['src/[ab]*/**', 'src/alpha/file.ts', 'src/alpha/file.ts'],
    ['src/@(left|right)/**', 'src/right/file.ts', 'src/right/file.ts'],
    ['assets/{left,{middle,right}/nested}/**', 'assets/right/nested/file.txt', 'assets/right/nested/file.txt'],
    ['src/?(left|right)*/**', 'src/right/file.ts', 'src/right/file.ts'],
  ])('serializes intersecting scopes %s and %s with an authorized witness', (left, right, witness) => {
    expect(scopeMatchesProjectPath(parseDeclaredScope(left), witness)).toBe(true);
    expect(scopeMatchesProjectPath(parseDeclaredScope(right), witness)).toBe(true);
    const batch = selectRunnableBatch([stage('left', [left]), stage('right', [right])]);
    expect(batch.selected.map(item => item.id)).toEqual(['left']);
    expect(batch.deferred).toHaveLength(1);
  });

  it.each([
    'src/*/file.ts', 'src/**/file.ts', 'src/**/**/file.ts', 'src/a?.ts',
    'src/{left,right}/file.ts', 'src/[ab]*/file.ts', 'src/@(left|right)/file.ts',
    'src/?(left|right)*/file.ts', 'workspace-*/**', 'src/**/**',
  ])('preserves exact Node glob authorization for %s', pattern => {
    for (const path of ['src', 'workspace-one', 'workspace-one/file.ts', 'src/file.ts', 'src/left/file.ts', 'src/right/file.ts', 'src/alpha/file.ts', 'src/.hidden/file.ts', 'src/a1.ts', 'src/other.ts']) {
      expect(scopeMatchesProjectPath(parseDeclaredScope(pattern), path), path).toBe(posix.matchesGlob(path, pattern));
    }
  });

  it('never admits scopes with a common Node glob witness in a small path universe', () => {
    const names = ['a', 'b', 'aa', 'ab', 'a.txt', '.hidden', '😀', '😀x', 'x😀'];
    const paths = [...names];
    for (const first of names) for (const second of names) {
      paths.push(`${first}/${second}`);
      for (const third of names) paths.push(`${first}/${second}/${third}`);
    }
    const scopes = [
      '*', '?', 'a*', '*b', '*.txt', '.*', '😀*', '?😀', '😀?', '?*', '*?',
      '[ab]*', '{a,b}', '@(a|b)', '?(a|b)', '*(a|b)', '!(a)',
      '**', '**/**', '**/a', '**/b', '**/.hidden', '**/😀?', 'a*/**',
      'a*/**/b', 'a*/**/a', '**/a*/**', '*/a', '*/b', '*/?😀',
      'a/**', 'a', 'a/a.txt', '{a,{b,aa}/ab}/**',
    ];
    const witnesses = scopes.map(scope => new Set(paths.filter(path => {
      // Independently spell out the existing literal-tree capability language;
      // every other expected member comes from Node's platform glob matcher.
      if (scope === 'a/**' || scope === 'a') return path === 'a' || path.startsWith('a/');
      if (scope === 'a/a.txt') return path === scope || path.startsWith(`${scope}/`);
      return posix.matchesGlob(path, scope);
    })));
    for (let i = 0; i < scopes.length; i++) for (let j = i; j < scopes.length; j++) {
      const witness = [...witnesses[i]].find(path => witnesses[j].has(path));
      if (witness !== undefined) {
        expect(findScopeConflict(stage('left', [scopes[i]]), stage('right', [scopes[j]])),
          `${scopes[i]} ↔ ${scopes[j]} at ${witness}`).toBeDefined();
      }
    }
  });
});
