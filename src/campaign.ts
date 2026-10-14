import { readFileSync } from 'node:fs';
import type { BriefPatch } from './source_control/brief-patch.js';
import { readHead, bumpVersion, type BriefVersionInfo } from './brief-versioning.js';

function findSection(lines: string[], section: string): { start: number; end: number; level: number } {
  const target = section.trim();
  const start = lines.findIndex((line) => line.trim() === target);
  if (start < 0) throw new Error(`Section not found: ${section}`);
  const match = /^(#{1,6})\s+/.exec(lines[start]);
  if (!match) throw new Error(`Section is not a markdown header: ${section}`);
  const level = match[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const next = /^(#{1,6})\s+/.exec(lines[i]);
    if (next && next[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start, end, level };
}

function replaceSectionRange(content: string, section: string, mutate: (lines: string[], start: number, end: number) => string[]): string {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();
  const { start, end } = findSection(lines, section);
  const nextLines = mutate(lines, start, end);
  return nextLines.join('\n') + (hasTrailingNewline ? '\n' : '');
}

export function applyPatchToText(content: string, patch: BriefPatch): string {
  return replaceSectionRange(content, patch.section, (lines, start, end) => {
    const next = [...lines];
    if (patch.op === 'append') {
      const insert = patch.value.split(/\r?\n/);
      const prefix = end > start + 1 && next[end - 1].trim() !== '' ? [''] : [];
      const suffix = end < next.length && insert[insert.length - 1]?.trim() !== '' ? [''] : [];
      next.splice(end, 0, ...prefix, ...insert, ...suffix);
      return next;
    }

    if (patch.op === 'replace_value') {
      const sectionLines = next.slice(start + 1, end);
      const preferred = sectionLines.findIndex((line) => {
        const trimmed = line.trim();
        return trimmed !== '' && !trimmed.startsWith('#') && (trimmed.includes('[') || trimmed.includes(':') || trimmed.includes('='));
      });
      const fallback = sectionLines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'));
      const localIndex = preferred >= 0 ? preferred : fallback;
      if (localIndex < 0) throw new Error(`No replaceable value found in section: ${patch.section}`);
      next[start + 1 + localIndex] = patch.value;
      return next;
    }

    const arrow = /\s->\s/.exec(patch.value);
    if (!arrow) throw new Error(`Edit patch must use "old -> new": ${patch.value}`);
    const oldValue = patch.value.slice(0, arrow.index);
    const newValue = patch.value.slice(arrow.index + arrow[0].length);
    const sectionText = next.slice(start + 1, end).join('\n');
    if (!sectionText.includes(oldValue)) {
      throw new Error(`Edit target not found in section ${patch.section}: ${oldValue}`);
    }
    const replacement = sectionText.replace(oldValue, newValue).split('\n');
    next.splice(start + 1, end - start - 1, ...replacement);
    return next;
  });
}

export function applyVersionedPatch(
  briefDir: string,
  patch: BriefPatch,
  reason: string,
): BriefVersionInfo {
  const current = readHead(briefDir);
  const newContent = applyPatchToText(readFileSync(current.path, 'utf-8'), patch);
  return bumpVersion(briefDir, newContent, reason);
}

