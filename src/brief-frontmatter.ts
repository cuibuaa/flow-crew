import { parseDocument, isMap, isSeq, isAlias, isScalar } from 'yaml';

/** One lexical boundary for the brief's leading YAML block. Semantic readers
 * share one closed schema; body prose and fenced examples are never metadata. */
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
  errorPath?: string;
}

/** Decode metadata once with one error contract for all semantic readers. */
export function parseBriefFrontmatterDocument(brief: string): BriefFrontmatterDocument | undefined {
  const frontmatter = splitBriefFrontmatter(brief);
  if (!frontmatter) return /^(?:\uFEFF)?---\r?\n/.test(brief)
    ? { yaml: '', body: brief, bodyLineOffset: 0, errorKind: 'fence', errorPath: '$', error: 'frontmatter fence opened with `---` but never closed (no closing `---` line)' }
    : undefined;
  try {
    const document = parseDocument(frontmatter.yaml, { uniqueKeys: false });
    let errorPath = '$';
    const keyOffsets: Array<{ offset: number; path: string[] }> = [];
    const walk = (node: unknown, path: string[]): void => {
      errorPath = path.join('.') || '$';
      if (isAlias(node)) throw new Error('YAML aliases are not declarations');
      if (isMap(node)) {
        const keys = new Set<string>();
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('mapping keys must be strings');
          const key = pair.key.value;
          if (pair.key.range) keyOffsets.push({ offset: pair.key.range[0], path: [...path, key] });
          errorPath = [...path, key].join('.');
          if (keys.has(key)) throw new Error('duplicate mapping key');
          keys.add(key);
          walk(pair.value, [...path, key]);
        }
      } else if (isSeq(node)) node.items.forEach((item, index) => walk(item, [...path, String(index)]));
    };
    try {
      walk(document.contents, []);
      const problem = document.errors[0] ?? document.warnings[0];
      if (problem) {
        const nearest = keyOffsets.filter(key => key.offset <= problem.pos[0]).sort((a, b) => b.offset - a.offset)[0];
        errorPath = nearest?.path.join('.') ?? '$';
        throw problem;
      }
      return { ...frontmatter, value: document.toJS({ maxAliasCount: 0 }) };
    } catch (error) {
      return { ...frontmatter, errorPath, errorKind: 'yaml', error: `frontmatter YAML parse error at ${errorPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  } catch (error) {
    return { ...frontmatter, errorPath: '$', errorKind: 'yaml', error: `frontmatter YAML parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
