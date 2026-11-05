/** Pre-admission authorship. No task/run is registered until this returns a brief. */
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
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
  return original + sections.map(([heading, items]) =>
    `\n\n## ${heading}\n${items.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join('\n')}\n`).join('');
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const save = (file: string, value: unknown) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);

export interface WrittenBrief {
  brief: string;
  digest: string;
  outcome: 'ready' | 'blocking_questions' | 'invalid';
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
  const identity = hash(JSON.stringify([project, original, reader, role.adapter ?? options.adapter, BRIEF_OUTPUT_SCHEMA]));
  const root = join(fcGlobalDir(), 'brief-writing');
  const evidenceDir = join(root, identity);
  mkdirSync(evidenceDir, { recursive: true });
  atomicWrite(join(evidenceDir, 'original.txt'), original);
  const adapter = options.adapterInstance ?? await loadAdapterByName(role.adapter ?? options.adapter);
  const defaults = loadEngineDefaults();
  let reasons: string[] = [];
  const finish = (brief: string, outcome: WrittenBrief['outcome'], questions: string[]): WrittenBrief => {
    const digest = hash(brief);
    save(join(evidenceDir, `completion-${randomUUID()}.json`), { outcome, digest, duration_ms: Date.now() - startedAt });
    return { brief, digest, outcome, questions, reasons, evidenceDir };
  };
  // Incomplete attempts are evidence, never a task reservation or a consumed retry.
  const prior = readdirSync(evidenceDir).filter(name => name.endsWith('.reply.json')).sort();
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
        prompt, outputSchema: BRIEF_OUTPUT_SCHEMA, startedAt: new Date().toISOString() });
      try {
        result = await adapter.run(prompt, reader, {
          workDir: project, runDir: evidenceDir, stageId: `brief_writer_${attempt}`,
          timeout_ms: defaults.default_timeout_ms, outputSchema: BRIEF_OUTPUT_SCHEMA,
          onInvocationInput: input => save(file(`native-${randomUUID()}.json`), input),
        });
      } catch (error) {
        result = { output: '', exitCode: 1, duration_ms: 0, friendlyError: String(error) };
      }
      save(file('reply.json'), result);
    }
    completed++;
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
        if (!existsSync(resolve(project, input))) reasons.push(`Input does not exist: ${input}`);
      }
      // Static rehearsal already calls inspectBrief; do not duplicate its findings.
      const { rehearseBrief } = await import('./rehearse.js');
      const rehearsal = await rehearseBrief(['generated-brief', '--project', project], {
        briefText: brief, staticOnly: true, render: false,
      });
      reasons.push(...rehearsal.findings.filter(f => f.level === 'fail').map(f => f.text));
      validation({ reasons, questions, rehearsal });
    } else validation({ reasons });
    // A declared question is never repaired into a guess by another model call.
    if (questions.length) {
      atomicWrite(join(evidenceDir, 'brief.md'), brief);
      return finish(brief, 'blocking_questions', questions);
    }
    if (fields && reasons.length === 0) {
      atomicWrite(join(evidenceDir, 'brief.md'), brief);
      indexBriefWritingEvidence(project, brief, evidenceDir);
      return finish(brief, 'ready', []);
    }
  }
  return finish(original, 'invalid', []);
}

/** Bind the same evidence to a prepared target as well as its source repository. */
export function indexBriefWritingEvidence(projectDir: string, brief: string, evidenceDir: string): void {
  const root = join(fcGlobalDir(), 'brief-writing', 'by-digest');
  mkdirSync(root, { recursive: true });
  save(join(root, hash(JSON.stringify([realpathSync(resolve(projectDir)), hash(brief)])) + '.json'), { evidenceDir });
}

/** Attach authored evidence before dispatch, also when a saved preview is supplied later. */
export function attachBriefWritingEvidence(projectDir: string, brief: string, runDir: string): void {
  const project = realpathSync(resolve(projectDir));
  const index = join(fcGlobalDir(), 'brief-writing', 'by-digest', hash(JSON.stringify([project, hash(brief)])) + '.json');
  if (!existsSync(index)) return;
  const { evidenceDir } = JSON.parse(readFileSync(index, 'utf8')) as { evidenceDir: string };
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
