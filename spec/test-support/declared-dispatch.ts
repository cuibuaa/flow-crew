import { parse, stringify } from 'yaml';
import type { ArtifactContractInput } from '../../src/artifact-declarations.js';

/**
 * Explicitly authored synthetic dispatches used by existing engine scenarios.
 * These tests exercise scheduler controls, with no demanded product outputs
 * unless their construction supplies a contract. Gate verdicts are framework
 * outputs. Never recover test duties from prose or alter malformed declarations.
 */
export function declaredDispatch(text: string, contracts: Record<string, ArtifactContractInput> = {}): string {
  let parsed: unknown;
  try { parsed = parse(text); } catch { return text; }
  const stages = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === 'object' && 'stages' in parsed ? parsed.stages : undefined;
  if (!Array.isArray(stages)) return text;
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object' || typeof stage.id !== 'string' || 'artifact_contract' in stage) continue;
    stage.artifact_contract = contracts[stage.id] ?? {
      version: 1,
      produces: stage.is_gate === true ? [{ id: 'verdict', root: 'run', path: `verdict_${stage.id}.json` }] : [],
      reads: [],
    };
  }
  return stringify(parsed);
}
