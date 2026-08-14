import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseChecksFromBrief, runAllChecks } from '../src/reality-gate/index.js';
import {
  createRun,
  enforceRealityGateBeforeTerminal,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import type { CheckContext, CheckDecl } from '../src/reality-gate/types.js';

let projectDir: string;
let taskDir: string;
let previousFcGlobalDir: string;

beforeEach(() => {
  previousFcGlobalDir = fcGlobalDir();
  projectDir = mkdtempSync(join(tmpdir(), `rg-project-${randomBytes(4).toString('hex')}-`));
  taskDir = mkdtempSync(join(tmpdir(), `rg-task-${randomBytes(4).toString('hex')}-`));
  setFcGlobalDir(join(taskDir, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcGlobalDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(taskDir, { recursive: true, force: true });
});

function context(): CheckContext {
  return { projectDir, taskDir };
}

function write(rel: string, body: string) {
  const path = join(projectDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

async function localServer(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = status;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('reality gate check types', () => {
  it('checks http reachability positive and negative cases', async () => {
    const server = await localServer(204);
    try {
      const pass = await runAllChecks([{ name: 'ok', type: 'http-reachability', params: { url: server.url, status: 204 } }], context());
      const fail = await runAllChecks([{ name: 'bad', type: 'http-reachability', params: { url: server.url, status: 200 } }], context());
      expect(pass.pass).toBe(true);
      expect(fail.pass).toBe(false);
      expect(fail.results[0].details).toContain(server.url);
      expect(fail.results[0].details).toMatch(/expected 200|return 200/i);
      expect(fail.results[0].details).toMatch(/fix|check|update/i);
    } finally {
      await server.close();
    }
  });

  it('checks file existence and nonempty positive and negative cases', async () => {
    write('exists.txt', 'x');
    const pass = await runAllChecks([{ name: 'files', type: 'file-exists-nonempty', params: { paths: ['exists.txt'] } }], context());
    const fail = await runAllChecks([{ name: 'files', type: 'file-exists-nonempty', params: { paths: ['missing.txt'] } }], context());
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.results[0].details).toContain('missing.txt');
    expect(fail.results[0].details).toMatch(/create|write|remove/i);
  });

  it('checks JSON schema positive and negative cases', async () => {
    write('data.json', JSON.stringify({ name: 'x', count: 2 }));
    const schema = { type: 'object', required: ['name'], properties: { count: { type: 'number', minimum: 1 } } };
    const pass = await runAllChecks([{ name: 'schema', type: 'json-schema-match', params: { file: 'data.json', schema } }], context());
    const fail = await runAllChecks([{ name: 'schema', type: 'json-schema-match', params: { file: 'data.json', schema: { ...schema, required: ['missing'] } } }], context());
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.results[0].details).toContain('$.missing');
    expect(fail.results[0].details).toMatch(/add|fix|update/i);
  });

  it('accepts every member of a union type and still rejects non-members', async () => {
    // `type: [string, "null"]` is how JSON Schema says "nullable". Before this was
    // supported, the array was truthy so validation ran, but matchesType compared a string
    // against an array and nothing could match — so a nullable field failed for BOTH null
    // and a string, i.e. always. Every reality gate and research-loop result_schema that
    // declared an optional reason field was blocked regardless of its content.
    const schema = { type: 'object', properties: { blocked_reason: { type: ['string', 'null'] } } };
    const run = async (body: object) => {
      write('u.json', JSON.stringify(body));
      return runAllChecks([{ name: 'union', type: 'json-schema-match', params: { file: 'u.json', schema } }], context());
    };
    // Both union members must pass — testing only one would not have caught the old bug.
    expect((await run({ blocked_reason: null })).pass).toBe(true);
    expect((await run({ blocked_reason: 'ran out of data' })).pass).toBe(true);
    // And the union must still reject a type it does not list, or it is not a check.
    const rejected = await run({ blocked_reason: 42 });
    expect(rejected.pass).toBe(false);
    expect(JSON.stringify(rejected)).toContain('string|null');
  });

  it('treats an empty union as no type constraint', async () => {
    write('e.json', JSON.stringify({ anything: 7 }));
    const checks = [{ name: 'empty', type: 'json-schema-match', params: { file: 'e.json', schema: { type: 'object', properties: { anything: { type: [] } } } } }];
    expect((await runAllChecks(checks, context())).pass).toBe(true);
  });

  it('checks variance floor positive and negative cases', async () => {
    write('scores.json', JSON.stringify({ rows: [{ score: 1 }, { score: 2 }, { score: 3 }] }));
    write('flat.json', JSON.stringify({ rows: [{ score: 1 }, { score: 1 }, { score: 1 }] }));
    const pass = await runAllChecks([{ name: 'variance', type: 'variance-floor', params: { file: 'scores.json', field_path: 'rows[*].score', min_stddev: 0.1 } }], context());
    const fail = await runAllChecks([{ name: 'variance', type: 'variance-floor', params: { file: 'flat.json', field_path: 'rows[*].score', min_stddev: 0.1 } }], context());
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.results[0].details).toContain('flat.json');
    expect(fail.results[0].details).toContain('rows[*].score');
    expect(fail.results[0].details).toMatch(/raise|vary|lower|fix/i);
  });

  it('checks static scan positive and negative cases', async () => {
    write('src/a.ts', 'const ok = 1;\n');
    write('src/b.ts', 'const bad = "forbidden";\n');
    const pass = await runAllChecks([{ name: 'scan', type: 'static-ast-scan', params: { glob: 'src/**/*.ts', language: 'ts', forbid_pattern: 'not-present' } }], context());
    const fail = await runAllChecks([{ name: 'scan', type: 'static-ast-scan', params: { glob: 'src/**/*.ts', language: 'ts', forbid_pattern: 'forbidden' } }], context());
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.results[0].details).toMatch(/src\/b\.ts:\d+/);
    expect(fail.results[0].details).toMatch(/remove|narrow|change/i);
  });

  it('checks script exit positive and negative cases', async () => {
    const script = write('check.sh', '#!/usr/bin/env bash\nexit "${1:-0}"\n');
    chmodSync(script, 0o755);
    const pass = await runAllChecks([{ name: 'exec', type: 'exec-script-exit-zero', params: { script: 'check.sh', args: ['0'] } }], context());
    const fail = await runAllChecks([{ name: 'exec', type: 'exec-script-exit-zero', params: { script: 'check.sh', args: ['1'] } }], context());
    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.results[0].details).toContain('check.sh');
    expect(fail.results[0].details).toMatch(/rerun|inspect|fix/i);
  });

  it('keeps both the offending element and repair action in every bounded long failure', async () => {
    const long = 'a'.repeat(170);
    const missingPaths = Array.from({ length: 4 }, (_, index) => `missing-${index}-${long}.txt`);

    const scanPaths = Array.from({ length: 3 }, (_, index) =>
      `src/segment-${index}-${'b'.repeat(120)}/match-${'c'.repeat(120)}.ts`);
    for (const path of scanPaths) write(path, 'const value = "forbidden";\n');

    write('schema-data.json', '{}');
    const requiredKeys = Array.from({ length: 5 }, (_, index) => `missing_${index}_${long}`);

    const variancePath = `data/variance-${'d'.repeat(140)}.json`;
    const varianceField = `rows.${'e'.repeat(155)}`;
    write(variancePath, '{}');

    const server = await localServer(204);
    try {
      const urls = Array.from({ length: 3 }, (_, index) =>
        `${server.url}route-${index}-${'f'.repeat(210)}?access_token=not-a-real-secret`);
      write('urls.json', JSON.stringify({ urls }));

      const cases: Array<{
        label: string;
        check: CheckDecl;
        element: RegExp;
        action: RegExp;
        omitted: boolean;
      }> = [
        {
          label: 'file existence',
          check: { name: 'files', type: 'file-exists-nonempty', params: { paths: missingPaths } },
          element: /missing-0-a+/, action: /Create each missing file/i,
          omitted: true,
        },
        {
          label: 'static scan',
          check: { name: 'scan', type: 'static-ast-scan', params: { glob: 'src\/**/*.ts', language: 'ts', forbid_pattern: 'forbidden' } },
          element: /src\/segment-0-b+/, action: /Remove or change each named match/i,
          omitted: true,
        },
        {
          label: 'JSON schema',
          check: { name: 'schema', type: 'json-schema-match', params: { file: 'schema-data.json', schema: { type: 'object', required: requiredKeys } } },
          element: /\$\.missing_0_a+/, action: /Add or fix the named JSON values/i,
          omitted: true,
        },
        {
          label: 'HTTP reachability',
          check: { name: 'http', type: 'http-reachability', params: { url: { json_file: 'urls.json', from_field: 'urls[*]' }, status: 200 } },
          element: /127\.0\.0\.1/, action: /Check the endpoint, network, and expected status/i,
          omitted: true,
        },
        {
          label: 'variance floor',
          check: { name: 'variance', type: 'variance-floor', params: { file: variancePath, field_path: varianceField, min_stddev: 0.1 } },
          element: /variance-d+/, action: /Add valid observations or fix the file\/field path/i,
          omitted: false,
        },
        {
          label: 'silent script',
          check: {
            name: 'silent',
            type: 'exec-script-exit-zero',
            params: { script: `long_silent_condition="${'g'.repeat(620)}"\ntest "$long_silent_condition" = expected` },
          },
          element: /long_silent_condition/, action: /Rerun the script from the project root/i,
          omitted: true,
        },
      ];

      for (const item of cases) {
        const report = await runAllChecks([item.check], context());
        const details = report.results[0].details;
        expect.soft(report.pass, item.label).toBe(false);
        expect.soft(details.length, `${item.label} length`).toBeLessThanOrEqual(500);
        expect.soft(details, `${item.label} element`).toMatch(item.element);
        expect.soft(details, `${item.label} action`).toMatch(item.action);
        expect.soft(details.includes('[details omitted]'), `${item.label} omission`).toBe(item.omitted);
      }
    } finally {
      await server.close();
    }
  });

  it('says the directory is not a repository instead of blaming the declared path', async () => {
    // projectDir has no .git. `git cat-file` fails for a reason that has
    // nothing to do with the path, so the summary must not assert that the
    // path is absent from HEAD — that would state more than the evidence
    // supports about a file that may well be committed elsewhere.
    writeFileSync(join(projectDir, 'present.txt'), 'exists on disk\n', 'utf-8');
    const outcome = await runAllChecks([{
      name: 'clean-archive',
      type: 'exec-script-exit-zero',
      params: { script: 'git archive HEAD >/dev/null', archive_paths: ['present.txt'] },
    }], context());

    expect(outcome.pass).toBe(false);
    expect(outcome.results[0].details).toContain('not a git repository');
    expect(outcome.results[0].details).not.toContain('is not present in HEAD');
  });

  it('rejects a clean-archive script that omits its committed-input manifest', async () => {
    const report = await runAllChecks([{
      name: 'clean-archive',
      type: 'exec-script-exit-zero',
      params: { script: 'git archive HEAD >/dev/null' },
    }], context());

    expect(report.pass).toBe(false);
    expect(report.results[0].details).toContain('must declare every repository input');
    expect(report.results[0].evidence).toMatchObject({
      stderr: expect.stringContaining('Executor preflight stopped the check'),
    });
  });
});

describe('reality gate parser and aggregation', () => {
  it('extracts YAML declarations from markdown', () => {
    const brief = write('brief.md', [
      '# Task',
      '## Reality checks (declared, framework will enforce before transition to done)',
      '```yaml',
      'checks:',
      '  - name: artifact',
      '    type: file-exists-nonempty',
      '    params:',
      '      paths: ["artifact.txt"]',
      '```',
      '## Next',
      'text',
    ].join('\n'));
    expect(parseChecksFromBrief(brief)).toEqual([{ name: 'artifact', type: 'file-exists-nonempty', params: { paths: ['artifact.txt'] } }]);
  });

  it('preserves only an explicitly boolean advisory declaration and defaults all others to hard', () => {
    const brief = write('severity.md', [
      '## Reality checks',
      'checks:',
      '  - name: advisory',
      '    type: file-exists-nonempty',
      '    advisory: true',
      '    params: { paths: ["a"] }',
      '  - name: default-hard',
      '    type: file-exists-nonempty',
      '    params: { paths: ["b"] }',
      '  - name: string-is-hard',
      '    type: file-exists-nonempty',
      '    advisory: "true"',
      '    params: { paths: ["c"] }',
    ].join('\n'));

    expect(parseChecksFromBrief(brief)).toEqual([
      { name: 'advisory', type: 'file-exists-nonempty', advisory: true, params: { paths: ['a'] } },
      { name: 'default-hard', type: 'file-exists-nonempty', params: { paths: ['b'] } },
      { name: 'string-is-hard', type: 'file-exists-nonempty', params: { paths: ['c'] } },
    ]);
  });

  it('aggregates multiple checks', async () => {
    write('artifact.txt', 'x');
    const decls: CheckDecl[] = [
      { name: 'pass', type: 'file-exists-nonempty', params: { paths: ['artifact.txt'] } },
      { name: 'fail', type: 'file-exists-nonempty', params: { paths: ['missing.txt'] } },
    ];
    const report = await runAllChecks(decls, context());
    expect(report.pass).toBe(false);
    expect(report.results.map((item) => item.pass)).toEqual([true, false]);
  });

  it('makes declaration, unknown-handler, and caught-handler failures actionable', async () => {
    const report = await runAllChecks([
      { kind: 'invalid', name: 'broken declaration', type: '__invalid-reality-check-declaration__', diagnostic: 'Reality check item #1 must have a string type' },
      { name: 'unknown handler', type: 'does-not-exist', params: {} },
      { name: 'missing JSON input', type: 'json-schema-match', params: { file: 'absent.json', schema: { type: 'object' } } },
    ], context());

    expect(report.results[0].details).toMatch(/item #1.*fix|fix.*item #1/i);
    expect(report.results[1].details).toMatch(/does-not-exist.*replace|replace.*does-not-exist/i);
    expect(report.results[2].details).toContain('absent.json');
    expect(report.results[2].details).toMatch(/create|fix|check/i);
  });

  it('tells planners to use portable tools and probe optional non-standard commands', () => {
    const planner = readFileSync(join(process.cwd(), 'config', 'agents', 'planner.yaml'), 'utf-8');

    expect(planner).toContain('MUST be portable');
    expect(planner).toContain('POSIX baseline tools');
    for (const command of ['grep', 'sed', 'awk', 'test', 'node']) {
      expect(planner).toContain(command);
    }
    for (const command of ['rg', 'jq', 'fd', 'yq']) {
      expect(planner).toContain(command);
    }
    expect(planner).toContain('command -v');
    expect(planner).toContain('skipped-check');
    expect(planner).toContain('exit 0 rather than failing the run');
  });
});

describe('store integration', () => {
  it('records a real command-not-found exit 127 as advisory and allows the terminal verdict', async () => {
    const missingCommand = 'flowcrew_e3_tool_that_does_not_exist';
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: unavailable-tool',
      '    type: exec-script-exit-zero',
      '    params:',
      `      script: ${missingCommand}`,
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(true);
    expect(gate.report?.pass).toBe(true);
    expect(gate.report?.results).toContainEqual(expect.objectContaining({
      name: 'unavailable-tool',
      pass: false,
      advisory: true,
      details: expect.stringContaining(missingCommand),
      evidence: expect.objectContaining({
        code: 127,
        missingCommand,
      }),
    }));
    const persisted = JSON.parse(readFileSync(
      join(runDir(projectDir, created.runId), '.reality-gate.json'),
      'utf-8',
    )) as { pass: boolean; results: Array<{ name: string; advisory?: boolean; details: string }> };
    expect(persisted.pass).toBe(true);
    expect(persisted.results).toContainEqual(expect.objectContaining({
      name: 'unavailable-tool',
      advisory: true,
      details: expect.stringContaining(missingCommand),
    }));
    expect(readRunEvents(projectDir, created.runId)).toContainEqual(expect.objectContaining({
      type: 'reality_gate_advisory',
      detail: expect.stringContaining(missingCommand),
    }));
  });

  it('keeps an ordinary exit 1 as a hard failure that blocks the terminal verdict', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: genuine-failure',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: exit 1',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(false);
    expect(gate.report?.results).toContainEqual(expect.objectContaining({
      name: 'genuine-failure',
      pass: false,
    }));
    expect(gate.report?.results[0].advisory).not.toBe(true);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
  });

  it('persists executor-owned diagnostics when a failing script deletes its only logs', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: deleted-log-failure',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: |',
      '        clean_root="$(mktemp -d)"',
      "        trap 'rm -rf \"$clean_root\"' EXIT",
      '        sh -c \'printf failure > "$1/check.log"; exit 1\' _ "$clean_root" >"$clean_root/stdout" 2>"$clean_root/stderr"',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    const diagnostic = readRunState(projectDir, created.runId).realityGate?.results[0];

    expect(diagnostic).toMatchObject({
      name: 'deleted-log-failure',
      pass: false,
      details: expect.stringContaining('Executor diagnostic: the check exited 1'),
      stderr: { tail: '', truncated: false },
    });
    expect(diagnostic?.details).toContain('Script excerpt:');
    expect(diagnostic?.details).toContain('clean_root');
    expect(diagnostic?.details).toMatch(/rerun.*project root/i);
    expect(diagnostic?.details).toMatch(/named diagnostic/i);
  });

  it('persists a named hard-failure reason and structured diagnostics in run.json', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: required-build-proof',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: echo "artifact checksum mismatch" >&2; exit 3',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    const persisted = readRunState(projectDir, created.runId);

    expect(gate.allowed).toBe(false);
    expect(persisted.status).toBe('reality_gate_failed');
    expect(persisted.failureReason).toContain('required-build-proof');
    expect(persisted.failureReason).toContain('script exited 3');
    expect(persisted.realityGate).toMatchObject({
      pass: false,
      checkedAt: expect.any(String),
      checksRun: 1,
      results: [{
        name: 'required-build-proof',
        type: 'exec-script-exit-zero',
        pass: false,
        advisory: false,
        details: expect.stringMatching(/script exited 3.*Rerun.*project root/i),
      }],
    });
  });

  it('stores bounded ANSI-free stdout and stderr tails for a failed check', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: noisy-check',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: |',
      "        printf '\\033[31mstdout-start\\033[0m'",
      "        printf 'x%.0s' {1..5000}",
      "        printf '\\033[32mstdout-tail\\033[0m'",
      "        printf '\\033[33mstderr-start\\033[0m' >&2",
      "        printf 'y%.0s' {1..5000} >&2",
      "        printf '\\033[34mstderr-tail\\033[0m' >&2",
      '        exit 9',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    const result = readRunState(projectDir, created.runId).realityGate?.results[0];

    expect(result?.stdout?.tail).toMatch(/stdout-tail$/);
    expect(result?.stderr?.tail).toMatch(/stderr-tail$/);
    for (const output of [result?.stdout, result?.stderr]) {
      expect(output).toMatchObject({
        sourceChars: expect.any(Number),
        capturedChars: expect.any(Number),
        truncated: true,
      });
      expect(output?.capturedChars).toBe(output?.tail.length);
      expect(output?.sourceChars).toBeGreaterThan(output?.capturedChars ?? 0);
      expect(output?.tail).not.toContain('\u001b');
    }
  });

  it('keeps a bare exit 127 without command-not-found evidence as a hard failure', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: unexplained-127',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: exit 127',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(false);
    expect(gate.report?.results[0]).toMatchObject({
      name: 'unexplained-127',
      pass: false,
    });
    expect(gate.report?.results[0].advisory).not.toBe(true);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
  });

  it('allows an advisory wording check to fail while preserving its severity in the report', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    write('README.md', 'A **logged-in** agent CLI is required. Install and **authenticate** it.\n');
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: authentication-wording',
      '    type: exec-script-exit-zero',
      '    advisory: true',
      '    params:',
      '      script: grep -Eqi "logged in|authenticated" README.md',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(true);
    expect(gate.report?.results).toContainEqual(expect.objectContaining({
      name: 'authentication-wording',
      pass: false,
      advisory: true,
    }));
    const persisted = JSON.parse(readFileSync(
      join(runDir(projectDir, created.runId), '.reality-gate.json'),
      'utf-8',
    )) as { pass: boolean; results: Array<{ name: string; advisory?: boolean }> };
    expect(persisted.pass).toBe(true);
    expect(persisted.results).toContainEqual(expect.objectContaining({
      name: 'authentication-wording',
      advisory: true,
    }));
    expect(readRunEvents(projectDir, created.runId)).toContainEqual(expect.objectContaining({
      type: 'reality_gate_advisory',
      detail: expect.stringContaining('authentication-wording'),
    }));
  });

  it('attaches advisory failure evidence without blocking the terminal state', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: optional-environment-check',
      '    type: exec-script-exit-zero',
      '    advisory: true',
      '    params:',
      '      script: printf "optional tool unavailable" >&2; exit 6',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    writeRunState(projectDir, created.runId, state);
    const persisted = readRunState(projectDir, created.runId);

    expect(gate.allowed).toBe(true);
    expect(gate.state).toBe(state);
    expect(persisted.status).toBe('complete');
    expect(persisted.failureReason).toBeUndefined();
    expect(persisted.realityGate).toMatchObject({
      pass: true,
      checksRun: 1,
      results: [{
        name: 'optional-environment-check',
        type: 'exec-script-exit-zero',
        pass: false,
        advisory: true,
        details: expect.stringMatching(/script exited 6.*Rerun.*project root/i),
        stderr: {
          tail: 'optional tool unavailable',
          truncated: false,
        },
      }],
    });
  });

  it('still blocks when a hard failure appears alongside an advisory failure', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), [
      '## Reality checks',
      'checks:',
      '  - name: optional-wording',
      '    type: file-exists-nonempty',
      '    advisory: true',
      '    params: { paths: ["optional.txt"] }',
      '  - name: required-artifact',
      '    type: file-exists-nonempty',
      '    params: { paths: ["required.txt"] }',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(false);
    expect(gate.report?.pass).toBe(false);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
  });

  it('blocks a terminal transition when declared checks fail', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    writeFileSync(join(runDir(projectDir, created.runId), 'task_brief.md'), [
      '## Reality checks',
      'checks:',
      '  - name: missing',
      '    type: file-exists-nonempty',
      '    params:',
      '      paths: ["missing.txt"]',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    expect(gate.allowed).toBe(false);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
    expect(existsSync(join(runDir(projectDir, created.runId), '.reality-gate.json'))).toBe(true);
  });

  it('allows a terminal transition when declared checks pass', async () => {
    const created = createRun(projectDir, 'test', 'name: test', []);
    write('artifact.txt', 'x');
    writeFileSync(join(runDir(projectDir, created.runId), 'task_brief.md'), [
      '## Reality checks',
      'checks:',
      '  - name: artifact',
      '    type: file-exists-nonempty',
      '    params:',
      '      paths: ["artifact.txt"]',
    ].join('\n'), 'utf-8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    expect(gate.allowed).toBe(true);
    expect(gate.report?.pass).toBe(true);
  });
});
