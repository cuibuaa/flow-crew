export type GenericPathLexemeDecision =
  | { kind: 'path' }
  | { kind: 'text'; reason: 'regex_escape' | 'normalized_regex_escape' | 'acronym_pair' };

export type GenericPathLexemeContext = 'literal' | 'prose';

/**
 * Classify tokens only at heuristic prose/generic-literal boundaries. Explicit
 * command operands and authored path fields have stronger grammar and must not
 * use this filter.
 */
export function classifyGenericPathLexeme(
  value: string,
  context: GenericPathLexemeContext = 'literal',
): GenericPathLexemeDecision {
  const token = value.trim();
  if (/\\[./^$*+?()[\]{}|\\]/.test(token)) {
    return { kind: 'text', reason: 'regex_escape' };
  }
  // Old extraction converted regex escapes (`input\.md`) into separators
  // (`input/.md`). The latter can also appear in prose that quotes the old
  // diagnostic, so retain the lexical signature: a known file suffix cannot
  // by itself be the final hidden-file segment of a generic project path.
  if (context === 'prose' && /\/\.(?:md|json|ya?ml|toml|txt|csv|ts|tsx|js|jsx|mjs|cjs|py|sh|html|xml)$/i.test(token)) {
    return { kind: 'text', reason: 'normalized_regex_escape' };
  }
  if (context === 'prose' && /^[A-Z][A-Z0-9_-]+(?:\/[A-Z][A-Z0-9_-]+)+$/.test(token)) {
    return { kind: 'text', reason: 'acronym_pair' };
  }
  return { kind: 'path' };
}

export function isGenericPathLexeme(
  value: string,
  context: GenericPathLexemeContext = 'literal',
): boolean {
  return classifyGenericPathLexeme(value, context).kind === 'path';
}
