/**
 * Pure error formatting for pele parse failures.
 *
 * Shared by the Node validators and the visual-artifact UI renderer: both
 * receive the same `PeleError` shape and need the same caret-excerpt
 * collapse. No engine import, no DOM, no IO.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCaretLine = (line: string): boolean =>
  line.includes("^") && /^[\s\-|+^]*$/u.test(line);

/**
 * Collapse pele's multi-line parser message (excerpt + caret line) into one
 * line: the caret art is noise once the line/column is reported separately.
 */
export function condensePeleMessage(message: string): string {
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isCaretLine(line))
    .join(" ")
    .replace(/^Parse error on line \d+:\s*/u, "")
    .trim();
}

/** Agent-facing message without position decoration. */
export function formatPeleError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const message = error.message;
  return typeof message === "string"
    ? condensePeleMessage(message)
    : String(error);
}

export function peleErrorLine(error: unknown): number | undefined {
  if (isRecord(error)) {
    const line = error.line;
    if (typeof line === "number" && line > 0) return line;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Parse error on line (\d+):/u);
  return match ? Number(match[1]) : undefined;
}

export function peleErrorColumn(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const column = error.column;
  return typeof column === "number" && column > 0 ? column : undefined;
}
