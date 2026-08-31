import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RUN_WIDE_GUIDANCE_TARGET = '*';

export interface GuidanceEnvelope {
  version: 1;
  id: string;
  target: string;
  source: 'supervisor' | 'operator' | 'scheduler';
  createdAt: string;
  body: string;
  quarantined?: boolean;
  quarantineReason?: string;
}

const ENVELOPE_PREFIX = '<!-- flowcrew-guidance ';
const ENVELOPE_SUFFIX = ' -->';
const STAGE_ID = /^[a-z][a-z0-9_]{0,19}$/;

function boundedBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function envelopeId(input: Pick<GuidanceEnvelope, 'target' | 'source' | 'createdAt' | 'body'>): string {
  return createHash('sha256')
    .update(JSON.stringify([input.target, input.source, input.createdAt, input.body]))
    .digest('hex')
    .slice(0, 20);
}

export function renderGuidanceEnvelope(envelope: GuidanceEnvelope): string {
  const body = boundedBody(envelope.body);
  const metadata = JSON.stringify({
    version: envelope.version,
    id: envelope.id,
    target: envelope.target,
    source: envelope.source,
    createdAt: envelope.createdAt,
    // Frame new entries so marker-shaped operator text remains opaque body
    // content instead of being reparsed as a second, forged envelope.
    bodyLength: body.length,
    ...(envelope.quarantined ? { quarantined: true, quarantineReason: envelope.quarantineReason } : {}),
  });
  return `${ENVELOPE_PREFIX}${metadata}${ENVELOPE_SUFFIX}\n${body}`;
}

function framedBodyLength(metadataText: string): number | undefined {
  try {
    const metadata = JSON.parse(metadataText) as { bodyLength?: unknown };
    return typeof metadata.bodyLength === 'number'
      && Number.isSafeInteger(metadata.bodyLength)
      && metadata.bodyLength >= 0
      ? metadata.bodyLength
      : undefined;
  } catch {
    return undefined;
  }
}

function parseEnvelopeBlock(metadataText: string, body: string): GuidanceEnvelope | undefined {
  try {
    const metadata = JSON.parse(metadataText) as Partial<GuidanceEnvelope>;
    if (metadata.version !== 1
      || typeof metadata.id !== 'string' || !metadata.id
      || typeof metadata.target !== 'string' || !metadata.target
      || (metadata.source !== 'supervisor' && metadata.source !== 'operator' && metadata.source !== 'scheduler')
      || typeof metadata.createdAt !== 'string' || !metadata.createdAt) return undefined;
    return {
      version: 1,
      id: metadata.id,
      target: metadata.target,
      source: metadata.source,
      createdAt: metadata.createdAt,
      body: boundedBody(body),
      ...(metadata.quarantined === true ? {
        quarantined: true,
        quarantineReason: typeof metadata.quarantineReason === 'string'
          ? metadata.quarantineReason
          : 'quarantined guidance',
      } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Parse both v1 envelopes and the historical `[stage]: text` ledger syntax. */
export function parseGuidanceLedger(text: string): GuidanceEnvelope[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const markerPattern = /<!-- flowcrew-guidance (\{[^\n]*\}) -->\n?/g;
  const parsed: GuidanceEnvelope[] = [];
  let firstMarkerIndex: number | undefined;
  let searchFrom = 0;
  while (searchFrom < normalized.length) {
    markerPattern.lastIndex = searchFrom;
    const marker = markerPattern.exec(normalized);
    if (!marker) break;
    firstMarkerIndex ??= marker.index;
    const start = marker.index + marker[0].length;
    const framedLength = framedBodyLength(marker[1]);
    let end: number;
    if (framedLength !== undefined) {
      end = start + framedLength;
      if (end > normalized.length) break;
    } else {
      markerPattern.lastIndex = start;
      const next = markerPattern.exec(normalized);
      end = next?.index ?? normalized.length;
    }
    const envelope = parseEnvelopeBlock(marker[1], normalized.slice(start, end));
    if (envelope?.body) parsed.push(envelope);
    searchFrom = end;
  }
  // A live run can cross the upgrade boundary with historical `[stage]: ...`
  // entries already present before its first v1 envelope. Preserve only that
  // unambiguously legacy prefix; envelope bodies remain opaque user text.
  const legacyText = firstMarkerIndex !== undefined
    ? normalized.slice(0, firstMarkerIndex)
    : normalized;

  // Compatibility reader for ledgers created before targeted envelopes. An
  // untagged paragraph has no provable recipient and is deliberately omitted.
  const legacy = [...legacyText.matchAll(/(?:^|\n)\[([a-z][a-z0-9_]{0,19}|all|\*)\]:\s*/g)];
  for (let index = 0; index < legacy.length; index += 1) {
    const match = legacy[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < legacy.length ? (legacy[index + 1].index ?? legacyText.length) : legacyText.length;
    const body = boundedBody(legacyText.slice(start, end));
    if (!body) continue;
    const target = match[1] === 'all' ? RUN_WIDE_GUIDANCE_TARGET : match[1];
    const createdAt = 'legacy';
    parsed.push({
      version: 1,
      id: envelopeId({ target, source: 'supervisor', createdAt, body }),
      target,
      source: 'supervisor',
      createdAt,
      body,
    });
  }
  return parsed;
}

export function guidanceForStageFromText(text: string, stageId: string): GuidanceEnvelope[] {
  const seen = new Set<string>();
  return parseGuidanceLedger(text).filter((entry) => {
    if (entry.quarantined || (entry.target !== stageId && entry.target !== RUN_WIDE_GUIDANCE_TARGET)) return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export function readGuidanceForStage(runDir: string, stageId: string): GuidanceEnvelope[] {
  const entries: GuidanceEnvelope[] = [];
  const ledgerPath = join(runDir, 'supervisor_guidance.md');
  if (existsSync(ledgerPath)) {
    try { entries.push(...guidanceForStageFromText(readFileSync(ledgerPath, 'utf-8'), stageId)); } catch { /* optional */ }
  }
  const stagePath = join(runDir, 'stages', stageId, 'guidance.md');
  if (existsSync(stagePath)) {
    try {
      const text = readFileSync(stagePath, 'utf-8');
      const parsed = parseGuidanceLedger(text);
      const structured = guidanceForStageFromText(text, stageId);
      if (structured.length > 0) entries.push(...structured);
      else if (parsed.length === 0 && !text.includes(ENVELOPE_PREFIX) && text.trim()) {
        const body = boundedBody(text);
        entries.push({
          version: 1,
          id: envelopeId({ target: stageId, source: 'supervisor', createdAt: 'stage-local-legacy', body }),
          target: stageId,
          source: 'supervisor',
          createdAt: 'stage-local-legacy',
          body,
        });
      }
    } catch { /* optional */ }
  }
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.id) && Boolean(seen.add(entry.id)));
}

export function renderGuidanceDelivery(entries: readonly GuidanceEnvelope[]): string {
  return entries.map(renderGuidanceEnvelope).join('\n\n');
}

export function appendGuidanceEnvelope(input: {
  runDir: string;
  target: string | null | undefined;
  body: string;
  source: GuidanceEnvelope['source'];
  knownStageIds?: readonly string[];
  createdAt?: string;
}): GuidanceEnvelope {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const body = boundedBody(input.body);
  const requestedTarget = input.target?.trim() ?? '';
  const targetIsKnown = requestedTarget === RUN_WIDE_GUIDANCE_TARGET
    || (STAGE_ID.test(requestedTarget)
      && (input.knownStageIds === undefined || input.knownStageIds.includes(requestedTarget)));
  const target = requestedTarget || '__missing__';
  const base = { target, source: input.source, createdAt, body };
  const envelope: GuidanceEnvelope = {
    version: 1,
    id: envelopeId(base),
    ...base,
    ...(!targetIsKnown ? {
      quarantined: true,
      quarantineReason: requestedTarget
        ? `unknown or invalid target stage: ${requestedTarget}`
        : 'guidance did not declare a target stage',
    } : {}),
  };
  const ledgerPath = join(input.runDir, 'supervisor_guidance.md');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${existsSync(ledgerPath) ? '\n\n' : ''}${renderGuidanceEnvelope(envelope)}\n`, 'utf-8');
  return envelope;
}
