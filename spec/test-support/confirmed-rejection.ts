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
export function withConfirmedRejections(adapter: Adapter): Adapter {
  const root = mkdtempSync(join(tmpdir(), 'confirmed-rejection-fixture-')); scratch.push(root);
  const marker = join(root, 'predicate');
  writeFileSync(marker, 'clear');
  return { ...adapter, async run(prompt, role, opts) {
    if (!opts.outputSchema?.anyOf && !['choose', 'assess', 'plan'].includes(opts.stageId)) writeFileSync(marker, 'clear');
    const result = await adapter.run(prompt, role, opts);
    if (result.exitCode || !opts.outputSchema?.anyOf) return result;
    let verdict: Record<string, any>;
    try { verdict = JSON.parse(result.output); } catch { return result; }
    const existing = verdict.audit_findings?.findings;
    if (verdict.pass !== false || existing !== undefined && (!Array.isArray(existing) || existing.some((finding: Record<string, unknown>) => !finding || typeof finding !== 'object' || finding.reproduction !== undefined))) return result;
    writeFileSync(marker, 'present');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8')==='present'?1:0)`)}`;
    const id = `fixture-${opts.stageId}`;
    opts.onCommandLifecycle?.({ phase: 'started', id, command, context: { cwd: opts.workDir, shell: '/bin/sh' }, timestamp: new Date().toISOString() });
    // Load after a fixture's policy-runtime reset, sharing its carrier owner.
    const { runProjectCommand } = await import('../../src/project-validation.js');
    const { readEvidence } = await import('../../src/evidence-ledger.js');
    const response = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', command], display: command,
      cwd: opts.workDir, runDir: opts.runDir, timeoutMs: 5000 });
    if (response.exitCode !== 1) throw new Error('Fixture predicate did not reproduce');
    opts.onCommandLifecycle?.({ phase: 'completed', id, command, exitCode: response.exitCode,
      output: JSON.stringify([response.stdout ?? '', response.stderr ?? '']), timestamp: new Date().toISOString() });
    const reproduction = readEvidence(opts.runDir).at(-1)!.sequence;
    verdict.audit_findings = { version: 1, findings: existing?.length
      ? existing.map((finding: Record<string, unknown>) => ({ ...finding, reproduction }))
      : [{ id: 'fixture_defect', paths: ['fixture'], reason: 'Scripted fixture predicate is present',
        criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction }] };
    return { ...result, output: JSON.stringify(verdict) };
  } };
}
