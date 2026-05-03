/**
 * Computes a fuzzy match score between two strings using normalized Levenshtein distance.
 *
 * Uses the Wagner-Fischer algorithm with single-row DP optimization for O(n*m) time
 * and O(min(n,m)) space. Unicode-safe via {@link Array.from} code point iteration.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns A score in [0, 1] where 1 = exact match and 0 = completely different.
 */
export function fuzzyMatch(a: string, b: string): number {
  const arrA = Array.from(a);
  const arrB = Array.from(b);
  const lenA = arrA.length;
  const lenB = arrB.length;

  if (lenA === 0 && lenB === 0) return 1.0;
  if (lenA === 0 || lenB === 0) return 0.0;

  // Ensure arrA is the shorter array for space optimization
  const [short, long, shortLen, longLen] =
    lenA <= lenB ? [arrA, arrB, lenA, lenB] : [arrB, arrA, lenB, lenA];

  // Single-row DP
  let prev = new Array<number>(shortLen + 1);
  for (let j = 0; j <= shortLen; j++) prev[j] = j;

  for (let i = 1; i <= longLen; i++) {
    const curr = new Array<number>(shortLen + 1);
    curr[0] = i;
    for (let j = 1; j <= shortLen; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    prev = curr;
  }

  const distance = prev[shortLen];
  return 1 - distance / Math.max(lenA, lenB);
}
