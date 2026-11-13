import { describe, expect, it } from 'vitest';
import { parseDeclaredScope, scopeMatchesProjectPath } from '../src/scheduler/sched_admission/scope-services.js';
import * as scheduler from '../src/scheduler.js';

describe('declared path language and shared-tree serialization', () => {
  it('treats a terminal directory glob as including nested dotfiles while shared-tree authors still serialize', () => {
    const matches = (entries: string[], path: string) => entries.some(entry => scopeMatchesProjectPath(parseDeclaredScope(entry), path));
    expect(matches(['.cache/**'], '.cache/a/b/c.json')).toBe(true);
    expect(matches(['.cache/**'], '.cache/a/.hidden.json')).toBe(true);
    expect(matches(['.cache/**'], '.cache/.hidden/nested.json')).toBe(true);
    expect(matches(['.cache/**'], 'dist/.hidden.json')).toBe(false);
    expect(matches(['.cache/**'], '.cache-peer/.hidden.json')).toBe(false);
    expect(scheduler.findScopeConflict(
      { id: 'left', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache/**'] },
      { id: 'right', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache-peer/**'] },
    )).toMatchObject({ leftStageId: 'left', rightStageId: 'right' });
  });
});

// Independent capabilities remain independent under reservations and peer leases.
