import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

/**
 * Append one complete text record without joining it to bytes left by a torn
 * previous append. Historical bytes are never rewritten: when a non-empty
 * file does not end in a newline, the separating newline and new record are
 * emitted together through the append descriptor.
 */
export function appendTextRecord(path: string, record: string): void {
  const descriptor = openSync(path, 'a+');
  try {
    const size = fstatSync(descriptor).size;
    let needsBoundary = false;
    if (size > 0) {
      const finalByte = Buffer.allocUnsafe(1);
      needsBoundary = readSync(descriptor, finalByte, 0, 1, size - 1) !== 1
        || finalByte[0] !== 0x0a;
    }
    const completeRecord = record.endsWith('\n') ? record : `${record}\n`;
    const bytes = Buffer.from(`${needsBoundary ? '\n' : ''}${completeRecord}`, 'utf-8');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error(`Append made no progress for ${path}`);
      written += count;
    }
  } finally {
    closeSync(descriptor);
  }
}
