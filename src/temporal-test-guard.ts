import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

export interface TemporalTestFinding {
  file: string;
  mutablePath: string;
  kind: 'pins_shared_result' | 'depends_on_shared_presence' | 'asserts_terminal_absence';
  reason: string;
}

function projectRelative(projectDir: string, path: string): string {
  return (isAbsolute(path) ? relative(projectDir, path) : path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function looksLikeTest(path: string): boolean {
  return /(?:^|\/)(?:tests?|spec)(?:\/|$)/i.test(path)
    || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path)
    || /(?:^|\/)test_[^/]+\.py$/.test(path)
    || /_test\.py$/.test(path);
}

/** Reject tests whose truth depends on a mutable campaign slot retaining the
 * current round or on terminal artifacts remaining absent. Such tests are
 * guaranteed to be falsified by legitimate future orchestration. */
export function inspectTemporalResearchTests(input: {
  projectDir: string;
  writes: readonly string[];
  resultFile?: string;
  terminalPaths: readonly string[];
}): TemporalTestFinding[] {
  const findings: TemporalTestFinding[] = [];
  const testFiles = [...new Set(input.writes.map((path) => projectRelative(input.projectDir, path)))]
    .filter(looksLikeTest);
  for (const file of testFiles) {
    const absolute = join(input.projectDir, file);
    if (!existsSync(absolute)) continue;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
    } catch { continue; }
    let source: string;
    try { source = readFileSync(absolute, 'utf-8'); } catch { continue; }
    if (input.resultFile) {
      const resultNames = [input.resultFile.replace(/\\/g, '/'), basename(input.resultFile)];
      const namesResult = resultNames.some((candidate) => candidate && source.includes(candidate));
      const pinsLabel = /\blabel\b[\s\S]{0,160}(?:toEqual|toBe|equal|===|==)\s*\(?\s*['"`][^'"`]+['"`]/i.test(source)
        || /(?:toEqual|toBe|equal)\s*\([^)]*\blabel\b/i.test(source);
      if (namesResult && pinsLabel) {
        findings.push({
          file,
          mutablePath: input.resultFile,
          kind: 'pins_shared_result',
          reason: 'test pins the shared latest-round result to a particular label; a later valid round must replace it',
        });
      }
      const sidecar = `${input.resultFile}.no_candidate.json`;
      const namesSidecar = source.includes(sidecar) || source.includes(basename(sidecar));
      const readsOrChecksPresence = /(?:existsSync|readFileSync|readFile|load_json|json\.load|open)\s*\(|\.(?:exists|is_file|isFile)\s*\(/i.test(source);
      if ((namesResult || namesSidecar) && readsOrChecksPresence) {
        findings.push({
          file,
          mutablePath: input.resultFile,
          kind: 'depends_on_shared_presence',
          reason: 'test reads or asserts existence of the mutable latest-round result/sidecar; a later valid round must replace that shared slot',
        });
      }
    }
    for (const terminalPath of input.terminalPaths) {
      const mentions = source.includes(terminalPath) || source.includes(basename(terminalPath));
      const assertsAbsent = /(?:not\.toExist|not\.toBeTruthy|toBe\(false\)|toEqual\(false\)|assert(?:\.ok)?\s*\(\s*!|assert\s+not)[\s\S]{0,200}(?:exists|existence)/i.test(source)
        || /(?:existsSync|exists|is_file|isFile)[\s\S]{0,100}(?:false|not\.)/i.test(source);
      if (mentions && assertsAbsent) {
        findings.push({
          file,
          mutablePath: terminalPath,
          kind: 'asserts_terminal_absence',
          reason: 'test requires a terminal artifact to remain absent; legitimate campaign closure must create it',
        });
      }
    }
  }
  return findings;
}
