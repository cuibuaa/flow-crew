import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { setFcGlobalDir, fcGlobalDir } from '../src/store.js';

const previous = fcGlobalDir();
let root: string;
afterEach(() => {
  setFcGlobalDir(previous);
  if (root) rmSync(root, { recursive: true, force: true });
});

// The gate's study-completion contract must not override terminal-file rejection.
// The absent/stale/plain cases reproduce the independent gate's recovery probe.
it.each(['absent', 'stale', 'fresh', 'no-declaration'] as const)(
  'study completion respects terminal declaration: %s', async shape => {
    root = mkdtempSync(join(tmpdir(), 'study-terminal-'));
    const project = join(root, 'project'); mkdirSync(project);
    setFcGlobalDir(join(root, 'store'));
    if (shape === 'stale') writeFileSync(join(project, 'result.md'), 'unchanged launch content');
    const workflow = WorkflowConfigSchema.parse({
      name: 'study', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
        { id: 'a', role: 'coder', scope: ['result.md'] },
        { id: 'g', role: 'qa', is_gate: true, scope: [], depends_on: ['a'] },
        { id: 'r', role: 'coder', scope: ['result.md'], depends_on: ['g'], retry_to: ['g'] },
      ],
    });
    const adapter = new ScriptedAdapter({
      a: shape === 'fresh' ? { projectFiles: { 'result.md': 'reviewed current result' } } : {},
      g: { runFiles: { 'verdict_g.json': JSON.stringify({
        pass: true, reason: 'study_complete_without_model_success', model_success: false, study_complete: true,
      }) } },
    });
    const brief = shape === 'no-declaration' ? 'Finish an independently reviewed study.'
      : '---\nterminal_states:\n  complete: [result.md]\n---\nWrite and independently review the required terminal result.\n';
    const state = await runWorkflow(workflow, '', project, adapter, new Map(), undefined,
      join(import.meta.dirname, '../config/agents'), undefined, brief, true);
    expect(state.stages.g.gate?.pass).toBe(true);
    if (shape === 'no-declaration' || shape === 'fresh') {
      expect(state.status, state.failureReason).toBe('complete');
      expect(state.terminalArtifact).toBe(shape === 'fresh' ? 'result.md' : undefined);
    } else {
      expect(state.status).toBe('incomplete');
      expect(state.terminalArtifact).toBeUndefined();
      expect(state.failureReason).toContain(shape === 'absent' ? 'result.md is absent' : 'content is unchanged');
    }
  },
);
