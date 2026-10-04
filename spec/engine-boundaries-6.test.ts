import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';

describe('engine boundary cases 57 and 59', () => {
  it('treats an external historical command as evidence but still binds a published local replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-boundaries-6-citation-'));
    try {
      const project = join(root, 'current');
      const other = join(root, 'other');
      mkdirSync(join(project, 'reports'), { recursive: true });
      mkdirSync(join(other, 'tests'), { recursive: true });
      writeFileSync(join(other, 'tests', 'test_other.py'), 'def test_other(): assert True\n');
      const report = join(project, 'reports', 'evidence.md');
      const inspect = () => inspectStageArtifactContract({
        stageId: 'report', template: 'Write reports/evidence.md.', projectDir: project,
        runDir: join(root, 'run'), writes: ['reports/evidence.md'],
      });
      const otherTest = join(other, 'tests', 'test_other.py');
      writeFileSync(report, `# Evidence\n\nIn the other project at ${other}, the historical command `
        + `\`pytest ${otherTest} -q\`` + ' was recorded.\n');
      const historical = inspect();
      expect(historical.violations).toEqual([]);
      expect(historical.replayExecutions).toEqual([]);

      writeFileSync(report, `Other project used \`pytest ${otherTest} -q -p no:cacheprovider\`.\n`);
      expect(inspect().replayExecutions).toEqual([]);

      writeFileSync(report, `Other project used \`pytest ${otherTest} tests -q\`.\n`);
      expect(inspect().replayExecutions[0]).toMatchObject({ status: 'not_run' });

      writeFileSync(report, `In the other project at ${other}, the historical command `
        + '`pytest tests/test_other.py -q`' + ' was recorded.\n');
      const relativeCitation = inspect();
      expect(relativeCitation.violations.some((entry) => entry.mention === 'tests/test_other.py')).toBe(true);
      expect(relativeCitation.replayExecutions[0]).toMatchObject({ status: 'not_run' });

      writeFileSync(report, `In the other project at ${other}, the historical command `
        + '`pytest tests/test_other.py -q`' + "; this project's replay is `pytest tests/missing.py -q`.\n");
      const mixed = inspect();
      expect(mixed.violations.some((entry) => entry.mention === 'tests/missing.py')).toBe(true);
      expect(mixed.replayExecutions.some((entry) => entry.command === 'pytest tests/missing.py -q'
        && entry.status === 'not_run')).toBe(true);

      writeFileSync(report, `Other project used \`pytest ${otherTest} -q\`, but for our project the replay is `
        + '`pytest tests/missing.py -q`.\n');
      const externalAndLocal = inspect();
      expect(externalAndLocal.replayExecutions.map((entry) => entry.command)).toEqual(['pytest tests/missing.py -q']);
      expect(externalAndLocal.violations.some((entry) => entry.mention === 'tests/missing.py')).toBe(true);

      writeFileSync(report, `Other project used \`pytest ${otherTest} -q --config=tests/pytest.ini\`.\n`);
      expect(inspect().replayExecutions[0]).toMatchObject({ status: 'not_run' });

      writeFileSync(report, `The other project at ${other} was cited, but this project's replay is `
        + '`pytest tests/missing.py -q`.\n');
      expect(inspect().violations.some((entry) => entry.mention === 'tests/missing.py')).toBe(true);

      writeFileSync(report, `The other project at ${other} used `
        + '`pytest tests/test_other.py -q`' + " and this project's replay is `pytest tests/missing.py -q`.\n");
      expect(inspect().violations.some((entry) => entry.mention === 'tests/missing.py')).toBe(true);

      writeFileSync(report, '# Local evidence\n\nThe local command `pytest tests/test_other.py -q` was recorded.\n');
      expect(inspect().violations.some((entry) => entry.mention === 'tests/test_other.py')).toBe(true);

      writeFileSync(report, '# Replay\n\nReplay command: `pytest tests/test_other.py -q`\n');
      const published = inspect();
      expect(published.violations.some((entry) => entry.kind === 'replay_command_target'
        && entry.mention === 'tests/test_other.py')).toBe(true);
      expect(published.replayExecutions[0]).toMatchObject({ status: 'not_run' });

      writeFileSync(report, `Replay command: \`pytest ${otherTest} -q\`\n`);
      const explicitExternal = inspect();
      expect(explicitExternal.violations.some((entry) => entry.mention === otherTest
        && entry.reason.includes('outside this project'))).toBe(true);
      expect(explicitExternal.replayExecutions[0]).toMatchObject({ status: 'not_run' });

      writeFileSync(report, 'For example, another project used `pytest tests/missing.py -q`.\n');
      expect(inspect().violations.some((entry) => entry.mention === 'tests/missing.py')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('guides non-research terminal routing through a real gate fact and retains research admission refusal', () => {
    const stage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({
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
