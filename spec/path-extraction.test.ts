import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig } from '../src/scheduler.js';
import type { ArtifactRead } from '../src/artifact-declarations.js';
import { artifacts, producedRead, stageArtifacts } from './spec_contracts/declared-fixtures.js';

const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-reality-reads-'));
  temporaryRoots.push(root);
  return root;
}

function markdownFor(type: string, params: Record<string, unknown>, reads: ArtifactRead[] = []): string {
  return ['## Reality checks', '```yaml', stringifyYaml({ checks: [{ name: 'path boundary probe', type, params, reads }] }).trimEnd(), '```'].join('\n');
}
function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true), prompt_template: 'exact declaration probe', skills: [],
    is_gate: false, criterion_refs: [], ...raw,
  });
}

describe('declared reality-check reads', () => {
  it('requires an exact output declaration even when a parent write scope covers the path', () => {
    const projectDir = temporaryProject(), path = 'docs/honest_plan/evidence.json';
    const writer = stage({ criterion_refs: [], id: 'evidence_writer', role: 'coder', scope: ['docs/honest_plan'], depends_on: [], dependency_reasons: {} });
    const markdown = markdownFor('file-exists-nonempty', { paths: [path] }, [producedRead('evidence', path, writer.id)]);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [writer] }).join('\n')).toContain('ARTIFACT_READ_UNBOUND');
    writer.artifact_contract = artifacts([{ id: 'evidence', root: 'project', path }]);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [writer] })).toEqual([]);
  });
  it.each([
    ['json-schema-match', { file: 'report.json', schema: { type: 'object' } }, 'report.json'],
    ['file-exists-nonempty', { paths: ['Makefile'] }, 'Makefile'],
  ] as const)('requires the declared handler input for %s', (type, params, path) => {
    const projectDir = temporaryProject(), markdown = markdownFor(type, params);
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [] }).join('\n')).toContain('ARTIFACT_HANDLER_READ_UNDECLARED');
    const read = producedRead('input', path, 'absent');
    const errors = inspectRealityCheckReachability({ markdown: markdownFor(type, params, [read]), projectDir, stages: [] });
    expect(errors.join('\n')).toContain('ARTIFACT_READ_UNBOUND');
  });
  it('checks every declared read independently of incidental operands in the same script', () => {
    const projectDir = temporaryProject(); writeFileSync(join(projectDir, 'present.json'), '{}\n');
    const reads: ArtifactRead[] = [
      { id: 'present', root: 'project', path: 'present.json', kind: 'file', source: { kind: 'input' } },
      producedRead('future', 'future.json', 'absent'),
    ];
    const errors = inspectRealityCheckReachability({ markdown: markdownFor('exec-script-exit-zero', { script: 'cat present.json future.json; console.error(manifest.rounds)' }, reads), projectDir, stages: [] });
    expect(errors).toEqual([expect.stringContaining('ARTIFACT_READ_UNBOUND')]);
  });
  it('still rejects an explicitly declared read of the mutable optional research result', () => {
    const path = 'docs/round.json';
    const measure = stage({ criterion_refs: [], id: 'measure', role: 'researcher', scope: [path], depends_on: [], dependency_reasons: {}, artifact_contract: artifacts([{ id: 'result', root: 'project', path }]) });
    const errors = inspectRealityCheckReachability({ markdown: markdownFor('json-schema-match', { file: path, schema: { type: 'object' } }, [producedRead('result', path, measure.id)]), projectDir: temporaryProject(), stages: [measure], research: { baseline: 0, policy: 'best_of_n', resultFile: path } });
    expect(errors.join('\n')).toContain('valid no-candidate round writes only its sidecar');
  });
  it('keeps the measurement-owner and continue-predicate admission probes red', () => {
    const measuringOwner = stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []),
      id: 'measure', role: 'researcher', scope: ['docs/round.json', 'docs/final.md'],
      depends_on: [], dependency_reasons: {}, condition: 'research.decision != continue',
    });
    const measuringReport = inspectDispatchAdmission({
      dispatched: [measuringOwner], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
    });
    expect(measuringReport.pass).toBe(false);
    expect(measuringReport.errors.join('\n')).toContain(
      'research result producer path docs/round.json cannot be owned by a terminal writer',
    );

    const continueOwner = stage({ criterion_refs: [], artifact_contract: artifacts([], [], [], []),
      id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
      dependency_reasons: {}, condition: 'research.decision == continue',
    });
    const continueReport = inspectDispatchAdmission({
      dispatched: [continueOwner], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n' },
    });
    expect(continueReport.pass).toBe(false);
    expect(continueReport.errors.join('\n')).toContain(
      'must be mechanically false when research.decision is continue',
    );
  });
});
