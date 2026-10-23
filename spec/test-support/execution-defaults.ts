import { loadEngineDefaults } from '../../src/config.js';

export function readExecutionDefaults(): { timeoutMs: number; maxIterations: number; gateRetryLoops: number; stageTechnicalRetries: number } {
  const defaults = loadEngineDefaults();
  return {
    timeoutMs: defaults.default_timeout_ms,
    maxIterations: defaults.max_iterations,
    gateRetryLoops: defaults.gate_retry_loops,
    stageTechnicalRetries: defaults.stage_technical_retries,
  };
}
