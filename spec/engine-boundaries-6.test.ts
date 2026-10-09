import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';

describe('engine boundary cases 57 and 59', () => {

  it('guides non-research terminal routing through a real gate fact and retains research admission refusal', () => {
    const stage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({
      artifact_contract: fixtureArtifactContract(String(raw.id), raw.is_gate === true),
      prompt_template: 'fixture', skills: [], criterion_refs: [], is_gate: false,
      depends_on: [], dependency_reasons: {}, ...raw,
    });
    const work = stage({ id: 'work', role: 'coder', scope: ['docs/evidence.md'] });
    const gate = stage({ id: 'gate', role: 'qa', is_gate: true, scope: [], depends_on: ['work'],
      dependency_reasons: { work: 'Check the produced evidence.' } });
    const owner = (id: string, path: string, condition: string) => stage({
      id, role: 'doc_writer', scope: [path], depends_on: ['gate'],
      dependency_reasons: { gate: 'Use the gate decision.' }, condition,
    });
    const terminalStates = {
      complete: { paths: ['docs/complete.md'] },
      blocked: { paths: ['docs/blocked.md'] },
    };
    const ordinary = [work, gate,
      owner('complete', 'docs/complete.md', 'gate.outcome == complete'),
      owner('blocked', 'docs/blocked.md', 'gate.outcome == blocked')];
    const admitted = inspectDispatchAdmission({ dispatched: ordinary, baseStages: [],
      dispatchStageId: 'plan', terminalStates });
    expect(admitted.pass).toBe(true);
    const undefinedFacts = [work, gate,
      owner('complete', 'docs/complete.md', 'research.terminalPath == docs/complete.md'),
      owner('blocked', 'docs/blocked.md', 'research.terminalPath == docs/blocked.md')];
    const refused = inspectDispatchAdmission({ dispatched: undefinedFacts, baseStages: [],
      dispatchStageId: 'plan', terminalStates });
    expect(refused.pass).toBe(false);
    expect(refused.errors.filter((error) => error.includes('framework research facts in a non-research run'))).toHaveLength(2);
  });
});
