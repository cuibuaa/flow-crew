import { isAbsolute, relative } from 'node:path';
import { isSessionUuid } from '../adapter-session.js';

type RecordValue = Record<string, any>; // Native CLI envelopes are untrusted, heterogeneous JSON.
export interface NativeEvent {
  sessionId?: string;
  model?: string;
  message?: string;
  delta?: string;
  terminal?: boolean;
  diagnostic?: string;
  commands: Array<{ phase: 'started' | 'completed'; id: string; command?: string }>;
  tools: Array<{ id: string; name: string; path?: string }>;
  results: Array<{ id: string; success: boolean }>;
  writes: string[];
}

export function nativeDiagnostic(event: RecordValue): string | undefined {
  const primary = [event.message, typeof event.error === 'string' ? event.error : event.error?.message, event.item?.message]
    .find(value => typeof value === 'string');
  if (primary !== undefined) return primary.trim() || undefined;
  const errors = Array.isArray(event.errors) ? event.errors.map((error: any) => typeof error === 'string' ? error : error?.message) : [];
  const diagnostic = errors.filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n');
  return diagnostic || (event.type === 'result' && typeof event.result === 'string' ? event.result.trim() || undefined : undefined);
}

export function normalizeReportedWrite(path: string, workDir?: string): string | undefined {
  let candidate = path.replace(/\\/g, '/');
  if (isAbsolute(candidate)) {
    if (!workDir) return undefined;
    candidate = relative(workDir, candidate).replace(/\\/g, '/');
  }
  candidate = candidate.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!candidate || candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) return undefined;
  return candidate;
}

function filePaths(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (['path', 'file_path', 'filePath'].includes(key) && typeof nested === 'string') out.push(nested);
    else if (nested && typeof nested === 'object') filePaths(nested, out);
  }
}

/** Translate native envelopes once, before settlement, lifecycle and presentation. */
export function normalizeNativeEvent(event: RecordValue): NativeEvent {
  const result: NativeEvent = { commands: [], tools: [], results: [], writes: [] };
  const nativeId = event.type === 'thread.started' ? event.thread_id
    : event.type === 'result' || (event.type === 'system' && event.subtype === 'init') ? event.session_id : undefined;
  if (isSessionUuid(nativeId)) result.sessionId = nativeId;
  if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') result.model = event.model;
  const item = event.item;
  if (item?.type === 'agent_message' && typeof item.text === 'string') result.message = item.text.trim();
  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') result.message = event.content.trim();
  if (event.type === 'assistant') {
    if (!event.parent_tool_use_id && typeof event.content === 'string') result.message = event.content;
    if (Array.isArray(event.message?.content)) {
      if (!event.parent_tool_use_id) result.message = event.message.content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('');
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        result.tools.push({ id: block.id, name: String(block.name ?? 'tool'), path: block.input?.file_path ?? block.input?.notebook_path });
        if (/^(?:bash|shell|exec)$/i.test(String(block.name))) result.commands.push({ phase: 'started', id: block.id, command: block.input?.command ?? block.input?.cmd });
      }
    }
  }
  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      result.commands.push({ phase: 'completed', id: block.tool_use_id });
      result.results.push({ id: block.tool_use_id, success: block.is_error !== true });
    }
  }
  if (item?.type === 'command_execution' && (event.type === 'item.started' || event.type === 'item.completed')) {
    const id = [item.id, event.item_id, event.id].find(value => typeof value === 'string' && value.trim());
    if (id) result.commands.push({ phase: event.type === 'item.started' ? 'started' : 'completed', id,
      command: [item.command, item.cmd, item.text].find(value => typeof value === 'string' && value.trim()) });
  }
  const delta = event.type === 'stream_event' ? event.event : event;
  if (delta?.type === 'content_block_delta' && typeof delta.delta?.text === 'string' && !event.parent_tool_use_id) result.delta = delta.delta.text;
  if (event.type === 'result') {
    result.terminal = event.is_error !== true && !(typeof event.subtype === 'string' && event.subtype.startsWith('error'));
    if (result.terminal) {
      if (event.structured_output !== undefined) result.message = JSON.stringify(event.structured_output);
      else if (typeof event.result === 'string') result.message = event.result;
    }
  }
  if (event.type === 'turn.completed') result.terminal = true;
  if (event.type === 'error' || event.type === 'turn.failed' || item?.type === 'error') result.terminal = false;
  if (result.terminal === false) result.diagnostic = nativeDiagnostic(event) ?? (event.type === 'result' && typeof event.subtype === 'string' ? event.subtype : undefined);
  if (item?.type === 'file_change' || event.type === 'file_change') filePaths(item ?? event, result.writes);
  return result;
}

/** One final message and independent failure evidence; tool intent is not a write. */
export class NativeEventSummary {
  message = '';
  diagnostic?: string;
  terminal?: boolean;
  get completed(): boolean { return this.terminal === true; }
  private deltas = '';
  private readonly pendingWrites = new Map<string, string>();
  readonly writes = new Set<string>();

  constructor(private readonly workDir?: string) {}

  observe(event: NativeEvent): void {
    if (event.delta) { this.deltas += event.delta; this.message = this.deltas; }
    if (event.message) { this.message = event.message; this.deltas = ''; }
    if (event.terminal !== undefined) {
      this.terminal = event.terminal;
      if (event.terminal) this.diagnostic = undefined;
      else if (event.diagnostic) this.diagnostic = event.diagnostic;
    }
    for (const tool of event.tools) if (/^(?:write|edit|multiedit|notebookedit)$/i.test(tool.name) && typeof tool.path === 'string') this.pendingWrites.set(tool.id, tool.path);
    for (const result of event.results) {
      const path = this.pendingWrites.get(result.id);
      if (path && result.success) event.writes.push(path);
      this.pendingWrites.delete(result.id);
    }
    for (const path of event.writes) {
      const normalized = normalizeReportedWrite(path, this.workDir);
      if (normalized) this.writes.add(normalized);
    }
  }

  get output(): string { return [this.message, this.diagnostic && this.diagnostic !== this.message ? this.diagnostic : undefined].filter(Boolean).join('\n'); }
}
