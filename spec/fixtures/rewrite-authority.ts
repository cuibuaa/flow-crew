import { interpretAuthority } from '../../dist-rewrite/exec/policy.js';
import type { ContentScope } from '../../dist-rewrite/records/content.js';
/** Explicit synthetic observations for tests outside setup; real setup observes the filesystem. */
export function fixtureAuthority(scope: Omit<ContentScope, 'authority'>, _devices: readonly string[] = ['/dev/null'], configRoot?: string) {
  const result = interpretAuthority(scope.brief.declaration, { project: scope.layout.project, protectedRoots: [...new Set([...scope.layout.protectedRoots,
   scope.journal.root, ...(configRoot ? [configRoot] : [])])],
    workRoot: scope.layout.location.storeRoot + '/work/' + scope.layout.location.run },
     scope.brief.declaration.outputs.map(output => output.existing === 'create' ? 'absent' : output.kind));
  if (!result.ok)
    throw new Error(result.detail);
  return result.value;
}
