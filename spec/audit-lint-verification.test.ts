import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  inspectRealityChecks,
  type RealityCheckPreflightCode,
} from '../src/reality-check-preflight.js';

interface CheckFixture {
  name: string;
  type: string;
  params: Record<string, unknown>;
  advisory?: boolean;
}

function inspect(brief: string, check: CheckFixture) {
  const markdown = [
    '## Reality checks',
    '```yaml',
    stringify({ checks: [check] }).trimEnd(),
    '```',
  ].join('\n');
  return inspectRealityChecks(brief, markdown).blockingFindings;
}

function codes(brief: string, check: CheckFixture): RealityCheckPreflightCode[] {
  return inspect(brief, check).map((finding) => finding.code);
}

const PRESERVATION_BRIEF = [
  '# Contract',
  'Historical entries in `CHANGELOG.md` containing `legacy/private-area/` must be preserved.',
].join('\n');

describe('audit: Reality-Gate relation lint semantics', () => {
  it('flags byte equality expressed through variables holding two file buffers', () => {
    expect(codes('# Contract\nEvidence content is required.', {
      name: 'archive bytes match report',
      type: 'exec-script-exit-zero',
      params: {
        script: [
          "const fs = require('node:fs');",
          "const report = fs.readFileSync('docs/final.md');",
          "const archive = fs.readFileSync('docs/archive.md');",
          'if (!report.equals(archive)) process.exit(1);',
        ].join(' '),
      },
    })).toContain('copy_byte_equivalence');
  });

  it('flags an exception conflict expressed by a Node literal-presence scan', () => {
    expect(codes(PRESERVATION_BRIEF, {
      name: 'published sources omit the former private area',
      type: 'exec-script-exit-zero',
      params: {
        script: [
          "const fs = require('node:fs');",
          "const text = fs.readFileSync('CHANGELOG.md', 'utf8');",
          "if (text.includes('legacy/private-area/')) process.exit(1);",
        ].join(' '),
      },
    })).toContain('contract_exception_conflict');
  });

  it('accepts a negated search whose failure branch enforces preservation', () => {
    expect(inspect(PRESERVATION_BRIEF, {
      name: 'historical reference remains present',
      type: 'exec-script-exit-zero',
      params: {
        script: "if ! grep -q 'legacy/private-area/' CHANGELOG.md; then exit 1; fi",
      },
    })).toEqual([]);
  });

  it('accepts an exact heading probe when its result cannot affect exit status', () => {
    expect(inspect('# Contract\nValidation evidence must be present.', {
      name: 'optional diagnostic before evidence validation',
      type: 'exec-script-exit-zero',
      params: {
        script: "grep -qx '## Validation' docs/final.md || true",
      },
    })).toEqual([]);
  });

  it('accepts an exact heading when the brief expressly makes that literal the contract', () => {
    const brief = '# Contract\nThe report must use the exact Markdown heading `## Validation`; renaming it violates the contract.';
    expect(inspect(brief, {
      name: 'contracted heading remains exact',
      type: 'exec-script-exit-zero',
      params: { script: "grep -qx '## Validation' docs/final.md" },
    })).toEqual([]);
  });

  it('accepts existence of a file enumerated under a required-files section', () => {
    const brief = ['# Required files', '- `src/widget.ts` — the shipped implementation.'].join('\n');
    expect(inspect(brief, {
      name: 'required implementation exists',
      type: 'file-exists-nonempty',
      params: { paths: ['src/widget.ts'] },
    })).toEqual([]);
  });

  it('does not confuse a revision-range git diff piped to grep with byte equality between copies', () => {
    expect(inspect('# Contract\nThe committed implementation must contain a change from its base revision.', {
      name: 'declared source change is committed',
      type: 'exec-script-exit-zero',
      params: { script: 'git diff --name-only "base"..HEAD -- src/widget.ts | grep -qx src/widget.ts' },
    })).toEqual([]);
  });

  it('refuses a hard command that is mechanically incapable of failing', () => {
    expect(inspect('# Contract\nThe validation command must prove the implementation works.', {
      name: 'validation always passes',
      type: 'exec-script-exit-zero',
      params: { script: 'true' },
    }).length).toBeGreaterThan(0);
  });
});
