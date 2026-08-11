import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const ship = readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf-8');
const cliGuide = readFileSync(join(repositoryRoot, 'guide', 'cli.md'), 'utf-8');
const briefGuide = readFileSync(join(repositoryRoot, 'guide', 'brief-contract.md'), 'utf-8');
const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf-8');

function section(markdown: string, start: string, end?: string): string {
  const from = markdown.indexOf(start);
  const to = end ? markdown.indexOf(end, from + start.length) : markdown.length;
  if (from < 0 || to < 0) throw new Error(`Missing section boundary: ${start} -> ${end ?? 'EOF'}`);
  return markdown.slice(from, to);
}

function compact(markdown: string): string {
  return markdown.replaceAll(/\s+/g, ' ').trim();
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
    expect(ship).toContain('`/ship <flag>` in Claude Code or `$ship <flag>` in Codex');
    expect(ship).toContain('git clone https://github.com/cuibuaa/flow-crew.git && cd flow-crew && npm install && npm link');
    expect(hasBalancedMarkdownFences(ship)).toBe(true);
    const lineCount = ship.split(/\r?\n/).length - (ship.endsWith('\n') ? 1 : 0);
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('makes every execution step conditional without relying on heading order', () => {
    const composition = compact(section(ship, '## 1. Compose the handoff', '### 1.1 '));
    const preflight = compact(section(ship, '### 1.1 ', '### 1.2 '));
    const setup = compact(section(ship, '### 1.2 ', '### 1.3 '));
    const draft = compact(section(ship, '### 1.3 ', '### 1.4 '));
    const rehearse = compact(section(ship, '### 1.4 ', '### 1.5 '));
    const confirm = compact(section(ship, '### 1.5 ', '### 1.6 '));
    const quick = compact(section(ship, '### 1.6 ', '### 1.7 '));
    const watch = compact(section(ship, '### 1.7 ', '## 2. '));

    expect(composition).toContain('Before digest-bound confirmation, invoke the FlowCrew executable only with `ship-preflight` or `rehearse`');
    expect(composition).toContain('Treat `--help`, `--version`, capability discovery, and dry probes as invocations');
    expect(composition).toContain('never call `ship-setup`, `quick`, or any other FlowCrew command in this phase');
    for (const localSection of [preflight, setup, draft, rehearse, confirm, quick, watch]) {
      expect(localSection).toContain('Precondition');
    }
    expect(preflight).toContain('before drafting');
    expect(setup).toContain('Do not invoke `ship-setup` for any purpose');
    expect(setup).toContain('not even `--help`, capability inspection, or another probe');
    expect(setup).toContain('until §1.5 records a new confirmation of the unchanged brief digest and launch identity');
    expect(draft).toContain('draft only after preflight');
    expect(rehearse).toContain('only after `docs/task_brief.md` exists');
    expect(rehearse).toContain('exact saved bytes');
    expect(confirm).toContain('only after the brief file exists and successful rehearsal has emitted its exact digest');
    expect(confirm).toContain('human confirms the bytes identified by that digest');
    expect(quick).toContain('only after a new explicit confirmation given against the exact rehearsal digest and unchanged settings');
    expect(quick).toContain('return to saved-brief preflight, rehearsal, digest display, and confirmation');
    expect(quick).toContain('not even `--help`, capability inspection, or another probe');
    expect(watch).toContain('only after a successful launch has returned a `Task #<id> registered` identity');
  });

  it('states what each command proves, how it exits, and what remains outside its coverage', () => {
    const preflight = compact(section(ship, '### 1.1 ', '### 1.2 '));
    const setup = compact(section(ship, '### 1.2 ', '### 1.3 '));
    const rehearse = compact(section(ship, '### 1.4 ', '### 1.5 '));
    const quick = compact(section(ship, '### 1.6 ', '### 1.7 '));
    const watch = compact(section(ship, '### 1.7 ', '## 2. '));

    expect(preflight).toContain('Exit 0 means those facts were gathered; it does not mean they are favorable');
    expect(preflight).toContain('collection failure exit non-zero');
    expect(preflight).toContain('cannot decide what prior state means');
    expect(setup).toContain('Exit 0 and `Ship setup: READY`');
    expect(setup).toContain('non-zero refusal');
    expect(setup).toContain('cannot choose the target identity');
    expect(rehearse).toContain('Rehearsal exit 0 ending in `✅ Contract ready`');
    expect(rehearse).toContain('non-zero means fix the brief or environment');
    expect(rehearse).toContain('does not prove implementation or research quality');
    expect(quick).toContain('zero background exit means registration succeeded, not that the run passed');
    expect(quick).toContain('Any non-zero launch or run exit');
    expect(quick).toContain('does not prove the deliverable');
    expect(watch).toContain('`--once` exits 0');
    expect(watch).toContain('invalid options exit 1');
    expect(watch).toContain('does not write run or task status');
  });

  it('keeps warning consent after rehearsal and before an exact-stdin launch', () => {
    expectInOrder(ship, [
      'flowcrew rehearse docs/task_brief.md',
      'Start this exact brief digest',
      'Wait for a new explicit answer',
      'flowcrew quick --background',
      '- < docs/task_brief.md',
    ]);
    expect(ship).toContain('Do not treat the original `/ship` request or an earlier “ship it” as');
  });

  it('requires explicit input declarations and persistent launch wrap-up bookkeeping', () => {
    const draft = compact(section(ship, '### 1.3 ', '### 1.4 '));
    expect(draft).toContain('leading frontmatter `inputs:` block');
    expect(draft).toContain('A path in prose or a table is only a reference, not a declaration');
    expect(draft).toContain('declare gitignored inputs there');

    const quick = compact(section(ship, '### 1.6 ', '### 1.7 '));
    expectInOrder(quick, [
      'After any successful launch',
      'FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.',
      'After cancellation, update or remove that entry.',
      'After re-shipping, replace its id with the new one.',
    ]);
  });

  it('keeps the moving ownership boundary explicit and under twenty lines', () => {
    const boundary = section(ship, '### 2.5 ', '### 2.6 ');
    expect(boundary.split(/\r?\n/).filter(Boolean).length).toBeLessThan(20);
    const normalized = compact(boundary);
    expect(normalized).toContain("research loop explores within the question in the brief; the operator changes the question");
    expect(normalized).toContain('split is not mechanical work versus judgement');
    expect(normalized).toContain('failure announces itself or returns a plausible value');
    expect(normalized).toContain('The boundary moves');
    expect(normalized).toContain('that failure belongs on the machine side');
  });

  it('retains brief-authoring judgments while assigning mechanical ownership explicitly', () => {
    const normalized = compact(ship);
    for (const bar of [
      'self-contained brief',
      'State the property to prove, not the instrument to use',
      'Mark examples as examples',
      'exact means really is required',
      'boundaries, counter-examples, and unacceptable outcomes',
      'research loops are different',
      'unfixed code',
      'failure *rate* before and after',
      'only copy of something',
      '`method_was_not_adjusted_to_match_expectation`',
      'line count to be non-decreasing',
      'user-visible consequence',
      'per-item contribution, largest share, leave-one-out',
      'smallest number of highest-contributing items whose removal flips the conclusion',
    ]) {
      expect(normalized, bar).toContain(bar);
    }
    expect(normalized).toContain('both result and baseline');
    expect(normalized).toContain('planner owns planner-created stages');
    expect(normalized).toContain('reserve every declared terminal path');
    expect(normalized).toContain('complete writable scope');
    expect(normalized).toContain('Declare `terminal_states` only for an artifact whose appearance should end the entire run');
    expect(normalized).toContain('Omit it for an intermediate or mid-pipeline output');
    expect(normalized).toContain('skip pending verification and repair');
    expect(normalized).toContain('anti-instant-quit guard only');
    expect(normalized).toContain('name substantive evidence files and their writers');
  });

  it('retains independent acceptance, instrument, rendering, and cleanup bars', () => {
    const normalized = compact(ship);
    for (const bar of [
      'Reproduce the failing declaration independently',
      'characterize recurrence',
      "identify the first failure's mechanism",
      'assess residual uncertainty',
      'something plausible, verify it a second way',
      'actual rendered, served, or readable artifact',
      'real served path',
      'inspect the deciding code, query, formula, protocol, instrument setting',
      'Archive failed or invalid results unchanged',
      'git -C <mainrepo> worktree remove <path>',
      'Permanent machine-independent tests belong in the tracked specification suite',
      'operating-system temporary root or the run directory',
    ]) {
      expect(normalized, bar).toContain(bar);
    }
  });

  it('contains no private measured case studies', () => {
    expect(ship).not.toMatch(
      /(?:^|\n)\s*(?:>\s*)?(?:Real case|Historical case|Observed|Measured)(?:\s+after|:)/i,
    );
    expect(ship).not.toMatch(/\b(?:case study|measured contrast|measured on the same machine)\b/i);
    expect(ship).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:bps|pp)\b/i);
    expect(ship).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:minutes?|hours?|%)?\s*(?:→|->)\s*\d/i);
  });
});

describe('public autonomous launch documentation', () => {
  it('keeps setup/watch and wrap-up surfaces with their refusal/read-only boundaries', () => {
    const normalizedGuide = compact(cliGuide);
    for (const document of [readme, cliGuide, briefGuide]) {
      expect(document).toContain('flowcrew ship-setup');
      expect(document).toContain('flowcrew watch');
    }
    expect(cliGuide).toContain('--brief <path> --target <path> --base <ref> --branch <name>');
    expect(cliGuide).toContain('No ready record is written');
    expect(cliGuide).toContain('does not write run or task status');
    expect(cliGuide).toContain('25 commands');
    expect(cliGuide).toContain('flowcrew land --run <run-id> --remove');
    expect(normalizedGuide).toContain('takes an unfiltered Git census');
    expect(normalizedGuide).toContain('proven build outputs and installed dependencies are summarized by count');
    expect(normalizedGuide).toContain('source, data or state, symlinks, and anything not proven regenerable are named individually');
    expect(normalizedGuide).toContain('symlink is identified as a link and includes its exact target');
    expect(normalizedGuide).toContain('source-like file inside a build directory stays named');
    expect(normalizedGuide).toContain('requires the operator to state the exact count of paths the audit proved regenerable');
    expect(normalizedGuide).toContain('acknowledgement is only consent to discard that measured set');
    expect(normalizedGuide).toContain('cannot cover tracked changes, source, data or state, symlinks, unknown items, inspection failures, or any other ungraded path');
    expect(normalizedGuide).toContain('commit already merged into another local branch is still reported as unpushed but is not at risk');
    expect(normalizedGuide).toContain('any non-terminal status, absent declared artifact, incomplete Git inspection, at-risk commit, or ungraded inventory item is a non-zero refusal');
    expect(normalizedGuide).toContain('exit 127 makes the verdict line `Ship setup: REFUSED`');
    expect(normalizedGuide).toContain('record stores the SHA-256 of the exact brief bytes');
    expect(compact(briefGuide)).toContain('safe bare directory name is accepted there without a trailing slash');
    expect(compact(briefGuide)).toContain('explicit value that is unsafe or cannot be normalized is retained and reported as unresolved');
    expect(normalizedGuide).toContain('terminal artifact unambiguously declares a status different from the persisted lifecycle status');
    expect(normalizedGuide).toContain('terminal and live runs are both covered');
    expect(normalizedGuide).toContain('display that artifact status beside the lifecycle status');
    expect(cliGuide).toContain('flowcrew audit-report --report <path> --run-dir <path>');
    expect(normalizedGuide).toContain('Each claim is `confirmed`, `contradicted`, or `not_checkable`');
    expect(normalizedGuide).toContain('Only a contradiction makes the command exit non-zero');
    expect(normalizedGuide).toContain('does not prove that the chosen measurement or framing was sound');
  });

  it('keeps one-off preservation probes out of the collected specification directory', () => {
    for (const file of [
      'verify-ship-gate.mjs',
      'verify-final-stabilization-gate.mjs',
      'verify-autonomous-ship-qa.mjs',
    ]) {
      expect(existsSync(join(repositoryRoot, 'spec', file)), file).toBe(false);
    }
  });
});
