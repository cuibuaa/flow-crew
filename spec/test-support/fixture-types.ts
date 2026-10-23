import type { z } from 'zod';
import type { ArtifactContractSchema } from '../../src/artifact-declarations.js';
import type { PlanRevisionRequestSchema } from '../../src/plan-revisions.js';

export type ArtifactContractInput = z.input<typeof ArtifactContractSchema>;
export type PlanRevisionRequest = z.infer<typeof PlanRevisionRequestSchema>;
