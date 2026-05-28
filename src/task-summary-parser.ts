export type SummaryVerdict = 'PASS' | 'FAIL' | 'ESCALATE';

export interface ParsedSummary {
  valid: boolean;
  verdict?: SummaryVerdict;
  oneLiner?: string;
  full?: string;
  errors: string[];
}

const REQUIRED_SECTIONS = [
  'What was achieved',
  'Key numbers',
  'Files produced',
  'What operator should do next',
] as const;

type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

export function parseTaskSummary(markdown: string): ParsedSummary {
  const errors: string[] = [];
  const full = markdown;
  const verdict = parseVerdict(markdown, errors);
  const sections = parseSections(markdown);

  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section)) errors.push(`missing section: ${section}`);
  }

  const achieved = sections.get('What was achieved') ?? '';
  const oneLiner = firstParagraph(achieved);
  if (sections.has('What was achieved') && oneLiner.length === 0) {
    errors.push('empty section: What was achieved');
  }

  validateBulletSection('Key numbers', sections, errors);
  validateBulletSection('Files produced', sections, errors);

  const next = sections.get('What operator should do next') ?? '';
  if (sections.has('What operator should do next') && next.trim().length === 0) {
    errors.push('empty section: What operator should do next');
  }

  if (errors.length > 0) return { valid: false, verdict, oneLiner: oneLiner || undefined, full, errors };
  return { valid: true, verdict, oneLiner: truncate(oneLiner, 200), full, errors };
}

function parseVerdict(markdown: string, errors: string[]): SummaryVerdict | undefined {
  const verdictLine = markdown.split(/\r?\n/).find((line) => /^\s*\*\*Verdict\*\*:\s*/.test(line));
  if (!verdictLine) {
    errors.push('missing verdict line');
    return undefined;
  }

  const match = verdictLine.match(/^\s*\*\*Verdict\*\*:\s*(\S+)\s*$/);
  const raw = match?.[1];
  if (raw === 'PASS' || raw === 'FAIL' || raw === 'ESCALATE') return raw;
  errors.push(`invalid verdict: ${raw ?? verdictLine.replace(/^\s*\*\*Verdict\*\*:\s*/, '').trim()}`);
  return undefined;
}

function parseSections(markdown: string): Map<RequiredSection, string> {
  const sections = new Map<RequiredSection, string>();
  let current: RequiredSection | undefined;
  const buffer: string[] = [];

  const flush = (): void => {
    if (current) sections.set(current, buffer.join('\n').trim());
    buffer.length = 0;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const title = heading[1] as RequiredSection;
      current = REQUIRED_SECTIONS.includes(title) ? title : undefined;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  return sections;
}

function firstParagraph(section: string): string {
  const paragraphs = section
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return truncate(paragraphs[0] ?? '', 200);
}

function validateBulletSection(section: RequiredSection, sections: Map<RequiredSection, string>, errors: string[]): void {
  if (!sections.has(section)) return;
  const content = sections.get(section) ?? '';
  if (content.trim().length === 0) {
    errors.push(`empty section: ${section}`);
    return;
  }
  const bullets = content.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S+/.test(line));
  if (bullets.length < 1) errors.push(`section requires at least 1 bullet: ${section}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
