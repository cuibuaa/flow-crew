import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CommandActivityRecord {
  id: string;
  command?: string;
  startedAt: string;
}

export interface CommandActivitySnapshot {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  updatedAt: string;
  active: CommandActivityRecord[];
  completedCount: number;
  streamClosed: boolean;
}

function commandId(item: Record<string, unknown>, event: Record<string, unknown>): string | undefined {
  for (const value of [item.id, event.item_id, event.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function commandText(item: Record<string, unknown>): string | undefined {
  for (const value of [item.command, item.cmd, item.text]) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return undefined;
}

/** Durable parser for Codex's JSONL command lifecycle. Stdout may be fully
 * redirected by the command itself; item.started is still control-plane proof
 * that a child command is active. */
export class CommandActivityTracker {
  private readonly path: string;
  private readonly active = new Map<string, CommandActivityRecord>();
  private carry = '';
  private completedCount = 0;
  private streamClosed = false;

  constructor(private readonly input: {
    runDir: string;
    stageId: string;
    attemptIndex: number;
    attemptStartedAt: string;
    now?: () => string;
  }) {
    this.path = join(input.runDir, 'stages', input.stageId, 'command_activity.json');
    this.persist();
  }

  feed(chunk: string): void {
    this.carry += chunk;
    const lines = this.carry.split(/\r?\n/);
    this.carry = lines.pop() ?? '';
    for (const line of lines) this.consumeLine(line);
  }

  close(): void {
    if (this.carry.trim()) this.consumeLine(this.carry);
    this.carry = '';
    this.active.clear();
    this.streamClosed = true;
    this.persist();
  }

  private consumeLine(line: string): void {
    if (!line.trim().startsWith('{')) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type !== 'item.started' && type !== 'item.completed') return;
    const item = event.item && typeof event.item === 'object'
      ? event.item as Record<string, unknown>
      : {};
    if (item.type !== 'command_execution') return;
    const id = commandId(item, event);
    if (!id) return;
    if (type === 'item.started') {
      this.active.set(id, {
        id,
        ...(commandText(item) ? { command: commandText(item) } : {}),
        startedAt: this.now(),
      });
    } else {
      if (this.active.delete(id)) this.completedCount++;
    }
    this.persist();
  }

  private now(): string {
    return this.input.now?.() ?? new Date().toISOString();
  }

  private persist(): void {
    const snapshot: CommandActivitySnapshot = {
      version: 1,
      stageId: this.input.stageId,
      attemptIndex: this.input.attemptIndex,
      attemptStartedAt: this.input.attemptStartedAt,
      updatedAt: this.now(),
      active: [...this.active.values()],
      completedCount: this.completedCount,
      streamClosed: this.streamClosed,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    renameSync(temp, this.path);
  }
}

