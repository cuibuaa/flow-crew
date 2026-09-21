import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandLifecycleEvent } from './adapters/base.js';

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

export interface ExplicitCommandTimeout {
  timeoutMs: number;
  duration: string;
}

const DURATION = /^(\d+(?:\.\d+)?)([smhd]?)$/i;

/** Conservatively recognize a GNU-style `timeout` command and its explicit
 * duration. Shell expressions and unknown options are intentionally ignored. */
export function parseExplicitCommandTimeout(command: string): ExplicitCommandTimeout | undefined {
  const match = /(?:^|(?:&&|\|\||;)\s*)(?:\/usr\/bin\/|\/bin\/)?timeout(?:\s+|$)([^;&|]*)/.exec(command);
  if (!match) return undefined;
  const tokens = match[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g)?.map((token) => (
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token
  )) ?? [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index++;
      break;
    }
    if (token === '-s' || token === '--signal' || token === '-k' || token === '--kill-after') {
      if (!tokens[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if (/^(?:--signal|--kill-after)=\S+$/.test(token)
      || /^(?:--preserve-status|--foreground|--verbose)$/.test(token)) {
      index++;
      continue;
    }
    if (token.startsWith('-')) return undefined;
    break;
  }
  const duration = tokens[index];
  const parsed = duration ? DURATION.exec(duration) : undefined;
  if (!parsed) return undefined;
  const value = Number(parsed[1]);
  const multiplier = ({ '': 1_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[parsed[2].toLowerCase() as '' | 's' | 'm' | 'h' | 'd'];
  const timeoutMs = value * multiplier;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > Number.MAX_SAFE_INTEGER) return undefined;
  return { timeoutMs: Math.round(timeoutMs), duration };
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
  private readonly startedIds = new Set<string>();
  private readonly completedIds = new Set<string>();

  constructor(private readonly input: {
    runDir: string;
    stageId: string;
    attemptIndex: number;
    attemptStartedAt: string;
    now?: () => string;
    onLifecycle?: (event: CommandLifecycleEvent) => void;
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

  started(id: string, command?: string): void {
    const normalizedId = id.trim();
    if (!normalizedId || this.startedIds.has(normalizedId)) return;
    this.startedIds.add(normalizedId);
    const timestamp = this.now();
    const boundedCommand = command?.trim().slice(0, 500) || undefined;
    this.active.set(normalizedId, {
      id: normalizedId,
      ...(boundedCommand ? { command: boundedCommand } : {}),
      startedAt: timestamp,
    });
    this.persist();
    this.input.onLifecycle?.({
      phase: 'started', id: normalizedId, timestamp,
      ...(boundedCommand ? { command: boundedCommand } : {}),
    });
  }

  completed(id: string): void {
    const normalizedId = id.trim();
    if (!normalizedId || this.completedIds.has(normalizedId)) return;
    this.completedIds.add(normalizedId);
    if (!this.active.delete(normalizedId)) return;
    this.completedCount++;
    const timestamp = this.now();
    this.persist();
    this.input.onLifecycle?.({ phase: 'completed', id: normalizedId, timestamp });
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
      this.started(id, commandText(item));
    } else {
      this.completed(id);
    }
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
