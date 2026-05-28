#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--help') || process.argv.length < 3) {
  console.log('Usage: node scripts/reality-gate/scan-no-op-affordances.ts <glob>');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}

const glob = process.argv[2];
const files = expand(glob);
const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  scan(text, file, /<button\b(?![^>]*(?:onClick|onSubmit|onKeyDown|disabled|type=["']submit["']))[^>]*>/g, 'button has no action').forEach((item) => findings.push(item));
  scan(text, file, /<a\b(?![^>]*(?:href|onClick))[^>]*>/g, 'anchor has no action').forEach((item) => findings.push(item));
}

for (const finding of findings) {
  console.log(`${finding.file}:${finding.line}: ${finding.reason}: ${finding.match}`);
}
process.exit(findings.length === 0 ? 0 : 1);

function scan(text, file, pattern, reason) {
  const out = [];
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index ?? 0).split(/\r?\n/).length;
    out.push({ file, line, reason, match: match[0] });
  }
  return out;
}

function expand(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  const star = normalized.search(/[*{[]/);
  const basePart = star >= 0 ? normalized.slice(0, star) : normalized;
  const baseDir = basePart.includes('/') ? basePart.slice(0, basePart.lastIndexOf('/')) : '.';
  const ext = normalized.match(/\.([A-Za-z0-9]+)$/)?.[1];
  if (!existsSync(baseDir)) return [];
  return walk(baseDir).filter((file) => !ext || file.endsWith(`.${ext}`));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}
