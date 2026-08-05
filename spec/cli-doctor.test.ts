import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { cmdDoctorMaintenance } from '../src/cli-doctor.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

let tempDir: string;
let previousFcHome: string;

beforeEach(() => {
  previousFcHome = fcGlobalDir();
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-cli-doctor-${randomBytes(4).toString('hex')}-`));
  setFcGlobalDir(tempDir);
});

afterEach(() => {
  setFcGlobalDir(previousFcHome);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('doctor registry maintenance CLI', () => {
  it('defaults repair to a line-by-line dry-run and requires --apply before changing the isolated registry', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const task = registry.create({ brief_text: '# cli repair', projectDir: tempDir });
    const final = { ...task, status: 'done', notes: 'complete suffix' };
    appendFileSync(registry.registryPath, `{"id":${task.id},"name":"torn${JSON.stringify(final)}\n`, 'utf-8');
    const original = readFileSync(registry.registryPath);
    const dry = new Capture();

    const dryCode = cmdDoctorMaintenance(
      ['doctor', '--repair-registry'],
      { stdout: dry.stdout as any, stderr: dry.stderr as any },
    );

    expect(dryCode).toBe(0);
    expect(dry.text()).toContain('registry repair — DRY-RUN');
    expect(dry.text()).toContain('line 2: repair');
    expect(dry.text()).toContain('Would create evidence backup');
    expect(dry.text()).toContain('No files changed');
    expect(readFileSync(registry.registryPath)).toEqual(original);

    const applied = new Capture();
    const applyCode = cmdDoctorMaintenance(
      ['--repair-registry', '--apply'],
      { stdout: applied.stdout as any, stderr: applied.stderr as any },
    );

    expect(applyCode).toBe(0);
    expect(applied.text()).toContain('registry repair — APPLIED');
    expect(applied.text()).toContain('Evidence backup:');
    expect(applied.text()).toContain('repaired=1 quarantined=0');
    expect(new TaskRegistry({ baseDir: tempDir }).health()).toEqual({ unreadableRecords: 0 });
    const backupPath = applied.text().match(/Evidence backup: (.+)\n/)?.[1];
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
  });

  it('routes compaction as a dry-run and rejects ambiguous maintenance requests', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const task = registry.create({ brief_text: '# cli compact', projectDir: tempDir });
    registry.update(task.id, { status: 'running' });
    const original = readFileSync(registry.registryPath);
    const compact = new Capture();

    expect(cmdDoctorMaintenance(
      ['--compact-registry'],
      { stdout: compact.stdout as any, stderr: compact.stderr as any },
    )).toBe(0);
    expect(compact.text()).toContain('registry compact — DRY-RUN');
    expect(compact.text()).toContain('line 1: drop-obsolete');
    expect(compact.text()).toContain('64 MiB');
    expect(readFileSync(registry.registryPath)).toEqual(original);

    const ambiguous = new Capture();
    expect(cmdDoctorMaintenance(
      ['--repair-registry', '--compact-registry'],
      { stdout: ambiguous.stdout as any, stderr: ambiguous.stderr as any },
    )).toBe(2);
    expect(ambiguous.errorText()).toContain('Choose one registry maintenance operation');
  });
});

class Capture {
  stdout = new PassThrough();
  stderr = new PassThrough();
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];

  constructor() {
    this.stdout.on('data', (chunk) => this.stdoutChunks.push(Buffer.from(chunk)));
    this.stderr.on('data', (chunk) => this.stderrChunks.push(Buffer.from(chunk)));
  }

  text(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf-8');
  }

  errorText(): string {
    return Buffer.concat(this.stderrChunks).toString('utf-8');
  }
}
