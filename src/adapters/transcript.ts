/**
 * Strip CLI transcript noise to recover just the agent's final message.
 *
 * The codex `exec` CLI prints the entire session on stdout: a banner, the fully
 * echoed prompt (which itself can contain prior stage transcripts), then the real
 * answer introduced by a lone `codex` line and followed by a `tokens used\n<n>`
 * footer. We keep the text after the LAST `codex` marker and drop that footer
 * (and any reprint after it). Output that has no such markers (e.g. the claude
 * adapter's already-clean text) is returned unchanged — this is idempotent.
 */
export function extractFinalMessage(raw: string): string {
  let text = raw;
  const marker = /\n\s*codex\s*\n/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd >= 0) text = text.slice(lastEnd);
  text = text.replace(/\n\s*tokens used\s*\n[\d,]+[\s\S]*$/i, '');
  return text.trim();
}
