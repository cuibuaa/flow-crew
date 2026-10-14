import { describe, expect, it } from 'vitest';
import { applyPatchToText } from '../src/campaign.js';

describe('operator brief patches', () => {
  it('appends within the requested section and preserves its neighbors', () => {
    const input = '# Brief\n\n## Goal\nOriginal.\n\n## Other\nKeep.\n';
    expect(applyPatchToText(input, { type: 'brief_patch', section: '## Goal', op: 'append', value: 'Addition.' }))
      .toBe('# Brief\n\n## Goal\nOriginal.\n\nAddition.\n\n## Other\nKeep.\n');
  });
  it('replaces the first value line rather than preceding notes', () => {
    expect(applyPatchToText('## Goal\nNotes.\nvalue: 1\n', { type: 'brief_patch', section: '## Goal', op: 'replace_value', value: 'value: 2' }))
      .toBe('## Goal\nNotes.\nvalue: 2\n');
  });
  it('edits only the requested section and refuses absent sections or edit targets', () => {
    const input = '## Goal\nvalue 1\n## Other\nvalue 1\n';
    expect(applyPatchToText(input, { type: 'brief_patch', section: '## Goal', op: 'edit', value: '1 -> 2' }))
      .toBe('## Goal\nvalue 2\n## Other\nvalue 1\n');
    expect(() => applyPatchToText(input, { type: 'brief_patch', section: '## Missing', op: 'append', value: 'x' })).toThrow('Section not found');
    expect(() => applyPatchToText(input, { type: 'brief_patch', section: '## Goal', op: 'edit', value: 'absent -> x' })).toThrow('Edit target not found');
  });
});
