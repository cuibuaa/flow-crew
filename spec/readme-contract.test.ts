import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS } from '../src/lifecycle-status.js';

const repositoryRoot = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf-8');
const readme = read('README.md');
const architecture = read('guide/architecture.md');
const operations = read('guide/operations.md');
const configuration = read('guide/configuration.md');
const onboarding = read('guide/getting-started.md');
const compact = (text: string) => text.replace(/\s+/g, ' ');

function warningBlock(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '> [!WARNING]');
  if (start < 0) return '';
  const warning: string[] = [];
  for (let index = start; index < lines.length && lines[index].startsWith('>'); index += 1) warning.push(lines[index]);
  return warning.join('\n');
}

describe('G5 stop command in the warning', () => {
  it('keeps flowcrew task cancel inside the contiguous WARNING block', () => {
    expect(warningBlock(readme)).toContain('flowcrew task cancel <id>');
    expect(warningBlock(readme)).toContain('inspect settlement');
  });
});

describe('G6 dashboard launch details', () => {
  it('documents the command, configured default port and local URL at canonical homes', () => {
    const cli = read('guide/cli.md');
    expect(cli).toContain('`start`');
    expect(configuration).toContain('`PORT` | Dashboard port, default 3000');
    expect(cli).toContain('http://localhost:<PORT>/');
    expect(read('src/cli.ts')).toContain("process.env.PORT || '3000'");
  });
});

describe('G7 bounded README and canonical reference contract', () => {
  it('orients each audience without an unsupported comparative-benefit promise', () => {
    for (const path of ['guide/getting-started.md', 'guide/operations.md', 'CONTRIBUTING.md', 'AGENTS.md']) expect(readme).toContain(path);
    expect(readme).toContain('A new user');
    expect(readme).toContain('An operator or brief author');
    expect(readme).toContain('A contributor');
    expect(readme).not.toContain('only pay for themselves');
  });

  it('bounds model and deterministic-check authority instead of promising independent truth', () => {
    expect(compact(readme)).toContain("not a guarantee that a model's claims are true");
    expect(compact(readme)).toContain('Checks and their inputs need to express the outcome');
    expect(read('guide/agent-protocol.md')).toContain('independent gates');
    expect(compact(read('guide/brief-contract.md'))).toContain('This limits what a passing Reality Gate proves');
    expect(readme).not.toContain('Nothing in the crew can lower it');
  });

  it('preserves the global-link footgun and command-selection check at onboarding', () => {
    expect(onboarding).toContain('`npm link` changes the global command link');
    expect(onboarding).toContain('`which flowcrew`');
    expect(compact(onboarding)).toContain('Neither operation is necessary for the local commands');
  });

  it('preserves opt-in session reuse and compatible predecessor requirements at configuration', () => {
    expect(configuration).toMatch(/`session_reuse` \| `false` \| Opt into compatible/);
    expect(compact(architecture)).toContain('explicit compatible UUID binding and never grants scope');
  });

  it('documents the complete source-defined outcome vocabulary without universal success promises', () => {
    for (const status of Object.values(RUN_STATUS)) expect(operations, status).toContain('`' + status + '`');
    expect(operations).toContain('not a metric win');
    expect(operations).toContain('Unknown archived status values remain unknown');
    expect(readme).not.toContain('never faked progress');
  });

  it('preserves verifiable macOS CI and weaker process-identity calibration', () => {
    expect(read('.github/workflows/ci.yml')).toContain('runs-on: macos-15');
    expect(onboarding).toContain('macOS');
    expect(compact(architecture)).toContain('second-resolution');
    expect(compact(architecture)).toContain('a weaker identity');
    expect(readme).not.toContain('not daily-driven');
  });

  it('preserves the unattended-shell and host-isolation warning', () => {
    const warning = compact(warningBlock(readme).replace(/^> ?/gm, ''));
    expect(warning).toContain('Live runs receive unattended shell access');
    expect(warning).toContain('bypass modes');
    expect(warning).toContain('not an operating-system sandbox');
    expect(warning).toContain('dedicated workspace');
    expect(warning).toContain('review its evidence');
  });

  it.each([
    ['node:sqlite', onboarding],
    ['ps -o lstart=', architecture],
  ])('preserves the concrete marker %s at its canonical home', (marker, document) => {
    expect(document).toContain(marker);
  });
});
