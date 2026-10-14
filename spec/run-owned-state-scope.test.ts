import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execWithStdin } from '../src/adapters/base.js';
import { producesEngineOwnedArtifact } from '../src/artifact-declarations.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { registerEngineOwnedSqlitePath } from '../src/engine-owned-carriers.js';
import { createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string, project: string, run: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [], replays: [] };
const stage = { id: 'work', depends_on: [] };
const authorFiles = [
  'run.json.backup', 'events.jsonl.backup', 'workflow.yaml.backup', 'task_brief.md.backup',
  'brief_criteria.json.backup', 'validation_baseline.json.backup', 'validation_delta_notes.md',
  'dispatch_admission.json.backup', 'run_history.jsonl.backup', 'resource_leases_notes.md',
  'stage_watchdog.json.backup', 'supervisor_state.json.backup', 'supervisor_usage.json.backup',
  'verdict_notes.md', 'handoff_notes.txt',
  ...['status.json.backup', 'input.md.backup', 'output_schema.json.backup', 'invocations.backup/record',
    'attempt_generation.json.backup', 'plan_revision_decision_notes.md', 'scope_revision_decision_notes.md',
    'approval_resolution_notes.md', 'attempt_deadline_notes.md', 'constraint_audit_notes.md',
    'command_activity.json.backup', 'session.json.backup', 'artifact_contract.json.backup',
    'guidance_consumed.md.backup', 'guidance.md.backup', 'live.log.txt', 'trace.jsonl.backup']
    .map(path => `stages/work/${path}`),
];
const input = () => ({ projectDir: project, runDir: run, stageId: stage.id, artifactContract: contract });
const write = (path: string, bytes: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'run-owned-state-scope-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', [stage.id]).runDirPath;
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

describe('run-owned state scope', () => {
  it('lets author tools update backup and diagnostic files without changing engine records', async () => {
    for (const path of authorFiles) write(join(run, path), 'original author copy');
    const projection = readFileSync(join(run, 'run.json'));
    await withEngineIntegrity(input(), async () => {
      const result = await execWithStdin(process.execPath, ['-e',
        `const fs=require('node:fs');for(const file of ${JSON.stringify(authorFiles.map(path => join(run, path)))})fs.writeFileSync(file,'authored update');`],
      '', { cwd: project, timeout_ms: 5000 });
      expect(result.exitCode).toBe(0);
    });
    for (const path of authorFiles) expect(readFileSync(join(run, path), 'utf8')).toBe('authored update');
    expect(readFileSync(join(run, 'run.json'))).toEqual(projection);
  });

  it('admits authored artifacts whose names merely start with a reserved filename', () => {
    for (const path of authorFiles) {
      expect(producesEngineOwnedArtifact({ id: 'copy', root: 'run', path, kind: 'file' }, stage, run, project), path).toBe(false);
    }
  });

  it('executes a declared authored handoff note without reserving the handoff prefix', async () => {
    const path = 'handoff_notes.txt';
    await withEngineIntegrity({ ...input(), artifactContract: { ...contract,
      produces: [{ id: 'notes', root: 'run', path, kind: 'file' }] } }, async () => {
      writeFileSync(join(run, path), 'authored notes');
    });
    expect(readFileSync(join(run, path), 'utf8')).toBe('authored notes');
  });

  it('leaves registered custom databases and their SQLite companions to concurrent owners', async () => {
    const directory = join(root, 'shared'); mkdirSync(directory);
    const path = join(directory, 'custom.sqlite'); registerEngineOwnedSqlitePath(path);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(value)');
    try {
      await withEngineIntegrity(input(), async () => {
        const result = await execWithStdin(process.execPath, ['-e',
          `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path)});db.exec('INSERT INTO fixture VALUES (1); PRAGMA wal_checkpoint(TRUNCATE)');db.close();`],
        '', { cwd: project, timeout_ms: 5000 });
        expect(result.exitCode).toBe(0);
      });
      expect(db.prepare('SELECT * FROM fixture').all()).toHaveLength(1);
    } finally { db.close(); }
  });

  it('still rejects changes to exact and generated engine records', async () => {
    for (const local of ['run.json', 'stages/work/status.json', 'validation_delta_review.json',
      'stages/work/plan_revision_decision_request.json', 'stages/work/scope_revision_decision_attempt_1_request.json',
      'stages/work/attempt_deadline_1.jsonl', 'stages/work/constraint_audit_attempt_1.json']) {
      const path = join(run, local), original = readFileSync(join(run, 'run.json'), 'utf8');
      write(path, original);
      await expect(withEngineIntegrity(input(), async () => { writeFileSync(path, 'counterfeit'); })).rejects.toThrow('ENGINE_STATE_TAMPERED');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
  });
});
