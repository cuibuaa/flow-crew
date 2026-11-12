/** Project policy replaces the engine's metric, calibration and guard DSL.
 * Only capabilities, finite budgets and the transport envelope are engine-owned. */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ArtifactPathSchema } from './artifact-location.js';
import { normalizedProjectContentPath } from './scheduler/sched_admission/scope-services.js';

export const RESEARCH_PROTOCOL = 'research-instrument/v1' as const;
const localPath = ArtifactPathSchema.refine(p => normalizedProjectContentPath(p) === p && !p.startsWith('.fc'), 'use a normalized literal project-relative root');
const text = z.string().min(1).regex(/\S/);
const seconds = z.number().finite().positive().refine(v => Number.isSafeInteger(Math.ceil(v * 1000)), 'cap must have a finite safe millisecond bound');
export const ResearchInstrumentSchema = z.object({
  protocol: z.literal(RESEARCH_PROTOCOL),
  candidate: z.array(localPath).min(1),
  frozen: z.array(localPath).min(1),
  argv: z.array(z.string()).min(1).refine(v => isAbsolute(v[0]), 'argv[0] must be an absolute executable'),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  author: z.object({ role: text, instruction: text }).strict(),
  budget: z.object({
    max_rounds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 3),
    wall_seconds: seconds.optional(),
    invocation_seconds: seconds.optional(),
  }).strict(),
  review: z.object({ role: text, criteria: z.array(text).min(1) }).strict().optional(),
  publication: localPath.optional(),
}).strict().superRefine((v, ctx) => {
  if (Object.keys(v.environment).some(k => k.startsWith('FC_RESEARCH_') || ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'PATH', 'LANG', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH'].includes(k))) ctx.addIssue({ code: 'custom', message: 'reserved instrument environment variable' });
  const paths = [...v.frozen, ...v.candidate];
  const overlaps = (p: string, q: string) => p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
  if (paths.some((p, i) => paths.some((q, j) => i !== j && overlaps(p, q)))) ctx.addIssue({ code: 'custom', message: 'frozen and candidate roots must be disjoint and non-overlapping' });
  if (v.publication && paths.some(p => overlaps(p, v.publication!))) ctx.addIssue({ code: 'custom', message: 'publication must be outside frozen and candidate roots' });
});
export type ResearchConfig = z.infer<typeof ResearchInstrumentSchema>;
export type ResearchPhase = 'initialize' | 'evaluate' | 'finalize';
export interface CandidateSnapshot { path: string; sha256: string; label: string }
export interface RecordRef { path: string; sha256: string }
export interface ResearchBudget { rounds: number; wall_ms: number | null; invocation_ms: number | null }
export interface ResearchRequest {
  protocol: typeof RESEARCH_PROTOCOL;
  run_id: string;
  invocation_id: string;
  phase: ResearchPhase;
  round: number;
  instrument_sha256: string;
  instrument_path: string;
  candidate: CandidateSnapshot;
  initial: CandidateSnapshot;
  incumbent: CandidateSnapshot;
  history: ResearchOutcome[];
  previous_state: unknown;
  remaining_budget: ResearchBudget;
  engine_stop_reason?: string;
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchResponseSchema = z.object({
  protocol: z.literal(RESEARCH_PROTOCOL),
  run_id: text, invocation_id: text, phase: z.enum(['initialize', 'evaluate', 'finalize']), round: z.number().int().nonnegative(),
  instrument_sha256: sha, candidate_sha256: sha,
  status: z.enum(['ok', 'unavailable']),
  verdict: z.enum(['baseline', 'keep', 'reject']).optional(),
  reason: z.string(),
  observations: z.custom<unknown>(v => v !== undefined), diagnostics: z.custom<unknown>(v => v !== undefined),
  artifacts: z.array(z.object({ path: ArtifactPathSchema, sha256: sha }).strict()),
  next_state: z.custom<unknown>(v => v !== undefined),
  stop: z.object({ reason: text, outcome: z.custom<unknown>(v => v !== undefined) }).strict().nullable().optional(),
  report: z.object({ content: z.string() }).strict().optional(),
}).strict();
export type ResearchResponse = z.infer<typeof ResearchResponseSchema>;
export function validateResearchResponse(value: unknown, request: ResearchRequest): ResearchResponse {
  const response = ResearchResponseSchema.parse(value);
  if (response.protocol !== request.protocol || response.run_id !== request.run_id || response.invocation_id !== request.invocation_id
    || response.phase !== request.phase || response.round !== request.round || response.instrument_sha256 !== request.instrument_sha256
    || response.candidate_sha256 !== request.candidate.sha256) throw new Error('instrument_response_identity_mismatch');
  if (response.status === 'unavailable') {
    if (response.verdict !== undefined || response.report !== undefined) throw new Error('unavailable response cannot decide or report');
  } else if (request.phase === 'initialize' ? response.verdict !== 'baseline' || response.report !== undefined
    : request.phase === 'evaluate' ? !['keep', 'reject'].includes(response.verdict ?? '') || response.report !== undefined
      : response.verdict !== undefined || response.report === undefined) throw new Error('instrument_response_phase_mismatch');
  return response; // Opaque JSON is never projected or interpreted.
}
export interface ExecutionReceipt {
  started: boolean | null; exitCode: number | null; signal?: string | null;
  stdout: string; stderr: string; stdout_base64?: string; stderr_base64?: string; reason?: string; duration_ms: number;
}
export interface ResearchOutcome {
  round: number; phase?: ResearchPhase; candidate: CandidateSnapshot;
  outcome: 'baseline' | 'keep' | 'reject' | 'unavailable' | 'execution_error' | 'no_candidate' | 'review_rejected' | 'finalized';
  reason: string; request?: RecordRef; result: RecordRef; raw?: RecordRef;
  response?: ResearchResponse;
  author?: unknown; review?: { pass: boolean; reason?: string; record?: unknown };
}

/** Opaque JSON numbers must survive beyond JavaScript's precision/range. This
 * replaces JSON.parse's silent numeric coercion, without interpreting payloads.
 * Node's JSON source context/rawJSON retain their original wire spelling. */
export function parseResearchJSON(text: string): unknown {
  const parse = JSON.parse as (text: string, revive: (key: string, value: unknown, context?: { source: string }) => unknown) => unknown;
  const raw = (JSON as unknown as { rawJSON: (source: string) => unknown }).rawJSON;
  return parse(text, (_key, value, context) => typeof value === 'number' && context?.source !== undefined
    && context.source !== JSON.stringify(value) ? raw(context.source) : value);
}
