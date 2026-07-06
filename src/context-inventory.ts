/**
 * Context primitive — the loop's world-model (Atom Architecture / autonomous-loop design).
 *
 * A compact, task-agnostic digest of the data/code assets that already exist on disk under the
 * objective's `context_roots` (default `data/`). Injected into the planner/researcher prompt as
 * {context_inventory} so the Propose step cannot signpost "acquire X" for data already present
 * (the failure observed when a research run mis-recommended buying L2 data it already had).
 *
 * No file parsing (cheap, domain-agnostic) — the agent inspects schemas/contents itself via its
 * own tools. The engine only enumerates what exists.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.fc', 'dist', '.vitest', 'node_modules']);

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}KB`;
  return `${bytes}B`;
}

/**
 * Directory-grouped digest of assets under `roots` (relative to projectDir). Each directory with
 * files emits one line `dir/: f1 (size), f2 (size), … +N more`; directories with many files are
 * summarized rather than enumerated, keeping the digest compact and injectable.
 */
export function summarizeContext(
  projectDir: string,
  roots: string[] = ['data'],
  opts: { perDirFiles?: number; maxLines?: number } = {},
): string {
  const perDirFiles = opts.perDirFiles ?? 10;
  const maxLines = opts.maxLines ?? 120;
  const lines: string[] = [];

  const walk = (absDir: string): void => {
    if (lines.length >= maxLines) return;
    let names: string[];
    try { names = readdirSync(absDir).sort(); } catch { return; }
    const files: { name: string; bytes: number }[] = [];
    const subdirs: string[] = [];
    for (const name of names) {
      if (SKIP.has(name)) continue;
      let st;
      try { st = statSync(join(absDir, name)); } catch { continue; }
      if (st.isDirectory()) subdirs.push(name);
      else files.push({ name, bytes: st.size });
    }
    if (files.length) {
      const shown = files.slice(0, perDirFiles).map((f) => `${f.name} (${fmtBytes(f.bytes)})`);
      const extra = files.length > perDirFiles ? `, … +${files.length - perDirFiles} more` : '';
      lines.push(`${relative(projectDir, absDir) || '.'}/: ${shown.join(', ')}${extra}`);
    }
    for (const sub of subdirs) {
      if (lines.length >= maxLines) break;
      walk(join(absDir, sub));
    }
  };

  for (const root of roots) {
    const abs = join(projectDir, root);
    if (existsSync(abs)) walk(abs);
  }
  return lines.length ? lines.join('\n') : 'none';
}
