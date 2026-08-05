import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

let fcHome: string;
let previousFcHome: string;
let store: typeof import('../src/store.js');
let scheduler: typeof import('../src/scheduler.js');
let ScriptedAdapter: typeof import('../src/adapters/scripted.js').ScriptedAdapter;
const projectDirs: string[] = [];
const PROJECT_ROOT = resolve(import.meta.dirname, '..');

beforeAll(async () => {
  fcHome = mkdtempSync(join(tmpdir(), `flowcrew-terminal-freshness-${randomBytes(4).toString('hex')}-`));
  store = await import('../src/store.js');
  previousFcHome = store.fcGlobalDir();
  store.setFcGlobalDir(fcHome);
  scheduler = await import('../src/scheduler.js');
  ({ ScriptedAdapter } = await import('../src/adapters/scripted.js'));
});

afterAll(() => {
  store.setFcGlobalDir(previousFcHome);
  for (const projectDir of projectDirs) rmSync(projectDir, { recursive: true, force: true });
  rmSync(fcHome, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), `flowcrew-terminal-project-${randomBytes(4).toString('hex')}-`));
  projectDirs.push(dir);
  return dir;
}

function writeOld(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  const old = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(path, old, old);
}

async function run(
  projectDir: string,
  brief: string,
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
) {
  const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config', 'workflows', 'default.yaml'));
  config.defaults.max_iterations = 3;
  config.defaults.timeout_ms = 30_000;
  const adapter = new ScriptedAdapter(script);
  const state = await scheduler.runWorkflow(
    config, raw, projectDir, adapter, new Map(), undefined,
    join(PROJECT_ROOT, 'config', 'agents'), undefined, brief,
    true, false, undefined, false,
  );
  const runDir = join(fcHome, 'runs', state.runId!);
  let guidance = '';
  const live = join(runDir, 'supervisor_guidance.md');
  if (existsSync(live)) guidance += readFileSync(live, 'utf-8');
  const history = join(runDir, 'guidance_history');
  if (existsSync(history)) {
    for (const name of readdirSync(history)) guidance += readFileSync(join(history, name), 'utf-8');
  }
  return { state, guidance, adapter };
}

const dispatch = (id: string) => ({
  runFiles: {
    'dispatch.yaml': `- id: ${id}\n  role: coder\n  prompt_template: do the work\n`,
  },
});

describe('terminal artifact freshness', () => {
  it('rejects an artifact older than run start, records explicit guidance, then accepts the same path after a non-plan stage rewrites it', async () => {
    const projectDir = project();
    const artifact = join(projectDir, 'docs', 'task_summary.md');
    writeOld(artifact, '# stale result from a previous task\n');

    const { state, guidance, adapter } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Freshness fixture
`, {
      plan: dispatch('implement'),
      implement: { projectFiles: { 'docs/task_summary.md': '# fresh result from this run\n' } },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.implement?.status).toBe('complete');
    expect(adapter.calls.some((call) => call.stageId === 'implement')).toBe(true);
    expect(guidance).toContain('docs/task_summary.md exists but predates this run start');
    expect(guidance).not.toContain('早于本次 run 启动');
    expect(statSync(artifact).mtimeMs).toBeGreaterThanOrEqual(Date.parse(state.startedAt));
  }, 60_000);

  it('does not let the plan stage alone turn a freshly written artifact into success', async () => {
    const projectDir = project();
    const { state, guidance, adapter } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Non-plan proof fixture
`, {
      plan: {
        ...dispatch('execute_work'),
        projectFiles: { 'docs/task_summary.md': '# written during planning, not yet earned\n' },
      },
      execute_work: { output: 'real work completed' },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.execute_work?.status).toBe('complete');
    expect(adapter.calls.some((call) => call.stageId === 'execute_work')).toBe(true);
    expect(guidance).toContain('requires at least one non-plan stage to complete during this run');
  }, 60_000);

  it.each([
    { label: 'inferred', stageGlobLine: '', verdictDir: 'docs', verdictName: (i: number) => `stage_${i}_verdict.md` },
    { label: 'configured', stageGlobLine: '    stage_glob: evidence/check_*_verdict.md\n', verdictDir: 'evidence', verdictName: (i: number) => `check_${i}_verdict.md` },
  ])('counts only fresh files for a $label stage_glob floor', async ({ label, stageGlobLine, verdictDir, verdictName }) => {
    const projectDir = project();
    const verdicts: Record<string, string> = {};
    for (let i = 1; i <= 2; i += 1) {
      const relative = `${verdictDir}/${verdictName(i)}`;
      const content = `# Verdict ${i}\n\nThis substantive verdict is longer than forty bytes and belongs to this run.\n`;
      writeOld(join(projectDir, relative), content.replace('this run', 'an older run'));
      verdicts[relative] = content;
    }

    const { state, guidance } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
${stageGlobLine}    floor:
      min_attempted_stages: 2
---
# Glob freshness fixture
`, {
      plan: {
        ...dispatch('refresh_verdicts'),
        projectFiles: { 'docs/task_summary.md': '# terminal artifact written by plan\n' },
      },
      refresh_verdicts: { projectFiles: verdicts },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.refresh_verdicts?.status).toBe('complete');
    expect(guidance).toContain(`${label} stage_glob`);
    expect(guidance).toContain('2 matching file(s) exist but predate this run start');
  }, 60_000);

  it('keeps a legitimate fast terminal reachable when fresh stage evidence satisfies the floor', async () => {
    const projectDir = project();
    const { state, guidance } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
    floor:
      min_attempted_stages: 1
      min_wall_minutes: 999
---
# Bug 7 regression fixture
`, {
      plan: dispatch('deliver'),
      deliver: {
        projectFiles: {
          'docs/task_summary.md': '# legitimate terminal result\n',
          'docs/stage_1_verdict.md': '# Verdict\n\nA real completed-stage verdict that is safely longer than forty bytes.\n',
        },
      },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.deliver?.status).toBe('complete');
    expect(Date.parse(state.completedAt!) - Date.parse(state.startedAt)).toBeLessThan(60_000);
    expect(guidance).not.toContain('wall time');
  }, 60_000);

  it('rejects a stale terminal artifact after a completed non-writing stage', async () => {
    const projectDir = project();
    writeOld(join(projectDir, 'docs', 'task_summary.md'), '# stale result from a previous task\n');

    const { state } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Isolated freshness guard fixture
`, {
      plan: dispatch('implement'),
      implement: { output: 'completed real work without touching the stale artifact' },
    });

    expect(state.stages.implement?.status).toBe('complete');
    expect(state.status).not.toBe('shipped');
  }, 60_000);
});
