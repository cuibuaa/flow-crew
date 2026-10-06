import type { ArtifactContract } from '../../src/artifact-declarations.js';

/** Synthetic control fixtures demand no products, reads or replay evidence. */
export function emptyArtifactContract(): ArtifactContract {
  return { version: 1, produces: [], reads: [], groups: [], replays: [] };
}

/** The gate's authored verdict is its explicit framework output. */
export function gateArtifactContract(stageId: string): ArtifactContract {
  return {
    ...emptyArtifactContract(),
    produces: [{ id: 'verdict', root: 'run', path: `verdict_${stageId}.json`, kind: 'file', nonempty: true }],
  };
}

/** These planner fixtures author one dispatch and demand no other evidence. */
export function planArtifactContract(): ArtifactContract {
  return {
    ...emptyArtifactContract(),
    produces: [{ id: 'dispatch', root: 'run', path: 'dispatch.yaml', kind: 'file', nonempty: true }],
  };
}
