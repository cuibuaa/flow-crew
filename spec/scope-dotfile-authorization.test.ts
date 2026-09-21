import { describe, expect, it } from 'vitest';
import * as scheduler from '../src/scheduler.js';

describe('scope dotfile authorization', () => {
  it('[J7] treats a terminal directory glob as including nested dotfiles without reaching a peer scope', () => {
    const scopeContainsPath = (scheduler as unknown as {
      scopeContainsPath?: (scope: string[], path: string) => boolean;
    }).scopeContainsPath;
    expect(typeof scopeContainsPath).toBe('function');
    if (!scopeContainsPath) return;
    expect(scopeContainsPath(['.cache/**'], '.cache/a/b/c.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], '.cache/a/.hidden.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], '.cache/.hidden/nested.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], 'dist/.hidden.json')).toBe(false);
    expect(scopeContainsPath(['.cache/**'], '.cache-peer/.hidden.json')).toBe(false);
    expect(scheduler.findScopeConflict(
      { id: 'left', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache/**'] },
      { id: 'right', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache-peer/**'] },
    )).toBeUndefined();
  });
});
