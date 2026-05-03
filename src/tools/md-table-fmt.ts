import stringWidth from "string-width";

/**
 * Formats Markdown tables in the input string so that columns are perfectly aligned.
 * Uses Unicode-aware width measurement (CJK, emoji, ANSI codes handled correctly).
 * Non-table content passes through unchanged.
 */
export function formatMarkdownTables(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isTableLine(lines[i])) {
      const block: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      result.push(...formatTable(block));
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|");
}

type Alignment = "left" | "right" | "center" | "none";

function isSeparatorCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => isSeparatorCell(c));
}

function getAlignment(cell: string): Alignment {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

function parseCells(line: string): string[] {
  // Strip leading/trailing pipe, then split on pipe
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function padCell(content: string, width: number, align: Alignment): string {
  const w = stringWidth(content);
  const diff = width - w;
  if (diff <= 0) return content;

  if (align === "right") return " ".repeat(diff) + content;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return " ".repeat(left) + content + " ".repeat(right);
  }
  // left or none
  return content + " ".repeat(diff);
}

function buildSeparator(width: number, align: Alignment): string {
  if (align === "center") return ":" + "-".repeat(Math.max(width - 2, 1)) + ":";
  if (align === "right") return "-".repeat(Math.max(width - 1, 1)) + ":";
  if (align === "left") return ":" + "-".repeat(Math.max(width - 1, 1));
  return "-".repeat(width);
}

function formatTable(block: string[]): string[] {
  const parsed = block.map(parseCells);

  // Find separator row index
  let sepIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (isSeparatorRow(parsed[i])) {
      sepIdx = i;
      break;
    }
  }

  // Determine column count
  const colCount = Math.max(...parsed.map((r) => r.length));

  // Normalize all rows to same column count
  for (const row of parsed) {
    while (row.length < colCount) row.push("");
  }

  // Extract alignments from separator row
  const alignments: Alignment[] = [];
  for (let c = 0; c < colCount; c++) {
    alignments.push(sepIdx >= 0 ? getAlignment(parsed[sepIdx][c]) : "none");
  }

  // Compute max display width per column (excluding separator row)
  const colWidths: number[] = new Array(colCount).fill(0);
  for (let r = 0; r < parsed.length; r++) {
    if (r === sepIdx) continue;
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c], stringWidth(parsed[r][c]));
    }
  }

  // Ensure minimum width of 3 for separator dashes
  for (let c = 0; c < colCount; c++) {
    colWidths[c] = Math.max(colWidths[c], 3);
  }

  // Build output
  const output: string[] = [];
  for (let r = 0; r < parsed.length; r++) {
    if (r === sepIdx) {
      const cells = colWidths.map((w, c) => buildSeparator(w, alignments[c]));
      output.push("| " + cells.join(" | ") + " |");
    } else {
      const cells = parsed[r].map((cell, c) =>
        padCell(cell, colWidths[c], alignments[c]),
      );
      output.push("| " + cells.join(" | ") + " |");
    }
  }

  return output;
}
