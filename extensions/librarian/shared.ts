/* biome-ignore-all lint/suspicious/noControlCharactersInRegex: sanitizer intentionally detects control characters. */
/* biome-ignore-all lint/suspicious/noExplicitAny: GitHub API and pi JSON event payloads are intentionally dynamic at this adapter boundary. */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_PATCH_CHARS = 4096;

export type LibrarianPhase = "booting" | "exploring" | "writing";

export type ToolErrorResult = AgentToolResult<unknown> & { isError: true };

export type LibrarianProgressState = {
  startedAt: number;
  phase: LibrarianPhase;
  startedTools: number;
  completedTools: number;
  failedTools: number;
  currentAction?: string;
  recentActions: string[];
};

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export function truncateInline(text: string, max = 88): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function stripAnsiAndControl(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function sanitizeDisplayText(text: string, max = 20000): string {
  const cleaned = stripAnsiAndControl(text);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}\n… [truncated]`;
}

const MAX_GH_PARAM_CHARS = 2000;

export function sanitizeParamValue(key: string, value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Invalid param ${key}: empty value`);
  }

  if (trimmed.length > MAX_GH_PARAM_CHARS) {
    throw new Error(
      `Invalid param ${key}: exceeds ${MAX_GH_PARAM_CHARS} chars`,
    );
  }

  if (trimmed.startsWith("@")) {
    throw new Error(`Invalid param ${key}: @file values are not allowed`);
  }

  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error(`Invalid param ${key}: contains control characters`);
  }

  return trimmed;
}

export function normalizePath(input: string): string {
  let p = input;
  if (p.startsWith("file://")) p = p.slice(7);
  p = p.replace(/\\/g, "/").replace(/^\/+/, "");

  if (/[\x00-\x1F\x7F]/.test(p)) {
    throw new Error("Invalid path: contains control characters");
  }

  const rawParts = p.split("/").filter((seg) => seg.length > 0);
  const parts = rawParts.map((seg) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new Error("Invalid path: malformed percent-encoding");
    }

    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid path: encoded path separators are not allowed");
    }

    return decoded;
  });

  if (parts.some((seg) => seg === "..")) {
    throw new Error("Invalid path: parent traversal is not allowed");
  }

  return parts.filter((seg) => seg !== ".").join("/");
}

export function decodeBase64Utf8(data: string): string {
  return Buffer.from(data.replace(/\n/g, ""), "base64").toString("utf8");
}

export function globMatches(pattern: string, filePath: string): boolean {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
      continue;
    }

    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }

    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const items = pattern
          .slice(i + 1, close)
          .split(",")
          .map((s) => escapeRegex(s));
        regex += `(?:${items.join("|")})`;
        i = close + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = pattern.indexOf("]", i);
      if (close !== -1) {
        regex += pattern.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }

    regex += escapeRegex(ch);
    i += 1;
  }

  return new RegExp(`^${regex}$`).test(filePath);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readRangeSlice(
  content: string,
  range?: number[],
): { content: string; startLine: number } {
  if (!range || range.length !== 2) {
    return { content, startLine: 1 };
  }

  const [start, end] = range;
  const startSafe = Math.max(1, start || 1);
  const endSafe = Math.max(startSafe, end || startSafe);
  const lines = content.split("\n").slice(startSafe - 1, endSafe);
  return { content: lines.join("\n"), startLine: startSafe };
}

export function formatNumberedFileContent(content: string, range?: number[]) {
  const sliced = readRangeSlice(content, range);
  const bytes = Buffer.byteLength(sliced.content, "utf8");

  if (bytes > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large (${Math.round(bytes / 1024)}KB). Retry with a smaller read_range (max 128KB per call).`,
    );
  }

  return sliced.content
    .split("\n")
    .map((line, i) => `${sliced.startLine + i}: ${line}`)
    .join("\n");
}

export function validateFilePattern(filePattern: string) {
  if (!filePattern) throw new Error("filePattern is required");
  if (filePattern.length > 256) {
    throw new Error("filePattern exceeds 256 characters");
  }
  if (/[\x00-\x1F\x7F]/.test(filePattern)) {
    throw new Error("filePattern contains control characters");
  }
}

export function formatDirectoryEntries(
  data: unknown,
  directoryType: string,
  limit: number,
): string[] {
  return (Array.isArray(data) ? data : [])
    .map((entry: any) =>
      entry.type === directoryType ? `${entry.name}/` : String(entry.name),
    )
    .sort((a: string, b: string) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      if (aDir && !bDir) return -1;
      if (!aDir && bDir) return 1;
      return a.localeCompare(b);
    })
    .slice(0, limit);
}

export function validateSearchPattern(pattern: string) {
  if (pattern.length > 256) {
    throw new Error("pattern exceeds 256 characters");
  }

  const operators = pattern.match(/\b(AND|OR|NOT)\b/gi) ?? [];
  if (operators.length > 5) {
    throw new Error("pattern exceeds max 5 boolean operators (AND/OR/NOT)");
  }

  const stripped = pattern.replace(/\b(AND|OR|NOT)\b/gi, " ").trim();
  if (!stripped) {
    throw new Error("pattern must include at least one search term");
  }
}

export function asTextResult(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function toolErrorResult(
  toolName: string,
  error: unknown,
): ToolErrorResult {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [{ type: "text" as const, text: `${toolName} error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}
