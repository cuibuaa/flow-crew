import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf-8');
const architecture = readFileSync(join(repositoryRoot, 'guide', 'architecture.md'), 'utf-8');

function withoutFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fence: { character: string; length: number } | undefined;

  for (const line of markdown.split('\n')) {
    if (fence) {
      const closing = new RegExp(
        `^ {0,3}${fence.character}{${fence.length},}\\s*$`,
      );
      if (closing.test(line)) fence = undefined;
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      kept.push('');
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n');
}

function proseBlocks(markdown: string): string[] {
  return withoutFencedCode(markdown)
    .split(/\n[ \t]*\n|\n(?=[*-] )|\n(?=#{1,6} )/)
    .map((block) => block
      .split('\n')
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim())
    .filter(Boolean)
    .filter((block) => !/^[*-] \[[^\]]+\]\([^)]+\)(?::|$)/.test(block));
}

function rehearsalClaims(markdown: string): string[] {
  return proseBlocks(markdown).filter((block) => {
    const namesRehearsal = /\brehears(?:e|es|ed|al|ing)\b/i.test(block);
    const namesZeroExecution = /\bzero[- ]token\b|\bno (?:agent|model)(?: process)?(?: or model)?(?: runs?)?\b|\bno tokens?\b|\bspends? no tokens?\b|\bfor free\b/i.test(block);
    return namesRehearsal && namesZeroExecution;
  });
}

function shipSyntaxExplanations(markdown: string): string[] {
  return proseBlocks(markdown).filter(
    (block) => /\/ship\b/.test(block) && /\$ship\b/.test(block),
  );
}

function independentShippingClaims(markdown: string): string[] {
  return proseBlocks(markdown).filter((block) => {
    const namesIndependentCheck = /\bindependent\b|\bre-?check\b/i.test(block);
    const namesTerminalDecision = /\bshipp?ed\b|\bends? a run successfully\b/i.test(block);
    const namesControl = /\bdecid|\bmay be called\b|\bbefore\b|\bwhat ends\b|\bre-?confirm/i.test(block);
    return namesIndependentCheck && namesTerminalDecision && namesControl;
  });
}

function warningBlock(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '> [!WARNING]');
  if (start < 0) return '';

  const warning: string[] = [];
  for (let index = start; index < lines.length && lines[index].startsWith('>'); index += 1) {
    warning.push(lines[index]);
  }
  return warning.join('\n');
}

describe('G5 stop command in the warning', () => {
  it('keeps flowcrew task cancel inside the contiguous WARNING block', () => {
    const warning = warningBlock(readme);
    expect(warning).toContain('flowcrew task cancel <id>');
  });
});

describe('G6 dashboard launch details', () => {
  it('documents the command, default port, and URL', () => {
    expect(readme).toContain('flowcrew start');
    expect(readme).toMatch(/default port `3000`/);
    expect(readme).toContain('http://localhost:3000/');
  });
});

describe('G7 protected README character', () => {
  it('preserves the anti-pitch verbatim', () => {
    expect(readme).toContain(
      `**You probably don't need FlowCrew** if you want one agent to do one bounded task — use
Codex or Claude Code directly. The gates, supervisor and retry loops only pay for
themselves once the work runs longer than you are willing to sit and watch it.`,
    );
  });

  it('preserves the inert source row verbatim', () => {
    expect(readme).toContain('| `source` | an external reference cited during research | **nothing yet** — it is captured and stored, but no engine path or view reads it back |');
  });

  it('preserves the crew-authority paragraph verbatim', () => {
    expect(readme).toContain(
      `**The same population of models writes the work,
measures the work, and judges the measurement**, so a natural-language opinion that the bar was
met is not independent evidence. What ends a run successfully is the **Reality Gate**: the
checks the work declared for itself, executed as scripts. Only success is gated — a failure
needs no proving. The crew can raise this bar on itself, because the planner may add checks for
constraints it derives from the goal. Nothing in the crew can lower it.`,
    );
  });

  it('preserves the npm-link footgun and which check verbatim', () => {
    expect(readme).toContain('- ⚠️ `npm link` silently repoints an existing global `flowcrew` at this clone, with no warning — check with `which flowcrew`.');
  });

  it('preserves the measured session-reuse line verbatim', () => {
    expect(readme).toContain('session_reuse: false                   # measured benefit was ~9% wall clock; off by default');
  });

  it('preserves the outcome vocabulary verbatim', () => {
    expect(readme).toContain('- **Honest by construction.** "Found nothing" (**ceiling**), "ran out of budget mid-search" (**incomplete**), and "it worked" (**shipped**) are distinct, first-class outcomes — never a crash dressed up as a win, never faked progress.');
  });

  // Pins the CLAIM, not the prose. Verbatim pinning would mean every rewording
  // of this paragraph has to edit a test, which is the documentation churn this
  // suite exists to reduce — and it would not actually protect anything the
  // three assertions below miss. Deleting the calibration still fails.
  it('preserves the macOS calibration', () => {
    expect(readme).toContain('macOS is CI-tested, not daily-driven');
    expect(readme).toMatch(/identity there is strong but not exact|identity on macOS is strong but not exact/);
    expect(readme).toContain('https://github.com/cuibuaa/flow-crew/issues');
  });

  it('preserves the live-run WARNING paragraph verbatim', () => {
    expect(readme).toContain('> **Live runs receive unattended shell access.** The Codex and Claude adapters bypass their normal approval, permission, and sandbox prompts. Starting a live run — from the `ship` skill, from the Dashboard, or with `flowcrew quick` — can therefore give an agent full shell access to the selected project for hours. Use a dedicated workspace or suitably isolated Linux container, and review the task before launch.');
  });

  it.each([
    ['node:sqlite', readme],
    ['ps -o lstart=', architecture],
    ['0.815', readme],
  ])('preserves the concrete marker %s', (marker, document) => {
    expect(document).toContain(marker);
  });
});
