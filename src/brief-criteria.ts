import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BriefCriterion {
  id: string;
  text: string;
  line: number;
  section: string;
}

export interface BriefCriteriaArtifact {
  version: 1;
  briefDigest: string;
  criteria: BriefCriterion[];
}

const CRITERIA_HEADING = /^(?:requirements?|criteria)\s*:?$|\b(?:acceptance|success|completion|verification|report)\b.{0,40}\b(?:criteria|requirements?|contract|must show|must contain)\b|\bwhat\b.{0,40}\bmust show\b|\bnon-negotiables?\b/i;
const ILLUSTRATIVE_HEADING = /\b(?:for example|e\.g\.|illustrative|example only|not (?:a )?criteri(?:on|a))\b/i;
const ILLUSTRATIVE_ONLY = /^(?:for example|e\.g\.|example(?: only)?|illustration)\b|\b(?:examples? (?:are|is) illustrative|not (?:a )?criteri(?:on|a))\b/i;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (normalized || 'criteria').slice(0, 24);
}

function bodyStartLine(brief: string): number {
  if (!brief.startsWith('---\n') && !brief.startsWith('---\r\n')) return 1;
  const close = /\r?\n---(?:\r?\n|$)/g;
  close.lastIndex = brief.indexOf('\n') + 1;
  const match = close.exec(brief);
  return match ? brief.slice(0, (match.index ?? 0) + match[0].length).split(/\r?\n/).length : 1;
}

/**
 * Extract only structurally numbered/named criteria under an explicit contract
 * heading. Ordinary numbered narrative and parenthetical examples stay prose.
 */
export function extractBriefCriteria(brief: string): BriefCriteriaArtifact {
  const lines = brief.split(/\r?\n/);
  const firstBodyLine = bodyStartLine(brief);
  const criteria: BriefCriterion[] = [];
  let section: { title: string; level: number } | undefined;
  let current: { ordinal: string; line: number; text: string; section: string } | undefined;
  let inFence = false;
  const flush = (): void => {
    if (!current) return;
    const text = current.text.replace(/\s+/g, ' ').trim();
    if (text && !ILLUSTRATIVE_ONLY.test(text)) {
      const base = `criterion_${slug(current.section)}_${slug(current.ordinal)}`;
      criteria.push({
        id: `${base}_${digest(text).slice(0, 8)}`,
        text,
        line: current.line,
        section: current.section,
      });
    }
    current = undefined;
  };

  for (let index = Math.max(0, firstBodyLine - 1); index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = heading[2].replace(/[*_`]/g, '').trim();
      if (CRITERIA_HEADING.test(title) && !ILLUSTRATIVE_HEADING.test(title)) {
        section = { title, level };
      } else if (section && level <= section.level) {
        section = undefined;
      }
      continue;
    }
    if (!section) continue;

    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(raw);
    const named = /^\s*[-*+]\s+\*\*([^*]{2,80})\*\*[.:]?\s*(.+)$/.exec(raw);
    if (numbered || named) {
      flush();
      current = {
        ordinal: numbered ? numbered[1] : named![1],
        line: index + 1,
        text: numbered ? numbered[2] : `${named![1]}: ${named![2]}`,
        section: section.title,
      };
      continue;
    }
    if (current && trimmed && !/^[-*+]\s+|^\d+[.)]\s+/.test(trimmed)) {
      current.text += ` ${trimmed}`;
    } else if (!trimmed) {
      flush();
    }
  }
  flush();
  return { version: 1, briefDigest: digest(brief), criteria };
}

export function writeBriefCriteriaArtifact(runDir: string, brief: string): BriefCriteriaArtifact {
  const artifact = extractBriefCriteria(brief);
  writeFileSync(join(runDir, 'brief_criteria.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifact;
}
