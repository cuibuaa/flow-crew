import { rehearseBrief, type IsolatedRehearsalOptions, type IsolatedRehearsalResult } from '../../src/rehearse.js';

export function rehearseBriefIsolated(
  brief: string,
  options: IsolatedRehearsalOptions = {},
): Promise<IsolatedRehearsalResult> {
  return rehearseBrief([options.label ?? 'generated-successor.md'], {
    ...options,
    briefText: brief,
    render: false,
  });
}
