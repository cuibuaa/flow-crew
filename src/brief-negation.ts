/**
 * Auxiliary-position prohibitions already supported by brief linting.
 * Keep this deliberately line-scoped: the callers discard only a line that is
 * itself a prohibition, never neighbouring requirements.
 */
const AUXILIARY_NEGATED_REQUIREMENT = /\b(?:do\s+not|does\s+not|don't|must\s+not|shall\s+not|should\s+not|may\s+not|cannot|can't|never|forbid(?:s|den)?|prohibit(?:s|ed)?|exclude(?:s|d)?|omit(?:s|ted)?|without)\b/i;

// Preserve the path extractor's established high-confidence auxiliary forms.
// The broader decision-lint vocabulary above is unsafe as a whole-line path
// filter: “cannot”, “without”, or “don't” often modifies a different clause.
const PATH_MENTION_AUXILIARY_NEGATION = /\b(?:do not|does not|must not|should not|shall not|never)\b/i;

/**
 * A narrow subject-position prohibition. `nothing` alone is not enough: it
 * must govern a location/path phrase, a modal, and a mutation/publication
 * action. This avoids turning positive wording such as “nothing prevents this
 * task from reading … as an input” into a suppression.
 */
const SUBJECT_PATH_MUTATION_PROHIBITION = /\bnothing\s+(?:in|inside|under|within|beneath)\s+(?:the\s+)?(`[^`\r\n]+`|["'][^"'\r\n]+["']|(?:[./A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]*|(?:directory|folder|path|tree)\b(?:\s+(?:at|in|under)\s+(?:`[^`\r\n]+`|["'][^"'\r\n]+["']|(?:[./A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]*))?)\s+(?:may|must|shall|should|can(?:not)?|will)\s+(?:not\s+)?(?:be\s+)?(?:added\s+to\s+(?:version\s+control|git|the\s+(?:repository|published\s+package))|committed|checked\s+in|tracked|published|written|created|modified|changed|edited|moved|renamed|deleted|removed|overwritten)\b(?:\s+at\s+any\s+(?:point|time))?(?:[.!?]|\*\*|__)*\s*$/i;

export function isAuxiliaryNegatedRequirementLine(line: string): boolean {
  return AUXILIARY_NEGATED_REQUIREMENT.test(line);
}

export function isNegatedRequirementLine(line: string): boolean {
  return isAuxiliaryNegatedRequirementLine(line) || SUBJECT_PATH_MUTATION_PROHIBITION.test(line);
}

/** True only when this exact path token is governed by the subject-position prohibition. */
export function isSubjectNegatedPathMention(line: string, start: number, end: number): boolean {
  const match = SUBJECT_PATH_MUTATION_PROHIBITION.exec(line);
  if (!match || match.index === undefined) return false;
  const relativeStart = match[0].indexOf(match[1]);
  const pathStart = match.index + relativeStart;
  const pathEnd = pathStart + match[1].length;
  return start < pathEnd && end > pathStart;
}

/** Decide whether one extracted path token is negated, without hiding sibling tokens. */
export function isNegatedPathMention(line: string, start: number, end: number): boolean {
  return PATH_MENTION_AUXILIARY_NEGATION.test(line)
    || isSubjectNegatedPathMention(line, start, end);
}
