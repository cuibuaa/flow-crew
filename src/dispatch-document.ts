import { parse as parseYaml } from 'yaml';

/** One transport reader for live proposals and recorded dispatches. Stage and
 * graph validation belong to admission; readers retain either historical form.
 */
export function readDispatchDocument(text: string): { document: unknown; stages: unknown[] } {
  const document: unknown = parseYaml(text);
  const stages = Array.isArray(document) ? document
    : document && typeof document === 'object' && 'stages' in document ? document.stages : undefined;
  if (!Array.isArray(stages)) throw new Error('dispatch contains no stages (expected a top-level list or {stages: [...]})');
  return { document, stages };
}
