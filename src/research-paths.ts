import { posix } from 'node:path';

export const DEFAULT_RESEARCH_RESULT_FILE = 'docs/research_round_result.json';

export interface ResearchPathConfig {
  resultFile?: string;
  reportDir?: string;
}

export interface ResolvedResearchPaths {
  resultFile: string;
  reportDir: string;
  manifestFile: string;
}

/** Resolve every project-relative framework research output from one contract. */
export function resolveResearchPaths(config?: ResearchPathConfig): ResolvedResearchPaths {
  const configuredResultFile = config?.resultFile?.trim().replaceAll('\\', '/');
  const configuredReportDir = config?.reportDir?.trim().replaceAll('\\', '/');
  const resultFile = configuredResultFile || DEFAULT_RESEARCH_RESULT_FILE;
  const reportDir = configuredReportDir === undefined || configuredReportDir === ''
    ? posix.dirname(resultFile)
    : configuredReportDir;
  return {
    resultFile,
    reportDir,
    manifestFile: posix.join(reportDir, 'run_manifest.json'),
  };
}
