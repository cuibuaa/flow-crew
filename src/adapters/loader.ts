import type { Adapter } from './base.js';

const ADAPTER_MODULE_MAP: Record<string, string> = {
  codex: './codex.js',
  claude: './claude.js',
  mock: './mock.js',
};

const adapterCache = new Map<string, Adapter>();

export async function loadAdapterByName(name: string): Promise<Adapter> {
  const key = name || 'codex';
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const modulePath = ADAPTER_MODULE_MAP[key] ?? key;
  const mod = await import(modulePath) as { createAdapter?: () => Adapter };
  if (typeof mod.createAdapter !== 'function') throw new Error(`Adapter module ${modulePath} does not export createAdapter()`);
  const adapter = mod.createAdapter();
  adapterCache.set(key, adapter);
  return adapter;
}
