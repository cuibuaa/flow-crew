import { readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Validate the entire JSON document, retaining only bounded top-level fields.
 * JSON.parse alone materializes unrelated stage/prompt history before binding.
 * The cursor retains one input chunk, selected values, and container syntax;
 * skipped strings, numbers, members and arrays are never materialized. */
export function readRunRecordFields(
  descriptor: number,
  limits: Readonly<Record<string, number>>,
): { value: unknown; byteLength: number } {
  const bytes = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let text = '', offset = 0, ended = false, byteLength = 0;
  let capture: { start: number; parts: string[]; length: number; limit: number } | undefined;
  const flush = () => {
    if (capture) {
      capture.parts.push(text.slice(capture.start, offset));
      capture.start = 0;
    }
  };
  const peek = (): string => {
    while (offset === text.length && !ended) {
      flush();
      const count = readSync(descriptor, bytes, 0, bytes.length, null);
      byteLength += count;
      text = count === 0 ? decoder.end() : decoder.write(bytes.subarray(0, count));
      offset = 0;
      ended = count === 0;
    }
    return text[offset] ?? '';
  };
  const take = (): string => {
    const char = peek();
    if (!char) throw new SyntaxError('Unexpected end of run JSON');
    offset++;
    if (capture && ++capture.length > capture.limit) {
      throw new RangeError('Bound run field exceeds its byte limit');
    }
    return char;
  };
  const finishCapture = (): unknown => {
    flush();
    const raw = capture!.parts.join('');
    const limit = capture!.limit;
    capture = undefined;
    if (Buffer.byteLength(raw, 'utf8') > limit) throw new RangeError('Bound run field exceeds its byte limit');
    return JSON.parse(raw) as unknown;
  };
  const whitespace = () => {
    while (peek() === ' ' || peek() === '\n' || peek() === '\r' || peek() === '\t') take();
  };
  const expect = (char: string) => {
    if (take() !== char) throw new SyntaxError('Invalid run JSON');
  };
  // A top-level key can only match a requested name if its escaped spelling
  // fits six characters per UTF-16 unit. Longer keys are validated and skipped.
  const keyLimit = Math.max(0, ...Object.keys(limits).map(key => key.length)) * 6 + 2;
  const string = (retainKey: boolean): string | undefined => {
    let raw: string | undefined = retainKey ? '"' : undefined;
    expect('"');
    let escaped = false, unicode = 0;
    for (;;) {
      const char = take();
      if (raw !== undefined) raw = raw.length < keyLimit ? raw + char : undefined;
      if (unicode > 0) {
        if (!/^[0-9a-f]$/iu.test(char)) throw new SyntaxError('Invalid run JSON string escape');
        unicode--;
      } else if (escaped) {
        if (char === 'u') unicode = 4;
        else if (!'"\\/bfnrt'.includes(char)) throw new SyntaxError('Invalid run JSON string escape');
        escaped = false;
      } else if (char === '"') {
        return raw === undefined ? undefined : JSON.parse(raw) as string;
      } else if (char === '\\') escaped = true;
      else if (char.charCodeAt(0) < 32) throw new SyntaxError('Invalid run JSON string');
    }
  };
  const digit = () => peek() >= '0' && peek() <= '9' && peek() !== '';
  const digits = () => {
    if (!digit()) throw new SyntaxError('Invalid run JSON number');
    do { take(); } while (digit());
  };
  const number = () => {
    if (peek() === '-') take();
    if (peek() === '0') take();
    else digits();
    if (peek() === '.') { take(); digits(); }
    if (peek() === 'e' || peek() === 'E') {
      take();
      if (peek() === '+' || peek() === '-') take();
      digits();
    }
  };
  type Frame = { kind: 'object' | 'array'; state: 'first' | 'key' | 'colon' | 'value' | 'comma'; key?: string };
  const stack: Frame[] = [];
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let selected: string | undefined;
  const value = () => {
    const char = peek();
    if (char === '{' || char === '[') {
      take(); stack.push({ kind: char === '{' ? 'object' : 'array', state: 'first' });
    } else if (char === '"') string(false);
    else if (char === '-' || digit()) number();
    else if (char === 't' || char === 'f' || char === 'n') {
      for (const letter of char === 't' ? 'true' : char === 'f' ? 'false' : 'null') expect(letter);
    } else throw new SyntaxError('Invalid run JSON value');
  };
  whitespace();
  const rootObject = peek() === '{';
  value();
  while (stack.length > 0) {
    whitespace();
    const frame = stack[stack.length - 1];
    const close = frame.kind === 'object' ? '}' : ']';
    if ((frame.state === 'first' || frame.state === 'comma') && peek() === close) {
      take(); stack.pop();
    } else if (frame.state === 'first' || frame.state === 'key') {
      if (frame.kind === 'object') {
        frame.key = string(stack.length === 1);
        frame.state = 'colon';
      } else frame.state = 'value';
    } else if (frame.state === 'colon') {
      expect(':'); frame.state = 'value';
    } else if (frame.state === 'value') {
      if (rootObject && stack.length === 1 && frame.key !== undefined
          && Object.prototype.hasOwnProperty.call(limits, frame.key)) {
        selected = frame.key;
        capture = { start: offset, parts: [], length: 0, limit: limits[selected] };
      }
      frame.state = 'comma'; value();
    } else {
      expect(','); frame.state = frame.kind === 'object' ? 'key' : 'value';
    }
    if (selected !== undefined && stack.length === 1 && stack[0].state === 'comma') {
      fields[selected] = finishCapture(); selected = undefined;
    }
  }
  whitespace();
  if (peek() !== '') throw new SyntaxError('Trailing data in run JSON');
  return { value: rootObject ? fields : null, byteLength };
}
