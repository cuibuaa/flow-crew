import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';
import { inspectStageArtifactContract, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';

describe('engine boundary cases 57 and 59', () => {
  it('leaves historical prose inert and verifies every declared local replay target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-boundaries-6-citation-'));
    try {
      const project = join(root, 'current');
      const other = join(root, 'other');
      const run = join(root, 'run');
      mkdirSync(join(project, 'reports'), { recursive: true });
      mkdirSync(join(other, 'tests'), { recursive: true });
      mkdirSync(run);
      const otherTest = join(other, 'tests', 'test_other.py');
      writeFileSync(otherTest, 'def test_other(): assert True\n');
      const report = join(project, 'reports', 'evidence.md');
      const input = {
        stageId: 'report', template: 'Write reports/evidence.md.', projectDir: project, runDir: run,
        writes: ['reports/evidence.md'],
        artifactContract: ArtifactContractSchema.parse({ version: 1,
          produces: [{ id: 'report', root: 'project', path: 'reports/evidence.md' }], reads: [], replays: [],
        }),
      };
      for (const prose of [
        `In the other project at ${other}, the historical command \`pytest ${otherTest} -q\` was recorded.`,
        `Other project used \`pytest ${otherTest} -q -p no:cacheprovider\`.`,
        `Other project used \`pytest ${otherTest} tests -q\`.`,
        `In the other project at ${other}, the historical command \`pytest tests/test_other.py -q\` was recorded.`,
        `In the other project at ${other}, the historical command \`pytest tests/test_other.py -q\`; this project's replay is \`pytest tests/missing.py -q\`.`,
        `Other project used \`pytest ${otherTest} -q\`, but for our project the replay is \`pytest tests/missing.py -q\`.`,
        `Other project used \`pytest ${otherTest} -q --config=tests/pytest.ini\`.`,
        `The other project at ${other} was cited, but this project's replay is \`pytest tests/missing.py -q\`.`,
        `The other project at ${other} used \`pytest tests/test_other.py -q\` and this project's replay is \`pytest tests/missing.py -q\`.`,
        '# Local evidence\n\nThe local command `pytest tests/test_other.py -q` was recorded.',
        '# Replay\n\nReplay command: `pytest tests/test_other.py -q`',
        `Replay command: \`pytest ${otherTest} -q\``,
        'For example, another project used `pytest tests/missing.py -q`.',
      ]) {
        writeFileSync(report, prose + '\n');
        const historical = inspectStageArtifactContract(input);
        expect(historical.violations).toEqual([]);
        expect(historical.replayExecutions).toEqual([]);
        expect(historical.replayVerification).toBe('not_requested');
      }
      input.artifactContract = ArtifactContractSchema.parse({ ...input.artifactContract,
        reads: [{ id: 'missing', root: 'project', path: 'spec/missing.test.mjs', source: { kind: 'input' } }],
        replays: [{ id: 'local', runner: 'node_test', targets: ['missing'], argv: [], expected: { exit_code: 0, failures: [] } }],
      });
      const local = await verifyStageArtifactContract(input, { remainingMs: () => 10_000 });
      expect(local.replayVerification).toBe('refused');
      expect(local.replayExecutions).toEqual([expect.objectContaining({
        declarationId: 'local', status: 'not_run', reason: expect.stringContaining('REPLAY_INPUT_ABSENT'),
      })]);
      expect(local.violations).toContainEqual(expect.objectContaining({ kind: 'declared_replay' }));
      expect(() => ArtifactContractSchema.parse({ ...input.artifactContract,
        reads: [{ id: 'missing', root: 'project', path: otherTest, source: { kind: 'input' } }],
      })).toThrow(/exact, confined relative path/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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
