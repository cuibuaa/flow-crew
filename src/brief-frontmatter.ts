import { parse as parseYaml } from 'yaml';

/** One lexical boundary for the brief's leading YAML block. Semantic readers
 * keep their own schemas; body prose and fenced examples are never metadata. */
export function splitBriefFrontmatter(brief: string): { yaml: string; body: string; bodyLineOffset: number } | undefined {
  const match = /^(?:\uFEFF)?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(brief);
  if (!match) return undefined;
  return {
    yaml: match[1] ?? '',
    body: brief.slice(match[0].length),
    bodyLineOffset: match[0].split(/\r?\n/).length - 1,
  };
}

export interface BriefFrontmatterDocument {
  yaml: string;
  body: string;
  bodyLineOffset: number;
  value?: unknown;
  error?: string;
  errorKind?: 'fence' | 'yaml';
}

/** Decode metadata once with one error contract for all semantic readers. */
export function parseBriefFrontmatterDocument(brief: string): BriefFrontmatterDocument | undefined {
  const frontmatter = splitBriefFrontmatter(brief);
  // A lone opener is Markdown prose. A closing delimiter with trailing text
  // retains the legacy malformed-fence diagnostic for semantic readers.
  if (!frontmatter) return /^(?:\uFEFF)?---\r?\n(?:[\s\S]*?\r?\n)?---[^\r\n]+/.test(brief)
    ? { yaml: '', body: brief, bodyLineOffset: 0, errorKind: 'fence', error: 'frontmatter fence opened with `---` but never closed (no closing `---` line)' }
    : undefined;
  try {
    const value: unknown = parseYaml(frontmatter.yaml);
    return { ...frontmatter, value };
  } catch (error) {
    return { ...frontmatter, errorKind: 'yaml', error: `frontmatter YAML parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
