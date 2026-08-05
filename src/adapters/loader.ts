import type { Adapter } from './base.js';

export const AVAILABLE_ADAPTER_NAMES = ['codex', 'claude', 'mock'] as const;

type AdapterName = typeof AVAILABLE_ADAPTER_NAMES[number];

const ADAPTER_MODULE_MAP: Record<AdapterName, string> = {
  codex: './codex.js',
  claude: './claude.js',
  mock: './mock.js',
};

const adapterCache = new Map<string, Adapter>();

export function normalizeAdapterName(name: string): AdapterName {
  const key = name.trim() || 'codex';
  if (!AVAILABLE_ADAPTER_NAMES.includes(key as AdapterName)) {
    throw new Error(`Unknown adapter "${key}". Available adapters: ${AVAILABLE_ADAPTER_NAMES.join(', ')}`);
  }
  return key as AdapterName;
}

export async function loadAdapterByName(name: string): Promise<Adapter> {
  const key = normalizeAdapterName(name);
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const modulePath = ADAPTER_MODULE_MAP[key];
  const mod = await import(modulePath) as { createAdapter?: () => Adapter };
  if (typeof mod.createAdapter !== 'function') throw new Error(`Adapter module ${modulePath} does not export createAdapter()`);
  const adapter = mod.createAdapter();
  adapterCache.set(key, adapter);
  return adapter;
}
