import { atomicWrite, mkdirSync } from './engine-fs.js';


import { dirname, join } from 'node:path';
import { normalizeNativeEvent } from './adapters/native-events.js';
import type { CommandContext, CommandLifecycleEvent } from './adapters/base.js';
import { processGroupWork } from './process-liveness.js';

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
  invocationIndex?: number;
  updatedAt: string;
  active: CommandActivityRecord[];
  completedCount: number;
  streamClosed: boolean;
  process?: { pid: number; startTimeTicks: string; kind: 'command' | 'provider' };
}

/** Native command progress parser; flushes trailing events before closure. */
export class CommandActivityTracker {
  private readonly path: string;
  private readonly active = new Map<string, CommandActivityRecord>();
  private carry = '';
  private completedCount = 0;
  private streamClosed = false;
  private readonly startedIds = new Set<string>();
  private readonly completedIds = new Set<string>();
  private process?: CommandActivitySnapshot['process'];

  constructor(private readonly input: {
    runDir: string;
    stageId: string;
    attemptIndex: number;
    attemptStartedAt: string;
    invocationIndex?: number;
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

  bindProcess(pid: number | undefined, kind: 'command' | 'provider'): void {
    const work = pid === undefined ? undefined : processGroupWork(pid);
    if (!work) return;
    this.process = { pid: pid!, startTimeTicks: work.startTimeTicks, kind };
    this.persist();
  }

  close(): void {
    if (this.carry.trim()) this.consumeLine(this.carry);
    this.carry = '';
    this.active.clear();
    this.streamClosed = true;
    this.persist();
  }

  started(id: string, command?: string, context?: CommandContext): void {
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
      ...(command ? { command } : {}), ...(context ? { context } : {}),
    });
  }

  completed(id: string, exitCode?: number, output?: string): void {
    const normalizedId = id.trim();
    if (!normalizedId || this.completedIds.has(normalizedId)) return;
    this.completedIds.add(normalizedId);
    if (!this.active.delete(normalizedId)) return;
    this.completedCount++;
    const timestamp = this.now();
    this.persist();
    this.input.onLifecycle?.({ phase: 'completed', ...(output === undefined ? {} : { output }), id: normalizedId, timestamp,
      ...(exitCode === undefined ? {} : { exitCode }) });
  }

  private consumeLine(line: string): void {
    if (!line.trim().startsWith('{')) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    for (const command of normalizeNativeEvent(event).commands) {
      if (command.phase === 'started') this.started(command.id, command.command, command.context);
      else this.completed(command.id, command.exitCode, command.output);
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
      ...(this.input.invocationIndex === undefined ? {} : { invocationIndex: this.input.invocationIndex }),
      updatedAt: this.now(),
      active: [...this.active.values()],
      completedCount: this.completedCount,
      streamClosed: this.streamClosed,
      ...(this.process ? { process: this.process } : {}),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    // Live progress is superseded on the next tool event; it is not recovery authority.
    atomicWrite(this.path, `${JSON.stringify(snapshot, null, 2)}\n`, { durability: 'replace-only' });
  }
}
