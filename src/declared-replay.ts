import { z } from 'zod';

/** Historical replay declarations are data only; the engine never runs them. */
export const DeclaredReplaySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  runner: z.enum(['node_test', 'vitest', 'pytest']),
  targets: z.array(z.string()).min(1).max(8),
  argv: z.array(z.string().min(1).max(256)).max(4),
  expected: z.object({
    exit_code: z.number().int().min(0).max(255),
    failures: z.array(z.object({ artifact: z.string(), test: z.string().min(1).max(1024) }).strict()).max(128),
  }).strict(),
  timeout_ms: z.number().int().positive().max(2_147_483_647).optional(),
}).strict().superRefine((replay, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  if (new Set(replay.targets).size !== replay.targets.length) issue(['targets'], 'declare each target artifact ID once');
  if ((replay.expected.exit_code === 0) !== (replay.expected.failures.length === 0)) {
    issue(['expected'], 'exit_code 0 requires failures: []; a nonzero reproduction requires exact failing test identities');
  }
  const failures = new Set<string>();
  for (const [index, failure] of replay.expected.failures.entries()) {
    if (!replay.targets.includes(failure.artifact)) issue(['expected', 'failures', index, 'artifact'], 'must name one of targets');
    const key = JSON.stringify(failure);
    if (failures.has(key)) issue(['expected', 'failures', index], 'declare each failing test identity once');
    failures.add(key);
  }
  const args = replay.argv;
  if (replay.runner === 'pytest') {
    for (let i = 0; i < args.length; i++) {
      if (['-q', '-qq', '-v', '--quiet', '--verbose'].includes(args[i])) continue;
      if (args[i] === '-p' && args[i + 1] === 'no:cacheprovider') { i++; continue; }
      issue(['argv', i], 'pytest argv accepts only verbosity and -p no:cacheprovider; declare test files in targets');
    }
  } else if (args.length) {
    const option = replay.runner === 'node_test' ? '--test-name-pattern' : '--testNamePattern';
    if (args.length !== 2 || (args[0] !== option && !(replay.runner === 'vitest' && args[0] === '-t'))) {
      issue(['argv'], `argv accepts only [${JSON.stringify(option)}, "pattern"]; declare test files in targets`);
    }
  }
});
export type DeclaredReplay = z.infer<typeof DeclaredReplaySchema>;

