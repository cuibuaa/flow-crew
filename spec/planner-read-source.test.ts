import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArtifactReadSchema, ArtifactContractSchema } from '../src/artifact-declarations.js';
import { PLAN_SCHEMA } from '../src/plan-interface.js';
import { createRun } from './test-support/create-run.js';
import { runDir } from '../src/store.js';
import { runStage } from './test-support/stage-deadline.js';
import type { AgentConfig } from '../src/adapters/base.js';

describe('planner artifact contract matches admission', () => {
  it('delivers the admission input schema in the actual planner invocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-read-source-'));
    const project = join(root, 'project'); mkdirSync(project);
    try {
      const role = parse(readFileSync(join(import.meta.dirname, '../config/agents/planner.yaml'), 'utf8')) as AgentConfig;
      const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['plan']);
      let received = '';
      const result = await runStage({ async run(_prompt: string, resolved: AgentConfig) {
        received = resolved.prompt;
        return { output: 'done', exitCode: 0, duration_ms: 1 };
      } }, {
        stageId: 'plan', role, dynamicDispatch: true, dependsOn: [], promptTemplate: 'Plan.', timeout_ms: 10_000,
        projectDir: project, runId, runDir: runDir(project, runId), retries: 0,
        artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [], reads: [] }),
      });
      expect(result.exitCode).toBe(0);
      expect(received).toContain(JSON.stringify(PLAN_SCHEMA));
      const { $schema: _schema, ...expected } = z.toJSONSchema(ArtifactContractSchema, { io: 'input' });
      const description = received.split('\n').find(line => line === JSON.stringify(PLAN_SCHEMA));
      expect(description, 'planner must receive the generated plan input schema').toBeDefined();
      const schema = JSON.parse(description!).properties.stages.items.properties.artifact_contract;
      expect(schema).toEqual(expected);
      const { $schema, ...readSchema } = z.toJSONSchema(ArtifactReadSchema, { io: 'input' });
      expect(schema.properties.reads.items).toEqual(readSchema);
      expect(schema.required).toEqual(['version', 'produces', 'reads']);
      expect(schema.properties.reads.items.required).toContain('source');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });


});
