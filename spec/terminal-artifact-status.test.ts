import { describe, expect, it } from 'vitest';
import { terminalArtifactStatusMismatch } from '../src/terminal-artifact-status.js';

describe('terminal artifact status diagnostics', () => {
  it('returns only an unambiguous disagreement and never rewrites lifecycle status', () => {
    const state = {
      status: 'complete',
      terminalArtifact: 'escalation_note.md',
      terminalStates: {
        complete: { paths: ['docs/parity_verification.md'] },
        escalated: { paths: ['docs/front_end_parity/escalation_note.md'] },
      },
    };

    expect(terminalArtifactStatusMismatch(state)).toEqual({
      lifecycleStatus: 'complete',
      terminalStatus: 'escalated',
      terminalArtifact: 'escalation_note.md',
    });
    expect(state.status).toBe('complete');
  });

  it('returns no disagreement for a matching lifecycle status or an ambiguous basename', () => {
    expect(terminalArtifactStatusMismatch({
      status: 'escalated',
      terminalArtifact: 'result.md',
      terminalStates: { escalated: { paths: ['docs/result.md'] } },
    })).toBeUndefined();

    expect(terminalArtifactStatusMismatch({
      status: 'complete',
      terminalArtifact: 'result.md',
      terminalStates: {
        complete: { paths: ['good/result.md'] },
        escalated: { paths: ['blocked/result.md'] },
      },
    })).toBeUndefined();
  });
});
