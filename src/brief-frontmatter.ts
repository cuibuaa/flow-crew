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
