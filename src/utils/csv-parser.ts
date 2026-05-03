/**
 * High-performance single-pass state-machine CSV parser.
 *
 * Iterates through the input exactly once using {@link String.charCodeAt} for
 * character comparisons and index tracking to minimise allocations. Handles
 * RFC 4180 features: quoted fields, escaped quotes (`""`), newlines within
 * quotes, and empty fields.
 */

export interface CsvParseOptions {
  /** Field delimiter character (default `","`) */
  delimiter?: string;
  /** Whether the first row is a header row (default `true`) */
  hasHeader?: boolean;
}

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
}

const enum State {
  FIELD_START,
  UNQUOTED,
  QUOTED,
  QUOTE_END,
}

const QUOTE = 0x22;   // "
const LF    = 0x0a;   // \n
const CR    = 0x0d;   // \r

/**
 * Parses a CSV string into headers and rows using a single-pass state machine.
 *
 * @param input   - Raw CSV text.
 * @param options - Optional parsing configuration.
 * @returns Parsed headers and data rows.
 */
export function parseCsv(input: string, options?: CsvParseOptions): CsvParseResult {
  const delim = (options?.delimiter ?? ',').charCodeAt(0);
  const hasHeader = options?.hasHeader ?? true;
  const len = input.length;

  // Pre-allocate rows estimate (~60 chars per row is a reasonable heuristic)
  const estimatedRows = (len / 60) | 0;
  const rows: string[][] = [];
  rows.length = 0; // keep the engine hint but start empty

  let row: string[] = [];
  let state: State = State.FIELD_START;
  let fieldStart = 0;
  let i = 0;

  while (i < len) {
    const ch = input.charCodeAt(i);

    switch (state) {
      case State.FIELD_START:
        if (ch === QUOTE) {
          fieldStart = i + 1;
          state = State.QUOTED;
          i++;
        } else if (ch === delim) {
          row.push('');
          i++;
        } else if (ch === LF) {
          row.push('');
          rows.push(row);
          row = [];
          i++;
        } else if (ch === CR) {
          row.push('');
          rows.push(row);
          row = [];
          i++;
          if (i < len && input.charCodeAt(i) === LF) i++;
        } else {
          fieldStart = i;
          state = State.UNQUOTED;
          i++;
        }
        break;

      case State.UNQUOTED:
        if (ch === delim) {
          row.push(input.slice(fieldStart, i));
          state = State.FIELD_START;
          i++;
        } else if (ch === LF) {
          row.push(input.slice(fieldStart, i));
          rows.push(row);
          row = [];
          state = State.FIELD_START;
          i++;
        } else if (ch === CR) {
          row.push(input.slice(fieldStart, i));
          rows.push(row);
          row = [];
          state = State.FIELD_START;
          i++;
          if (i < len && input.charCodeAt(i) === LF) i++;
        } else {
          i++;
        }
        break;

      case State.QUOTED:
        if (ch === QUOTE) {
          state = State.QUOTE_END;
          i++;
        } else {
          i++;
        }
        break;

      case State.QUOTE_END:
        if (ch === QUOTE) {
          // Escaped quote ("") — continue in quoted state
          state = State.QUOTED;
          i++;
        } else if (ch === delim) {
          row.push(unescapeQuoted(input, fieldStart, i - 1));
          state = State.FIELD_START;
          i++;
        } else if (ch === LF) {
          row.push(unescapeQuoted(input, fieldStart, i - 1));
          rows.push(row);
          row = [];
          state = State.FIELD_START;
          i++;
        } else if (ch === CR) {
          row.push(unescapeQuoted(input, fieldStart, i - 1));
          rows.push(row);
          row = [];
          state = State.FIELD_START;
          i++;
          if (i < len && input.charCodeAt(i) === LF) i++;
        } else {
          // Malformed — treat as still in quoted field
          state = State.QUOTED;
          i++;
        }
        break;
    }
  }

  // Flush last field / row
  if (state === State.UNQUOTED) {
    row.push(input.slice(fieldStart, i));
  } else if (state === State.QUOTED) {
    // Unterminated quote — take what we have
    row.push(input.slice(fieldStart, i));
  } else if (state === State.QUOTE_END) {
    row.push(unescapeQuoted(input, fieldStart, i - 1));
  } else {
    // FIELD_START at end — only push empty if row already has fields
    if (row.length > 0) row.push('');
  }

  if (row.length > 0) rows.push(row);

  if (hasHeader && rows.length > 0) {
    const headers = rows.shift()!;
    return { headers, rows };
  }

  return { headers: [], rows };
}

/** Replaces escaped quotes ("") with single quotes in a quoted field. */
function unescapeQuoted(input: string, start: number, end: number): string {
  const slice = input.slice(start, end);
  // Fast path: no escaped quotes
  if (slice.indexOf('""') === -1) return slice;
  return slice.split('""').join('"');
}
