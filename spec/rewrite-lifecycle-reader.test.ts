import { expect,it,vi } from 'vitest';
import * as reducer from '../rewrite-src/records/lifecycle.mjs';
import { withCurrentBoot } from '../rewrite-src/contract/status.mjs';
import { wireStatus as status } from './fixtures/rewrite-status.js';
it('boot interruption asks the lifecycle reducer for resume eligibility', () => {
  const snapshot = {...status('Run','running'),host:{...status('Run','running').host,boot:'prior'}};
  const eligibility = vi.spyOn(reducer,'nextLifecycle').mockReturnValue(null);
  try {
    expect(withCurrentBoot(snapshot,'current').interruption).toBeUndefined();
    expect(eligibility).toHaveBeenCalledWith('running','resume');
  } finally { eligibility.mockRestore(); }
});
