import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf-8');
const ship = read('skills/ship.md');
const cliSource = read('src/cli.ts');
const cliGuide = read('guide/cli.md');
const briefGuide = read('guide/brief-contract.md');
const operations = read('guide/operations.md');
const protocol = read('guide/agent-protocol.md');
const onboarding = read('guide/getting-started.md');
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();

function section(markdown: string, start: string, end?: string): string {
  const from = markdown.indexOf(start);
  const to = end ? markdown.indexOf(end, from + start.length) : markdown.length;
  if (from < 0 || to < 0) throw new Error(`Missing section boundary: ${start} -> ${end ?? 'EOF'}`);
  return markdown.slice(from, to);
}
function expectInOrder(source: string, fragments: readonly string[]): void {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor);
    expect(next, `Missing or out of order: ${fragment}`).toBeGreaterThanOrEqual(cursor);
    cursor = next + fragment.length;
  }
}
function hasBalancedMarkdownFences(markdown: string): boolean {
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) fence = marker[0];
    else if (marker && marker[0] === fence) fence = undefined;
  }
  return fence === undefined;
}

describe('ship skill semantic contract', () => {
  it('remains an installable skill with valid invocation guidance and Markdown', () => {
    expect(ship).toMatch(/^---\nname: ship\ndescription: .+\n---\n/);
    expect(ship).toMatch(/<!-- flowcrew-skill-revision: \d+ -->/);
    expect(ship).toContain('`/ship` in Claude Code or `$ship` in Codex');
    expect(ship).toContain('../guide/brief-contract.md');
    expect(onboarding).toContain('git clone https://github.com/cuibuaa/flow-crew.git');
    expect(onboarding).toContain('npm ci --ignore-scripts');
    expect(onboarding).toContain('npm ci --ignore-scripts --prefix ui');
    expect(hasBalancedMarkdownFences(ship)).toBe(true);
  });

  it('makes every execution step conditional without relying on heading order', () => {
    const compose = compact(section(ship, '## Gather facts', '## Rehearse'));
    const rehearse = compact(section(ship, '## Rehearse', '## Set up'));
    const setup = compact(section(ship, '### Prepare the target', '### Register or run'));
    const quick = compact(section(ship, '### Register or run', '### Observe'));
    const watch = compact(section(ship, '### Observe', '## Ownership'));
    for (const block of [compose, rehearse, setup, quick, watch]) expect(block).toContain('Precondition');
    expect(compose).toContain('before drafting');
    expect(compose).toContain('invoke FlowCrew only for preflight and rehearsal');
    expect(compose).toContain('Treat `--help`, `--version`, capability discovery and dry probes as invocations');
    expect(rehearse).toContain('`docs/task_brief.md` exists');
    expect(rehearse).toContain('exact saved bytes');
    expect(setup).toContain('confirmed the unchanged exact digest and launch identity');
    expect(setup).toContain('Do not invoke `ship-setup` for any purpose, including help or probes');
    expect(quick).toContain('exact-digest confirmation and successful setup remain valid');
    expect(quick).toContain('Do not invoke `quick`, even for help or a probe');
    expect(quick).toContain('requires returning to confirmation');
    expect(watch).toContain('successful background registration returned an exact task identity');
  });

  it('states what each command proves, how it exits, and what remains outside its coverage', () => {
    const normalized = compact(ship);
    for (const bar of ['facts were gathered, not that they are favorable', 'collection failure exits nonzero', 'cannot decide what prior state means', 'Setup cannot choose the target identity', 'exit zero and `Ship setup: READY`', 'nonzero is a refusal', 'Exit zero ending in `✅ Contract ready`', 'not implementation or research quality', 'Nonzero means correct the brief/environment', 'zero background exit means registration succeeded', 'not that the run passed', 'nonzero launch/run exit needs diagnosis', 'neither proves the deliverable', '`--once` exits 0, invalid options exit 1', 'does not write run or task status']) expect(normalized, bar).toContain(bar);
  });

  it('keeps launch confirmation after rehearsal and before an exact-stdin launch', () => {
    expectInOrder(ship, ['flowcrew rehearse docs/task_brief.md', 'Start this exact brief digest', 'Wait for a new explicit answer', 'flowcrew quick --background', '- < docs/task_brief.md']);
    expect(ship).toContain('Do not treat the original `/ship` request or an earlier “ship it” as');
  });

  it('requires explicit input declarations and persistent launch wrap-up bookkeeping', () => {
    const draft = compact(section(ship, '## Gather facts', '## Rehearse'));
    expect(draft).toContain('leading frontmatter `inputs:` block');
    expect(draft).toContain('A path in prose or a table is only a reference, not a declaration');
    expect(draft).toContain('Declare gitignored inputs');
    const quick = compact(section(ship, '### Register or run', '### Observe'));
    expectInOrder(quick, ['record this wrap-up obligation', 'FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.', 'After cancellation, update or remove that entry.', 'After re-shipping, replace its id with the new one.']);
  });

  it('keeps the moving ownership boundary explicit', () => {
    const boundary = compact(section(ship, '## Ownership', '## Human wrap-up'));
    for (const bar of ['research loop within the question in the brief', 'operator changes the question', 'not mechanical work versus judgement', 'failure announces itself or returns a plausible value', 'mechanical check when possible', 'boundary moves']) expect(boundary).toContain(bar);
  });

  it('retains brief-authoring judgments while assigning mechanical ownership explicitly', () => {
    const normalized = compact(ship);
    for (const bar of ['self-contained brief', 'required observable properties', 'label example mechanisms explicitly', 'Map writable paths', 'Explain evidence gaps', 'within_expected_range', 'method_was_not_adjusted_to_match_expectation']) expect(normalized).toContain(bar);
    const policy = compact(briefGuide);
    for (const bar of ['mean, median', 'position in its own distribution', 'numeric feasibility floor', 'user-visible consequence', 'counter-examples', 'unacceptable outcomes', 'authoritative exact mechanism', 'unfixed reproducer', 'failure rate with its denominator', 'line-count check', 'per-item, largest-share', 'leave-one-out']) expect(policy, bar).toContain(bar);
    expect(protocol).toContain('active required outputs');
    expect(briefGuide).toContain('terminal_states');
    expect(briefGuide).toContain('Intermediate reports belong in outputs');
  });

  it('retains independent acceptance, instrument, rendering, and cleanup bars', () => {
    const normalized = compact(ship);
    for (const bar of ['second way to verify plausible results', 'actual rendered/served artifacts', 'deciding code, query, formula or instrument', 'Reproduce a claimed defect independently', 'characterize recurrence and its first mechanism', 'assess residual uncertainty', 'Archive failed or invalid results unchanged', 'only copy of unique work', 'tracked specification suite expresses intended behavior', 'invocation\'s private temporary root or declared run files', 'flowcrew land --run <run-id>', '--complete-fc-task <entry-id> --fc-task-session <session-id>']) expect(normalized, bar).toContain(bar);
  });

  it('carries retained closure identity through accepted wrap-up without terminal auto-close', () => {
    const wrapUp = compact(section(ship, '## Human wrap-up'));
    expectInOrder(wrapUp, ['independent verification/archival are complete', 'flowcrew land --run <run-id>', '--complete-fc-task <entry-id> --fc-task-session <session-id>', 'Closure occurs only after worktree removal, prune and non-force branch deletion all succeed']);
    expect(wrapUp).toContain('omit the closure identity and leave the entry open');
    expect(wrapUp).toContain('not an automatic reaction to terminal status');
  });

  it('resolves every section cross-reference it makes', () => {
    const references = [...ship.matchAll(/\]\(([^)]+)#([a-z0-9-]+)\)/g)];
    expect(references.length).toBeGreaterThan(0);
    for (const [, file, anchor] of references) {
      const target = resolve(repositoryRoot, 'skills', file);
      expect(target.startsWith(repositoryRoot + '/')).toBe(true);
      const text = readFileSync(target, 'utf8');
      const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-'));
      expect(headings, `${file}#${anchor}`).toContain(anchor);
    }
  });

  it('carries a revision stamp that moves when the guidance moves', () => {
    const stamp = /<!-- flowcrew-skill-revision: (\d+) -->/.exec(ship)?.[1];
    expect(stamp).toBeDefined();
    const body = ship.slice(ship.indexOf('-->') + 3);
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
    expect({ revision: stamp, digest }).toEqual({ revision: '29', digest: '3a953a50d501' });
  });

  it('contains no private measured case studies', () => {
    expect(ship).not.toMatch(/(?:^|\n)\s*(?:>\s*)?(?:Real case|Historical case|Observed|Measured)(?:\s+after|:)/i);
    expect(ship).not.toMatch(/\b(?:case study|measured contrast|measured on the same machine)\b/i);
    expect(ship).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:bps|pp)\b/i);
    expect(ship).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:minutes?|hours?|%)?\s*(?:→|->)\s*\d/i);
  });
});

describe('public autonomous launch documentation', () => {
  it('keeps setup/watch and wrap-up surfaces with their refusal/read-only boundaries', () => {
    const normalized = compact(operations);
    for (const command of ['ship-setup', 'watch', 'land']) expect(cliGuide).toContain(command);
    expect(ship).toContain('flowcrew ship-setup');
    expect(ship).toContain('flowcrew watch');
    const setup = cliGuide.split('\n').find(line => line.startsWith('| `ship-setup` |'));
    expect(setup).toBeDefined();
    for (const option of ['--brief', '--target', '--base', '--branch']) expect(setup).toContain('`' + option + '`');
    expect(normalized.toLowerCase()).toContain('target-owned');
    expect(normalized).toContain('Exit 127 is not universally a refusal');
    expect(normalized).toContain('untracked and ignored paths');
    expect(normalized).toContain('proven regenerable outputs are counted');
    expect(normalized).toContain('symlink items are named');
    expect(normalized).toContain('exact `--acknowledge-regenerable` count');
    expect(normalized).toContain('when regenerable paths exist');
    expect(normalized).toContain('nonterminal runs, incomplete inspection and unique ungraded ignored content');
    expect(normalized).toContain('non-force removal/prune/branch deletion');
    expect(normalized).toContain('leaves the entry unchanged until all Git steps succeed');
    expect(normalized).toContain('Omission leaves it open');
    const commands = new Set([...cliSource.matchAll(/^\s+case '([a-z][a-z-]*)':/gm)].map((m) => m[1]));
    expect(commands.size).toBeGreaterThan(20);
    for (const command of commands) expect(cliGuide, command).toContain(command);
    for (const command of ['fc_tasks', 'state', 'plan-check']) expect(cliGuide).toContain(command);
    expect(compact(briefGuide)).toContain('without a trailing slash');
    expect(compact(briefGuide)).toContain('unsafe declarations are reported unresolved');
  });

  it('keeps one-off preservation probes out of the collected specification directory', () => {
    for (const file of ['verify-ship-gate.mjs', 'verify-final-stabilization-gate.mjs', 'verify-autonomous-ship-qa.mjs']) expect(existsSync(join(repositoryRoot, 'spec', file)), file).toBe(false);
  });
});
