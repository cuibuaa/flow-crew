import { afterEach, vi } from 'vitest';
import * as config from '../../src/config.js';

const readEngineDefaults = config.loadEngineDefaults;
let defaultsSpy: ReturnType<typeof vi.spyOn> | undefined;

/** Pin operator settings for runtime contracts without changing package files. */
export function setEngineDefaults(overrides: Partial<ReturnType<typeof readEngineDefaults>>): void {
  defaultsSpy ??= vi.spyOn(config, 'loadEngineDefaults');
  defaultsSpy.mockImplementation(() => ({ ...readEngineDefaults(), ...overrides }));
}

afterEach(() => { defaultsSpy?.mockRestore(); defaultsSpy = undefined; });
