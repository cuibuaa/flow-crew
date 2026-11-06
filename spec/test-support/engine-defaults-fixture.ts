import { afterEach, vi } from 'vitest';
import * as config from '../../src/config.js';

const readEngineDefaults = config.loadEngineDefaults;
let defaultsSpy: ReturnType<typeof vi.spyOn> | undefined;

/** Pin operator settings for runtime contracts without changing package files.
 * Policy fixtures declare a permissive host ceiling and no wait; numeric load
 * specs override both explicitly, and native trials use installed defaults. */
export function setEngineDefaults(overrides: Partial<ReturnType<typeof readEngineDefaults>>): void {
  defaultsSpy ??= vi.spyOn(config, 'loadEngineDefaults');
  defaultsSpy.mockImplementation(() => ({ ...readEngineDefaults(), validation_load_wait_seconds: 0, validation_load_ceiling_per_cpu: 100, ...overrides }));
}

afterEach(() => { defaultsSpy?.mockRestore(); defaultsSpy = undefined; });
