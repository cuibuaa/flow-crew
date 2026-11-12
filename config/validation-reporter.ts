import { JsonReporter, type Reporter, type JsonTestResults } from 'vitest/reporters';

type End = Parameters<NonNullable<Reporter['onTestRunEnd']>>;

/** Vitest's JSON omits global errors. Declare completeness from runner facts,
 * and omit incidental per-test metadata to fit the bounded identity report. */
export default class ValidationReporter extends JsonReporter {
  private complete = false;
  async onTestRunEnd(modules: End[0], errors: End[1] = [], reason?: End[2]): Promise<void> {
    this.complete = errors.length === 0 && reason !== 'interrupted';
    await super.onTestRunEnd(modules);
  }
  async writeReport(bytes: string): Promise<void> {
    const report: JsonTestResults = JSON.parse(bytes);
    await super.writeReport(JSON.stringify({ complete: this.complete,
      numTotalTests: report.numTotalTests, numFailedTests: report.numFailedTests, numPassedTests: report.numPassedTests,
      numFailedTestSuites: report.numFailedTestSuites, numPendingTests: report.numPendingTests, numTodoTests: report.numTodoTests, snapshot: { failure: report.snapshot.failure },
      testResults: report.testResults.map(({ name, status, message, assertionResults }) => ({ name, status, message,
        assertionResults: assertionResults.map(({ fullName, status, ancestorTitles }) => ({ status,
          ...(status === 'failed' ? { fullName, ancestorTitles } : {}) })),
      })),
    }));
  }
}
