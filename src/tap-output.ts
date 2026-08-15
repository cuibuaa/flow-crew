export interface TapTopLevelRecord {
  ordinal: number;
  name: string;
  status: 'ok' | 'not_ok';
  directive?: 'skip' | 'todo';
}

export type TapOutputParse =
  | {
      state: 'complete';
      version: number;
      records: TapTopLevelRecord[];
      failureCount: number;
    }
  | {
      state: 'invalid';
      cause: 'truncated' | 'structural';
      reason: string;
    }
  | {
      state: 'not_tap';
      reason: string;
    };

const OMISSION_MARKER = /^\[\.\.\. \d+ earlier bytes omitted \.\.\.\]\s*$/;
const TOP_LEVEL_RECORD = /^(not ok|ok)\s+(\d+)(?:\s*-\s*(.*?))?\s*$/i;
const TOP_LEVEL_PLAN = /^(\d+)\.\.(\d+)(?:\s+#.*)?\s*$/;
const TAP_VERSION = /^TAP version (\d+)\s*$/i;

/**
 * Parse complete top-level TAP without treating nested records or partial
 * output as population or failure identity evidence.
 */
export function parseTapOutput(output: string): TapOutputParse {
  const lines = output.split(/\r?\n/);
  if (lines.some((line) => OMISSION_MARKER.test(line))) {
    return {
      state: 'invalid',
      cause: 'truncated',
      reason: 'TAP output was truncated before parsing',
    };
  }
  if (lines.some((line) => /^\s*Bail out!/i.test(line))) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: 'TAP output contains a bailout',
    };
  }

  const versionLike = lines.filter((line) => /^TAP version\b/i.test(line));
  const versions = versionLike.flatMap((line) => {
    const match = TAP_VERSION.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const tapShaped = versionLike.length > 0
    || lines.some((line) => TOP_LEVEL_RECORD.test(line) || TOP_LEVEL_PLAN.test(line))
    || lines.some((line) => /^\s*# Subtest:/i.test(line));
  if (versions.length === 0) {
    return tapShaped
      ? {
          state: 'invalid',
          cause: 'structural',
          reason: 'output is not complete TAP (version line missing)',
        }
      : { state: 'not_tap', reason: 'output is not complete TAP (version line missing)' };
  }
  if (versions.length !== 1 || versionLike.length !== 1) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: 'TAP output has ambiguous version lines',
    };
  }
  const [version] = versions;
  if (!Number.isSafeInteger(version)) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: 'TAP output has an invalid version number',
    };
  }

  const plans = lines.flatMap((line) => {
    const match = TOP_LEVEL_PLAN.exec(line);
    return match ? [{ start: Number(match[1]), end: Number(match[2]) }] : [];
  });
  if (plans.length !== 1) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: plans.length === 0
        ? 'TAP output has no top-level plan'
        : 'TAP output has multiple top-level plans',
    };
  }

  const records = new Map<number, TapTopLevelRecord>();
  for (const line of lines) {
    const match = TOP_LEVEL_RECORD.exec(line);
    if (!match) continue;
    const ordinal = Number(match[2]);
    if (!Number.isSafeInteger(ordinal) || records.has(ordinal)) {
      return {
        state: 'invalid',
        cause: 'structural',
        reason: `TAP output has a duplicate or invalid top-level ordinal: ${match[2]}`,
      };
    }
    const rawName = match[3] ?? '';
    const directiveMatch = /(?:^|\s+)#\s+(SKIP|TODO)\b.*$/i.exec(rawName);
    const name = rawName
      .replace(/(?:^|\s+)#\s+(?:SKIP|TODO)\b.*$/i, '')
      .trim();
    if (!name) {
      return {
        state: 'invalid',
        cause: 'structural',
        reason: `TAP top-level record ${match[2]} has no test name, so identity parity cannot be established`,
      };
    }
    records.set(ordinal, {
      ordinal,
      name,
      status: match[1].toLowerCase() === 'ok' ? 'ok' : 'not_ok',
      ...(directiveMatch
        ? { directive: directiveMatch[1].toLowerCase() as 'skip' | 'todo' }
        : {}),
    });
  }

  const [plan] = plans;
  if (plan.start !== 1 || !Number.isSafeInteger(plan.end)) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: `TAP output has an unsupported top-level plan ${plan.start}..${plan.end}`,
    };
  }
  const expectedCount = plan.end === 0 ? 0 : plan.end;
  if (records.size !== expectedCount) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: `TAP records do not match the top-level plan: expected ${expectedCount}, observed ${records.size}`,
    };
  }
  const expectedOrdinals = Array.from({ length: expectedCount }, (_, index) => index + 1);
  const missingOrdinals = expectedOrdinals.filter((ordinal) => !records.has(ordinal));
  const extraOrdinals = [...records.keys()].filter((ordinal) => ordinal < 1 || ordinal > plan.end);
  if (missingOrdinals.length > 0 || extraOrdinals.length > 0) {
    const missing = missingOrdinals.length > 0 ? ` missing ${missingOrdinals.join(', ')}` : '';
    const extra = extraOrdinals.length > 0 ? ` extra ${extraOrdinals.join(', ')}` : '';
    return {
      state: 'invalid',
      cause: 'structural',
      reason: `TAP records do not match the top-level plan${missing}${extra}`,
    };
  }

  const orderedRecords = expectedOrdinals.map((ordinal) => records.get(ordinal) as TapTopLevelRecord);
  const failureCount = orderedRecords
    .filter((record) => record.status === 'not_ok' && record.directive === undefined)
    .length;
  const failureSummaryLines = lines.filter((line) => /^#\s*fail\b/i.test(line));
  const failureSummaries = failureSummaryLines.flatMap((line) => {
    const match = /^#\s*fail\s+(\d+)\s*$/i.exec(line);
    return match ? [Number(match[1])] : [];
  });
  if (failureSummaryLines.length !== failureSummaries.length
      || failureSummaries.some((count) => !Number.isSafeInteger(count))) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: 'TAP output has an invalid top-level failure summary',
    };
  }
  if (failureSummaries.length > 1) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: 'TAP output has ambiguous top-level failure summaries',
    };
  }
  if (failureSummaries.length === 1 && failureSummaries[0] !== failureCount) {
    return {
      state: 'invalid',
      cause: 'structural',
      reason: `TAP failure summary does not match top-level records: reported ${failureSummaries[0]}, observed ${failureCount}`,
    };
  }

  return { state: 'complete', version, records: orderedRecords, failureCount };
}
