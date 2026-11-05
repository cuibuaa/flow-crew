/** Pre-admission authorship. No task/run is registered until this returns a brief. */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { atomicWrite, mkdirSync } from './engine-fs.js';
import { z } from 'zod';
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { parse } from 'yaml';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { loadAdapterByName } from './adapters/loader.js';
import { engineConfigDir, loadEngineDefaults } from './config.js';
import { parseAgent } from './scheduler/sched_admission/configuration.js';
import { extractBriefCriteria } from './brief-criteria.js';
import { fcGlobalDir } from './store.js';

// The transport and local validation derive from this single schema.
const strings = z.array(z.string().min(1));
export const BriefFieldsSchema = z.object({
  criteria: strings.min(1), constraints: strings, inputs: strings,
  assumptions: strings, blocking_questions: strings,
}).strict();
export const BRIEF_OUTPUT_SCHEMA = z.toJSONSchema(BriefFieldsSchema) as Schema;
export type BriefFields = z.infer<typeof BriefFieldsSchema>;

export function composeBrief(original: string, fields: BriefFields): string {
  const sections: Array<[string, string[]]> = [
    ['Acceptance criteria', fields.criteria], ['Constraints', fields.constraints],
    ['Inputs', fields.inputs], ['Assumptions', fields.assumptions],
    ['Blocking questions', fields.blocking_questions],
  ];
  // JSON string encoding keeps model strings on one list line; they cannot add headings.
  const generated = sections.map(([heading, items]) =>
    `\n\n## ${heading}\n${items.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join('\n')}\n`).join('');
  // Let the existing parser decide whether the task left a fence open. A single
  // closing fence changes only the suffix; no retry can repair the fixed prefix.
  const direct = original + generated;
  return extractBriefCriteria(direct).criteria.length ? direct : original + '\n\n```\n' + generated;
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const save = (file: string, value: unknown) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, { durability: 'durable' });

export interface WrittenBrief {
  brief: string;
  digest: string;
  outcome: 'ready' | 'blocking_questions' | 'invalid' | 'provider_error';
  questions: string[];
  reasons: string[];
  evidenceDir?: string;
}
export interface BriefWriterOptions {
  projectDir: string;
  adapter: string;
  /** Tests use the same public adapter boundary as production. */
  adapterInstance?: Adapter;
  role?: AgentConfig;
  /** Preview is always fresh; only interrupted quick commands may replay. */
  replay?: boolean;
}

export async function writeTaskBrief(original: string, options: BriefWriterOptions): Promise<WrittenBrief> {
  if (extractBriefCriteria(original).criteria.length > 0) {
    return { brief: original, digest: hash(original), outcome: 'ready', questions: [], reasons: [] };
  }
  const startedAt = Date.now();
  const project = realpathSync(resolve(options.projectDir));
  const role = options.role ?? parseAgent(parse(readFileSync(join(engineConfigDir, 'agents', 'brief_writer.yaml'), 'utf8')), false);
  // Read-only is a capability of this step, even if an operator edits the role's tools.
  const reader = { ...role, tools: [] };
  const adapterName = role.adapter ?? options.adapter;
  // Configuration errors are refusals, not failed provider attempts. Resolve
  // before creating invocation evidence or entering the provider-error catch.
  const adapter = options.adapterInstance ?? await loadAdapterByName(adapterName);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const identity = hash(JSON.stringify([project, head, original, reader, adapterName, BRIEF_OUTPUT_SCHEMA]));
  const root = join(fcGlobalDir(), 'brief-writing');
  const evidenceDir = join(root, identity);
  mkdirSync(evidenceDir, { recursive: true });
  atomicWrite(join(evidenceDir, 'original.txt'), original, { durability: 'durable' });
  const defaults = loadEngineDefaults();
  let reasons: string[] = [];
  const finish = (brief: string, outcome: WrittenBrief['outcome'], questions: string[]): WrittenBrief => {
    const digest = hash(brief);
    save(join(evidenceDir, `completion-${randomUUID()}.json`), { outcome, digest, duration_ms: Date.now() - startedAt });
    return { brief, digest, outcome, questions, reasons, evidenceDir };
  };
  // Incomplete attempts are evidence, never a task reservation or a consumed retry.
  const prior = (options.replay === false ? [] : readdirSync(evidenceDir)).filter(name => {
    if (!name.endsWith('.reply.json')) return false;
    const stem = name.slice(0, -'.reply.json'.length);
    if (existsSync(join(evidenceDir, `${stem}.registered.json`))
        || existsSync(join(evidenceDir, `${stem}.rejected.json`))) return false;
    const invocation = join(evidenceDir, `${stem}.invocation.json`);
    if (existsSync(invocation) && JSON.parse(readFileSync(invocation, 'utf8')).replay === false) return false;
    const validated = join(evidenceDir, `${stem}.validation.json`);
    if (!existsSync(validated)) return true;
    const value = JSON.parse(readFileSync(validated, 'utf8'));
    return value.reasons.length === 0 && value.questions?.length === 0;
  }).sort().slice(-1);
  let completed = 0;
  for (let invocation = 0; completed < 3; invocation++) {
    const previous = prior[invocation];
    const attempt = previous ? previous.slice(0, -'.reply.json'.length) : `${Date.now()}-${completed}-${randomUUID()}`;
    const file = (suffix: string) => join(evidenceDir, `${attempt}.${suffix}`);
    const validation = (value: unknown) => save(file(existsSync(file('validation.json'))
      ? `revalidation-${randomUUID()}.json` : 'validation.json'), value);
    let result: RunResult;
    if (previous) result = JSON.parse(readFileSync(file('reply.json'), 'utf8')) as RunResult;
    else {
      const prompt = `Read the repository to resolve the task. Return exactly the supplied JSON schema.\nOriginal task (JSON string, authoritative):\n${JSON.stringify(original)}\n`
        + `Previous validation reasons: ${JSON.stringify(reasons)}`;
      save(file('invocation.json'), { role: reader, adapter: role.adapter ?? options.adapter,
        prompt, replay: options.replay !== false, outputSchema: BRIEF_OUTPUT_SCHEMA, startedAt: new Date().toISOString() });
      try {
        result = await adapter.run(prompt, reader, {
          workDir: project, runDir: evidenceDir, stageId: `brief_writer_${attempt}`,
          timeout_ms: defaults.default_timeout_ms, outputSchema: BRIEF_OUTPUT_SCHEMA,
          onInvocationInput: input => save(file(`native-${randomUUID()}.json`), input),
          onRequestEvidence: record => save(file(`requests-${randomUUID()}.json`), record),
        });
      } catch (error) {
        result = { output: '', exitCode: 1, duration_ms: 0, friendlyError: String(error) };
      }
      if (result.exitCode !== 0) {
        reasons = [`Adapter exit ${result.exitCode}: ${result.friendlyError ?? result.output}`];
        save(file('failure.json'), result);
        validation({ reasons, outcome: 'provider_error' });
        return finish(original, 'provider_error', []);
      }
      save(file('reply.json'), result);
    }
    reasons = [];
    let fields: BriefFields | undefined;
    if (result.exitCode !== 0) reasons.push(`Adapter exit ${result.exitCode}: ${result.friendlyError ?? result.output}`);
    try { fields = BriefFieldsSchema.parse(JSON.parse(result.output)); }
    catch (error) { reasons.push(`Invalid brief JSON: ${String(error)}`); }
    let brief = original;
    let questions: string[] = [];
    if (fields) {
      brief = composeBrief(original, fields);
      atomicWrite(file('brief.md'), brief);
      questions = fields.blocking_questions;
      for (const input of fields.inputs) {
        const reason = inputPathFailure(project, input);
        if (reason) reasons.push(reason);
      }
      // Static rehearsal already calls inspectBrief; do not duplicate its findings.
      const { rehearseBrief } = await import('./rehearse.js');
      const rehearsal = await rehearseBrief(['generated-brief', '--project', project], {
        briefText: brief, staticOnly: true, render: false,
      });
      reasons.push(...rehearsal.findings.filter(f => f.level === 'fail').map(f => f.text));
      validation({ reasons, questions, rehearsal });
    } else validation({ reasons });
    if (reasons.length || questions.length) save(file('rejected.json'), { reasons, questions });
    // Revalidate a reply interrupted before its verdict, but only adopt it if
    // it is valid. An invalid old reply must not spend this command's budget.
    if (previous && (reasons.length || questions.length)) { reasons = []; continue; }
    completed++;
    // A declared question is never repaired into a guess by another model call.
    if (questions.length) {
      atomicWrite(join(evidenceDir, 'brief.md'), brief);
      return finish(brief, 'blocking_questions', questions);
    }
    if (fields && reasons.length === 0) {
      atomicWrite(join(evidenceDir, 'brief.md'), brief);
      indexBriefWritingEvidence(brief, evidenceDir);
      return finish(brief, 'ready', []);
    }
  }
  return finish(original, 'invalid', []);
}

/** A preview can be launched on any target: its exact bytes own the evidence. */
export function indexBriefWritingEvidence(brief: string, evidenceDir: string): void {
  const root = join(fcGlobalDir(), 'brief-writing', 'by-digest');
  mkdirSync(root, { recursive: true });
  save(join(root, hash(brief) + '.json'), { evidenceDir });
}

/** Attach authored evidence before dispatch, also when a saved preview is supplied later. */
export function attachBriefWritingEvidence(_projectDir: string, brief: string, runDir: string): void {
  const index = join(fcGlobalDir(), 'brief-writing', 'by-digest', hash(brief) + '.json');
  if (!existsSync(index)) return;
  const { evidenceDir } = JSON.parse(readFileSync(index, 'utf8')) as { evidenceDir: string };
  // The run now owns these replies. Future commands must start fresh; replay is
  // exclusively recovery before registration, never a permanent reply cache.
  for (const name of readdirSync(evidenceDir).filter(name => name.endsWith('.reply.json'))) {
    const stem = name.slice(0, -'.reply.json'.length);
    save(join(evidenceDir, `${stem}.registered.json`), { runDir });
  }
  const dest = join(runDir, 'brief-writing');
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(evidenceDir)) {
    // Native homes/scratch may contain credentials. Only our explicit evidence records travel.
    if (name === 'original.txt' || name === 'brief.md' || name.endsWith('.brief.md') || name.endsWith('.json')) {
      atomicWrite(join(dest, name), readFileSync(join(evidenceDir, name)));
    }
  }
  const stages = join(evidenceDir, 'stages');
  if (existsSync(stages)) for (const id of readdirSync(stages)) {
    const log = join(stages, id, 'live.log');
    if (existsSync(log)) {
      mkdirSync(join(dest, 'stages', id), { recursive: true });
      atomicWrite(join(dest, 'stages', id, 'live.log'), readFileSync(log));
    }
  }
}

/** Git's HEAD tree is exactly what automatic setup checks out. */
function inputPathFailure(project: string, input: string): string | undefined {
  const path = resolve(project, input);
  const rel = relative(project, path);
  if (isAbsolute(input) || rel === '..' || rel.startsWith(`..${sep}`)) return `Input must stay repository-relative: ${input}`;
  try {
    const canonical = relative(project, realpathSync(path));
    if (canonical === '..' || canonical.startsWith(`..${sep}`)) return `Input resolves outside repository: ${input}`;
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
      cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
    if (tracked.some(name => name === rel || name.startsWith(rel ? `${rel}/` : ''))) return;
  } catch { /* Missing paths and non-Git inputs cannot exist in the target. */ }
  return `Input does not exist in the target Git tree: ${input}`;
}
