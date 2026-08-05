import type { Adapter } from './base.js';
import { resolveAdapterChoice } from './availability.js';

export const AVAILABLE_ADAPTER_NAMES = ['codex', 'claude', 'mock'] as const;

type RegisteredAdapterName = typeof AVAILABLE_ADAPTER_NAMES[number];

const ADAPTER_MODULE_MAP: Record<RegisteredAdapterName, string> = {
  codex: './codex.js',
  claude: './claude.js',
  mock: './mock.js',
};

const adapterCache = new Map<string, Adapter>();

export function normalizeAdapterName(name: string): RegisteredAdapterName {
  const key = name.trim() || 'codex';
  if (!AVAILABLE_ADAPTER_NAMES.includes(key as RegisteredAdapterName)) {
    throw new Error(`Unknown adapter "${key}". Available adapters: ${AVAILABLE_ADAPTER_NAMES.join(', ')}`);
  }
  return key as RegisteredAdapterName;
}

export async function loadAdapterByName(name: string): Promise<Adapter> {
  const requested = name.trim();
  let resolved = requested;
  if (!requested || requested === 'auto' || requested === 'codex' || requested === 'claude') {
    const resolution = resolveAdapterChoice({ configured: requested || 'auto' });
    if (!resolution.ok) throw new Error(resolution.hint);
    resolved = resolution.adapter;
  }
  // `mock` and unknown names intentionally bypass physical probing: mock is an
  // in-process fixture, while normalizeAdapterName owns the unknown-name error.
  const key = normalizeAdapterName(resolved);
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const modulePath = ADAPTER_MODULE_MAP[key];
  const mod = await import(modulePath) as { createAdapter?: () => Adapter };
  if (typeof mod.createAdapter !== 'function') throw new Error(`Adapter module ${modulePath} does not export createAdapter()`);
  const adapter = mod.createAdapter();
  adapterCache.set(key, adapter);
  return adapter;
}
