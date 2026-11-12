import { stageFixtureCommand } from './stage-command.js';
import { afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Adapter } from '../../src/adapters/base.js';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** Control-plane scenarios supply synthetic rejected verdicts, not product
 * defects. Give those scenarios an explicit, executable fixture predicate so
 * they still exercise repair budgets/replans under the confirmed-finding rule.
 * The new gate-repair-confirmation spec separately probes an actual product file.
 * Nothing in production derives confirmation from a verdict or writes this flag. */
export function withConfirmedRejections(adapter: Adapter, timeoutMs?: number): Adapter {
  const root = mkdtempSync(join(tmpdir(), 'confirmed-rejection-fixture-')); scratch.push(root);
  const marker = join(root, 'predicate');
  writeFileSync(marker, 'clear\n');
  return { ...adapter, async run(prompt, role, opts) {
    if (!opts.outputSchema?.anyOf && !['choose', 'assess', 'plan'].includes(opts.stageId)) writeFileSync(marker, 'clear\n');
    const result = await adapter.run(prompt, role, opts);
    if (result.exitCode || !opts.outputSchema?.anyOf) return result;
    let verdict: Record<string, any>;
    try { verdict = JSON.parse(result.output); } catch { return result; }
    const existing = verdict.audit_findings?.findings;
    if (verdict.pass !== false || existing !== undefined && (!Array.isArray(existing) || existing.some((finding: Record<string, unknown>) => !finding || typeof finding !== 'object' || finding.reproduction !== undefined))) return result;
    writeFileSync(marker, 'present\n');
    const predicate = `'${marker.replaceAll("'", "'\\''")}'`;
    const command = `IFS= read -r fixture_predicate < ${predicate} && test "$fixture_predicate" != present`;
    // Reproductions, unlike native progress facts, use the engine's tree-bound endpoint.
    const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
    const request = JSON.stringify({ command, cwd: opts.workDir, shell: '/bin/sh' });
    const { runProjectCommand } = await import('../../src/project-validation.js');
    const execute = timeoutMs === undefined ? stageFixtureCommand : runProjectCommand;
    const response = await execute({ role: 'test', command: '/bin/sh',
      args: ['-c', `${client} '${request.replaceAll("'", "'\\''")}'`], display: 'Fixture reproduction',
      cwd: opts.workDir, runDir: opts.runDir, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const recorded = JSON.parse(response.stdout!).record;
    if (response.exitCode !== 0 || recorded.exitCode !== 1) throw new Error('Fixture predicate did not reproduce');
    const reproduction = recorded.sequence;
    verdict.audit_findings = { version: 1, findings: existing?.length
      ? existing.map((finding: Record<string, unknown>) => ({ ...finding, reproduction }))
      : [{ id: 'fixture_defect', paths: ['fixture'], reason: 'Scripted fixture predicate is present',
        criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction }] };
    return { ...result, output: JSON.stringify(verdict) };
  } };
}
