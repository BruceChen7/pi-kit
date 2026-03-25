/**
 * Tools Intercepted Extension
 *
 * PATH shims (intercepted-commands) remain for:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected to `uv run python`, with special handling to
 *   block `python -m pip` and `python -m venv`
 *
 * Built-in grep/find tools are disabled and replaced with:
 * - rg: structured ripgrep output (same format as built-in grep)
 * - fd: structured fd output (same format as built-in find)
 *
 * Notes:
 * - No auto-download for rg/fd. Missing binaries return install hints + error.
 * - --hidden and .gitignore behavior is preserved.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { createLogger } from "../shared/logger.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const GREP_MAX_LINE_LENGTH = 500;
const COMMAND_PREVIEW_LIMIT = 200;
const SHELL_SAFE_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;

type RgMatchEvent = {
  type: "match";
  data: {
    path?: {
      text?: string;
    };
    line_number?: number;
  };
};

const isRgMatchEvent = (value: unknown): value is RgMatchEvent => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as { type?: unknown; data?: unknown };
  if (event.type !== "match") {
    return false;
  }
  if (!event.data || typeof event.data !== "object") {
    return false;
  }
  return true;
};

const RG_INSTALL_HINT = [
  "ripgrep (rg) is required but not installed.",
  "",
  "Install:",
  "  brew install ripgrep     # macOS",
  "  apt install ripgrep      # Ubuntu/Debian",
  "  pacman -S ripgrep        # Arch Linux",
].join("\n");

const FD_INSTALL_HINT = [
  "fd is required but not installed.",
  "",
  "Install:",
  "  brew install fd          # macOS",
  "  apt install fd           # Ubuntu/Debian",
  "  pacman -S fd             # Arch Linux",
].join("\n");

const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Search pattern (regex or literal string)",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory or file to search (default: current directory)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description:
        "Number of lines to show before and after each match (default: 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of matches to return (default: 100)",
    }),
  ),
});

const findSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory to search in (default: current directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results (default: 1000)" }),
  ),
});

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

let log: ReturnType<typeof createLogger> | null = null;

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/")) {
    return homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolve(cwd, expanded);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function quoteShellArg(value: string): string {
  if (!value) {
    return "''";
  }
  if (SHELL_SAFE_ARG.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteShellArg)].join(" ");
}

function truncateCommand(
  value: string,
  maxLength = COMMAND_PREVIEW_LIMIT,
): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildRgArgs(
  pattern: string,
  searchPath: string,
  glob?: string,
  ignoreCase?: boolean,
  literal?: boolean,
): string[] {
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (ignoreCase) {
    args.push("--ignore-case");
  }
  if (literal) {
    args.push("--fixed-strings");
  }
  if (glob) {
    args.push("--glob", glob);
  }
  args.push(pattern, searchPath);
  return args;
}

const RG_REGEX_PARSE_ERROR =
  /regex parse error|unclosed (?:group|character class|bracket)/i;

function isRegexParseError(message: string): boolean {
  return RG_REGEX_PARSE_ERROR.test(message);
}

function buildFdArgs(
  pattern: string,
  searchPath: string,
  effectiveLimit: number,
  ignoreFiles: Iterable<string> = [],
): string[] {
  const args = [
    "--glob",
    "--color=never",
    "--hidden",
    "--max-results",
    String(effectiveLimit),
  ];

  for (const ignoreFile of ignoreFiles) {
    args.push("--ignore-file", ignoreFile);
  }

  args.push(pattern, searchPath);
  return args;
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "pipe" });
    return result.error == null;
  } catch {
    return false;
  }
}

function applyInterceptedPath(reason: string): void {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);

  if (entries.includes(interceptedCommandsPath)) {
    log?.debug("Intercepted commands path already applied", {
      reason,
      pathKey,
      interceptedCommandsPath,
    });
    return;
  }

  process.env[pathKey] = [interceptedCommandsPath, currentPath]
    .filter(Boolean)
    .join(delimiter);

  log?.info("Prepended intercepted commands path", {
    reason,
    pathKey,
    interceptedCommandsPath,
  });
}

function applyActiveTools(pi: ExtensionAPI, reason: string): void {
  const active = new Set(pi.getActiveTools());
  active.delete("grep");
  active.delete("find");
  active.add("rg");
  active.add("fd");

  pi.setActiveTools(Array.from(active));

  log?.info("Updated active tools", {
    reason,
    activeTools: Array.from(active),
  });
}

function createDisabledTool(name: "grep" | "find", replacement: string) {
  return {
    name,
    label: `${name} (disabled)`,
    description: `${name} tool is disabled. Use the ${replacement} tool instead.`,
    parameters: name === "grep" ? grepSchema : findSchema,
    async execute() {
      throw new Error(
        `${name} tool is disabled. Use the ${replacement} tool instead.`,
      );
    },
  };
}

function createRgTool() {
  return {
    name: "rg",
    label: "rg",
    description: `Search file contents with ripgrep. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_GREP_LIMIT} matches or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    renderCall(args, theme) {
      const searchPath = args.path ?? ".";
      const command = formatCommand(
        "rg",
        buildRgArgs(
          args.pattern,
          searchPath,
          args.glob,
          args.ignoreCase,
          args.literal,
        ),
      );
      const preview = truncateCommand(command);

      let text = theme.fg("toolTitle", theme.bold("$ "));
      text += theme.fg("accent", preview);

      const extras: string[] = [];
      if (typeof args.context === "number" && args.context > 0) {
        extras.push(`context=${args.context}`);
      }
      if (typeof args.limit === "number") {
        extras.push(`limit=${args.limit}`);
      }
      if (extras.length > 0) {
        text += theme.fg("dim", ` (${extras.join(", ")})`);
      }

      return new Text(text, 0, 0);
    },
    async execute(
      _toolCallId: string,
      {
        pattern,
        path: searchDir,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
      }: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };

        let literalFallbackUsed = false;

        const runSearch = (useLiteral: boolean) => {
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }

          try {
            const cwd = ctx?.cwd ?? process.cwd();
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            let isDirectory: boolean;

            try {
              isDirectory = statSync(searchPath).isDirectory();
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }

            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);

            const formatPath = (filePath: string) => {
              if (isDirectory) {
                const relativePath = relative(searchPath, filePath);
                if (relativePath && !relativePath.startsWith("..")) {
                  return relativePath.replace(/\\/g, "/");
                }
              }
              return basename(filePath);
            };

            const fileCache = new Map<string, string[]>();
            const getFileLines = async (filePath: string) => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await readFile(filePath, "utf-8");
                  lines = content
                    .replace(/\r\n/g, "\n")
                    .replace(/\r/g, "\n")
                    .split("\n");
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };

            const args = buildRgArgs(
              pattern,
              searchPath,
              glob,
              ignoreCase,
              useLiteral,
            );

            if (!commandExists("rg")) {
              settle(() => reject(new Error(RG_INSTALL_HINT)));
              return;
            }

            const child = spawn("rg", args, {
              stdio: ["ignore", "pipe", "pipe"],
            });
            const rl = createInterface({ input: child.stdout });

            let stderr = "";
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            let aborted = false;
            let killedDueToLimit = false;
            const matches: Array<{ filePath: string; lineNumber: number }> = [];

            const cleanup = () => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
            };

            const stopChild = (dueToLimit = false) => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit;
                child.kill();
              }
            };

            const onAbort = () => {
              aborted = true;
              stopChild();
            };

            signal?.addEventListener("abort", onAbort, { once: true });

            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });

            const formatBlock = async (
              filePath: string,
              lineNumber: number,
            ) => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) {
                return [`${relativePath}:${lineNumber}: (unable to read file)`];
              }

              const block: string[] = [];
              const start =
                contextValue > 0
                  ? Math.max(1, lineNumber - contextValue)
                  : lineNumber;
              const end =
                contextValue > 0
                  ? Math.min(lines.length, lineNumber + contextValue)
                  : lineNumber;

              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const isMatchLine = current === lineNumber;
                const { text: truncatedText, wasTruncated } =
                  truncateLine(sanitized);

                if (wasTruncated) {
                  linesTruncated = true;
                }

                if (isMatchLine) {
                  block.push(`${relativePath}:${current}: ${truncatedText}`);
                } else {
                  block.push(`${relativePath}-${current}- ${truncatedText}`);
                }
              }

              return block;
            };

            rl.on("line", (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) {
                return;
              }

              let event: unknown;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }

              if (!isRgMatchEvent(event)) {
                return;
              }

              matchCount++;
              const filePath = event.data.path?.text;
              const lineNumber = event.data.line_number;
              if (
                typeof filePath === "string" &&
                typeof lineNumber === "number"
              ) {
                matches.push({ filePath, lineNumber });
              }
              if (matchCount >= effectiveLimit) {
                matchLimitReached = true;
                stopChild(true);
              }
            });

            child.on("error", (error) => {
              cleanup();
              const err = error as NodeJS.ErrnoException;
              if (err.code === "ENOENT") {
                settle(() => reject(new Error(RG_INSTALL_HINT)));
                return;
              }
              settle(() =>
                reject(new Error(`Failed to run rg: ${error.message}`)),
              );
            });

            child.on("close", async (code) => {
              cleanup();

              if (aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }

              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `rg exited with code ${code}`;
                if (!useLiteral && isRegexParseError(errorMsg)) {
                  literalFallbackUsed = true;
                  runSearch(true);
                  return;
                }
                settle(() => reject(new Error(errorMsg)));
                return;
              }

              if (matchCount === 0) {
                const message = literalFallbackUsed
                  ? "No matches found (retried with literal search after regex parse error)"
                  : "No matches found";
                settle(() =>
                  resolve({
                    content: [{ type: "text", text: message }],
                    details: literalFallbackUsed
                      ? { literalFallback: true }
                      : undefined,
                  }),
                );
                return;
              }

              const outputLines: string[] = [];
              for (const match of matches) {
                const block = await formatBlock(
                  match.filePath,
                  match.lineNumber,
                );
                outputLines.push(...block);
              }

              const rawOutput = outputLines.join("\n");
              const truncation = truncateHead(rawOutput, {
                maxLines: Number.MAX_SAFE_INTEGER,
              });
              let output = truncation.content;

              const details: Record<string, unknown> = {};
              const notices: string[] = [];

              if (literalFallbackUsed) {
                notices.push(
                  "Regex parse error detected. Retried with literal search. Set literal=true to skip regex parsing",
                );
                details.literalFallback = true;
              }

              if (matchLimitReached) {
                notices.push(
                  `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                );
                details.matchLimitReached = effectiveLimit;
              }

              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }

              if (linesTruncated) {
                notices.push(
                  `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
                );
                details.linesTruncated = true;
              }

              if (notices.length > 0) {
                output += `\n\n[${notices.join(". ")}]`;
              }

              settle(() =>
                resolve({
                  content: [{ type: "text", text: output }],
                  details:
                    Object.keys(details).length > 0 ? details : undefined,
                }),
              );
            });
          } catch (err) {
            settle(() => reject(err));
          }
        };

        runSearch(literal ?? false);
      });
    },
  };
}

function createFdTool() {
  return {
    name: "fd",
    label: "fd",
    description: `Search for files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_FIND_LIMIT} results or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    parameters: findSchema,
    renderCall(args, theme) {
      const searchPath = args.path ?? ".";
      const effectiveLimit = args.limit ?? DEFAULT_FIND_LIMIT;
      const command = formatCommand(
        "fd",
        buildFdArgs(args.pattern, searchPath, effectiveLimit),
      );
      const preview = truncateCommand(command);

      let text = theme.fg("toolTitle", theme.bold("$ "));
      text += theme.fg("accent", preview);

      return new Text(text, 0, 0);
    },
    async execute(
      _toolCallId: string,
      {
        pattern,
        path: searchDir,
        limit,
      }: { pattern: string; path?: string; limit?: number },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        const onAbort = () => reject(new Error("Operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });

        (async () => {
          try {
            const cwd = ctx?.cwd ?? process.cwd();
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;

            const gitignoreFiles = new Set<string>();
            const rootGitignore = join(searchPath, ".gitignore");
            if (existsSync(rootGitignore)) {
              gitignoreFiles.add(rootGitignore);
            }

            try {
              const nestedGitignores = globSync("**/.gitignore", {
                cwd: searchPath,
                dot: true,
                absolute: true,
                ignore: ["**/node_modules/**", "**/.git/**"],
              });

              for (const file of nestedGitignores) {
                gitignoreFiles.add(file);
              }
            } catch {
              // Ignore glob errors
            }

            const args = buildFdArgs(
              pattern,
              searchPath,
              effectiveLimit,
              gitignoreFiles,
            );

            if (!commandExists("fd")) {
              signal?.removeEventListener("abort", onAbort);
              reject(new Error(FD_INSTALL_HINT));
              return;
            }

            const result = spawnSync("fd", args, {
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
            });

            signal?.removeEventListener("abort", onAbort);

            if (result.error) {
              const err = result.error as NodeJS.ErrnoException;
              if (err.code === "ENOENT") {
                reject(new Error(FD_INSTALL_HINT));
                return;
              }
              reject(new Error(`Failed to run fd: ${result.error.message}`));
              return;
            }

            const output = result.stdout?.trim() || "";
            if (result.status !== 0) {
              const errorMsg =
                result.stderr?.trim() || `fd exited with code ${result.status}`;
              if (!output) {
                reject(new Error(errorMsg));
                return;
              }
            }

            if (!output) {
              resolve({
                content: [
                  { type: "text", text: "No files found matching pattern" },
                ],
                details: undefined,
              });
              return;
            }

            const lines = output.split("\n");
            const relativized: string[] = [];

            for (const rawLine of lines) {
              const line = rawLine.replace(/\r$/, "").trim();
              if (!line) continue;
              const hadTrailingSlash =
                line.endsWith("/") || line.endsWith("\\");

              let relativePath = line;
              if (line.startsWith(searchPath)) {
                relativePath = line.slice(searchPath.length + 1);
              } else {
                relativePath = path.relative(searchPath, line);
              }

              if (hadTrailingSlash && !relativePath.endsWith("/")) {
                relativePath += "/";
              }

              relativized.push(toPosixPath(relativePath));
            }

            const resultLimitReached = relativized.length >= effectiveLimit;
            const rawOutput = relativized.join("\n");
            const truncation = truncateHead(rawOutput, {
              maxLines: Number.MAX_SAFE_INTEGER,
            });
            let resultOutput = truncation.content;

            const details: Record<string, unknown> = {};
            const notices: string[] = [];

            if (resultLimitReached) {
              notices.push(
                `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
              );
              details.resultLimitReached = effectiveLimit;
            }

            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }

            if (notices.length > 0) {
              resultOutput += `\n\n[${notices.join(". ")}]`;
            }

            resolve({
              content: [{ type: "text", text: resultOutput }],
              details: Object.keys(details).length > 0 ? details : undefined,
            });
          } catch (err) {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          }
        })();
      });
    },
  };
}

export default function (pi: ExtensionAPI) {
  log = createLogger("tools-intercepted", { stderr: null });

  applyInterceptedPath("init");

  pi.registerTool(createDisabledTool("grep", "rg"));
  pi.registerTool(createDisabledTool("find", "fd"));
  pi.registerTool(createRgTool());
  pi.registerTool(createFdTool());

  pi.on("session_start", () => {
    applyInterceptedPath("session_start");
    applyActiveTools(pi, "session_start");
  });

  pi.on("session_switch", () => {
    applyInterceptedPath("session_switch");
    applyActiveTools(pi, "session_switch");
  });
}
