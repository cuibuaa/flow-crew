/**
 * One inventory for paths produced by language tooling.  Consumers project
 * the policy they need instead of maintaining unrelated closed lists.
 */
export interface GeneratedPathPolicy {
  directoryName?: string;
  rollbackInventoryExcluded?: boolean;
  liveConstraintCacheAnchor?: boolean;
  liveConstraintPattern?: RegExp;
  contentAddressedMember?: RegExp;
  stableScope?: string;
}

export const GENERATED_PATH_POLICIES: readonly GeneratedPathPolicy[] = [
  { directoryName: '.git', rollbackInventoryExcluded: true },
  { directoryName: '.fc', rollbackInventoryExcluded: true },
  { directoryName: 'node_modules', rollbackInventoryExcluded: true },
  { directoryName: '.cache', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { directoryName: '__pycache__', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { directoryName: '.pytest_cache', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { directoryName: '.mypy_cache', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { directoryName: '.ruff_cache', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { directoryName: '.venv', rollbackInventoryExcluded: true },
  { directoryName: 'venv', rollbackInventoryExcluded: true },
  { directoryName: '.tox', rollbackInventoryExcluded: true },
  { directoryName: '.gradle', rollbackInventoryExcluded: true, liveConstraintCacheAnchor: true },
  { liveConstraintPattern: /\.\*?(?:py[co]|tsbuildinfo)$/i },
  {
    contentAddressedMember: /^node_modules\/\.vite\/vitest\/[0-9a-f]{40}\/.+/,
    stableScope: 'node_modules/.vite/vitest/**',
  },
  {
    contentAddressedMember: /^\.cache\/build-generations\/[0-9a-f]{64}\/.+/,
    stableScope: '.cache/build-generations/**',
  },
];

export const ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES = new Set(
  GENERATED_PATH_POLICIES
    .filter((entry) => entry.rollbackInventoryExcluded && entry.directoryName)
    .map((entry) => entry.directoryName!),
);

export function isRecognizedGeneratedCacheAnchor(segment: string): boolean {
  return GENERATED_PATH_POLICIES.some((entry) => (
    entry.liveConstraintCacheAnchor && entry.directoryName === segment
  ));
}

export function isRecognizedGeneratedCachePath(segments: readonly string[]): boolean {
  if (segments.some(isRecognizedGeneratedCacheAnchor)) return true;
  const path = segments.join('/').replace(/[*?{}[\]]/g, 'x');
  return GENERATED_PATH_POLICIES.some((entry) => {
    const stableRoot = entry.stableScope?.replace(/\/\*\*$/, '');
    return Boolean(stableRoot && (path === stableRoot || path.startsWith(`${stableRoot}/`)));
  });
}

/** Validate an authored exemption through the same capability catalog used by
 * rollback inventory and content-addressed scope projection. */
export function isRecognizedLiveConstraintExemptPattern(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return isRecognizedGeneratedCachePath(segments)
    || GENERATED_PATH_POLICIES.some((entry) => entry.liveConstraintPattern?.test(normalized));
}

export function stableGeneratedScope(path: string): string | undefined {
  return GENERATED_PATH_POLICIES.find((entry) => entry.contentAddressedMember?.test(path))?.stableScope;
}
