import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArtifactReadSchema, RecordedArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { StageConfigSchema, parseDispatchedStageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { createRun, runDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import type { AgentConfig } from '../src/adapters/base.js';

interface RecordedStage {
  id: string;
  artifact_contract?: {
    version: number;
    produces?: Array<{ id: string; root: string; path: string; kind: string }>;
    reads?: Array<{ id: string; root: string; path: string; kind: string; source?: unknown }>;
  };
}
const attempts = parse(readFileSync(join(import.meta.dirname, 'fixtures/planner-read-source/rejected-dispatches.yaml'), 'utf8')) as Array<{
  attempt: number; stages: RecordedStage[];
}>;

function correctedStages(stages: RecordedStage[]): RecordedStage[] {
  return stages.map(stage => {
    if (!stage.artifact_contract) return structuredClone(stage);
    const contract = structuredClone(stage.artifact_contract);
    contract.produces ??= [{ id: 'verdict', root: 'run', path: `verdict_${stage.id}.json`, kind: 'file' }];
    contract.reads ??= [];
    for (const read of contract.reads) {
      const producer = stages.find(candidate => candidate.artifact_contract?.produces?.some(
        output => output.root === read.root && output.path === read.path && output.kind === read.kind,
      ));
      const output = producer?.artifact_contract?.produces?.find(output => output.path === read.path);
      if (!producer || !output) throw new Error(`Fixture read ${read.id} has no producer`);
      read.source ??= { kind: 'stage', stage: producer.id, artifact: output.id };
    }
    return { ...structuredClone(stage), artifact_contract: contract };
  });
}

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
        stageId: 'plan', role, dependsOn: [], promptTemplate: 'Plan.', timeout_ms: 10_000,
        projectDir: project, runId, runDir: runDir(project, runId), retries: 0,
        artifactContract: RecordedArtifactContractSchema.parse({ version: 1, produces: [], reads: [] }),
      });
      expect(result.exitCode).toBe(0);
      expect(received).not.toContain('{artifact_contract_schema}');
      const description = received.match(/Optional artifact_contract must match this input JSON schema[^\n]*\n([^\n]+)/)?.[1];
      expect(description, 'planner must receive the generated artifact_contract input schema').toBeDefined();
      const schema = JSON.parse(description!);
      expect(schema).toEqual(z.toJSONSchema(RecordedArtifactContractSchema, { io: 'input' }));
      const { $schema, ...readSchema } = z.toJSONSchema(ArtifactReadSchema, { io: 'input' });
      expect(schema.properties.reads.items).toEqual(readSchema);
      expect(schema.required).toEqual(['version', 'produces', 'reads']);
      expect(schema.properties.reads.items.required).toContain('source');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reproduces the exact missing fields from attempt 3', () => {
    const failures = attempts[2].stages.flatMap(stage => {
      const parsed = StageConfigSchema.safeParse(stage);
      return parsed.success ? [] : parsed.error.issues.map(issue => `${stage.id}.${issue.path.join('.')}`);
    });
    expect(failures).toEqual([
      'implement_probe.artifact_contract.reads',
      'qa_gate.artifact_contract.produces',
      'qa_gate.artifact_contract.reads.0.source',
      'qa_gate.artifact_contract.reads.1.source',
      'finalize_report.artifact_contract.reads.0.source',
      'finalize_report.artifact_contract.reads.1.source',
    ]);
  });

  it.each(attempts)('accepts attempt $attempt in the stage admission schema after adding missing artifact fields only', ({ stages }) => {
    for (const stage of correctedStages(stages)) {
      expect(StageConfigSchema.safeParse(stage)).toMatchObject({ success: true });
      if (stage.artifact_contract) expect(RecordedArtifactContractSchema.safeParse(stage.artifact_contract)).toMatchObject({ success: true });
    }
  });

  it('preserves every recorded field and binds repaired reads to their declared producer', () => {
    expect(correctedStages(attempts[0].stages)).toEqual(attempts[0].stages);
    expect(correctedStages(attempts[1].stages)).toEqual(attempts[1].stages);
    const fixed = correctedStages(attempts[2].stages);
    const restored = structuredClone(fixed);
    delete restored[0].artifact_contract!.reads;
    delete restored[1].artifact_contract!.produces;
    for (const index of [1, 3]) for (const read of restored[index].artifact_contract!.reads!) delete read.source;
    expect(restored).toEqual(attempts[2].stages);
    expect(inspectArtifactDeclarations({ stages: fixed.map(parseDispatchedStageConfig), scopeOwns: () => true })).toEqual([]);
  });
});
