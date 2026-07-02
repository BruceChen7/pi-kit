/**
 * qmd-search — Pi native query interface for qmd knowledge bases.
 *
 * Detects `qmd` CLI (npm install -g @tobilu/qmd) at session startup and
 * registers 5 search/retrieval tools + 3 maintenance slash commands.
 * Knowledge base directories are configured under
 * `qmdSearch.knowledgeBases` in third_extension_settings.json.
 *
 * Auto-indexing: fs.watch on configured knowledge base directories with
 * 3-second debounce, plus staleness check at startup.
 *
 * QMD missing → silently skip registration.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";
import { loadSettings } from "../shared/settings.ts";

const execFileAsync = promisify(execFile);
const log = createLogger("qmd-search", { stderr: null });

// ── Constants ──────────────────────────────────────────────────────────────

const QMD_BINARY_DETECTION = [
  ["which", ["qmd"]],
  ["sh", ["-lc", "command -v qmd"]],
] as const;

const DEBOUNCE_MS = 3000;

// ── Types ──────────────────────────────────────────────────────────────────

type KnowledgeBase = {
  path: string;
  pattern?: string;
  collections?: string[];
};

type QmdSearchSettings = {
  qmdSearch?: {
    knowledgeBases?: Record<string, KnowledgeBase>;
  };
};

// ── Binary detection ───────────────────────────────────────────────────────

async function findQmdBinary(): Promise<string | null> {
  for (const [cmd, args] of QMD_BINARY_DETECTION) {
    try {
      const { stdout } = await execFileAsync(cmd, args);
      const found = stdout?.trim();
      if (found) return found;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ── Config loading ─────────────────────────────────────────────────────────

function loadKnowledgeBases(cwd: string): Record<string, KnowledgeBase> {
  const settings = loadSettings(cwd).merged as QmdSearchSettings;
  return settings?.qmdSearch?.knowledgeBases ?? {};
}

function getWatchDirs(
  knowledgeBases: Record<string, KnowledgeBase>,
): Array<{ dir: string; name: string }> {
  const seen = new Map<string, string>();
  for (const [name, kb] of Object.entries(knowledgeBases)) {
    if (kb.path) {
      const resolved = path.resolve(kb.path);
      seen.set(resolved, name);
    }
  }
  return [...seen.entries()].map(([dir, name]) => ({ dir, name }));
}

// ── Auto-indexing ──────────────────────────────────────────────────────────

function setupWatchers(
  _cwd: string,
  knowledgeBases: Record<string, KnowledgeBase>,
): () => void {
  const debounced = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: fs.FSWatcher[] = [];

  function scheduleUpdate(kbDir: string, kbName: string): void {
    const existing = debounced.get(kbDir);
    if (existing) clearTimeout(existing);

    debounced.set(
      kbDir,
      setTimeout(async () => {
        debounced.delete(kbDir);
        try {
          await execFileAsync("qmd", ["update", "-c", kbName], {
            cwd: kbDir,
            timeout: 120_000,
          });
          log.info("auto-index complete", { kbDir });
        } catch (err) {
          log.warn("auto-index failed", { kbDir, error: String(err) });
        }
      }, DEBOUNCE_MS),
    );
  }

  for (const { dir, name: kbName } of getWatchDirs(knowledgeBases)) {
    if (!fs.existsSync(dir)) {
      log.info("KB dir missing, skip watch", { dir });
      continue;
    }
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, filename) => {
        if (
          !filename ||
          filename.startsWith(".") ||
          filename.includes("node_modules")
        )
          return;
        scheduleUpdate(dir, kbName);
      });
      watchers.push(w);
      log.info("watching", { dir });
    } catch (err) {
      log.warn("watch failed", { dir, error: String(err) });
    }
  }

  return () => {
    for (const w of watchers)
      try {
        w.close();
      } catch {
        /* ignore */
      }
    for (const [k, t] of debounced) {
      clearTimeout(t);
      debounced.delete(k);
    }
  };
}

/** Track last-known mtime per KB directory to avoid redundant updates */
let dirMtimes = new Map<string, number>();

async function getDirMtime(dir: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(dir);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Determine whether any KB directories need an index update.
 *
 * Pure decision: given current directory mtimes and previously recorded
 * mtimes, returns whether any dir has changed and the updated mtime map.
 */
export function computeNeedsUpdate(
  dirs: Array<{ dir: string }>,
  currentMtimes: Map<string, number>,
  previousMtimes: Map<string, number>,
): { needsUpdate: boolean; updatedMtimes: Map<string, number> } {
  const updated = new Map(previousMtimes);
  let needsUpdate = false;
  for (const { dir } of dirs) {
    const mtime = currentMtimes.get(dir);
    if (mtime === undefined) continue;
    const prev = previousMtimes.get(dir);
    if (prev === undefined || mtime > prev) {
      updated.set(dir, mtime);
      needsUpdate = true;
    }
  }
  return { needsUpdate, updatedMtimes: updated };
}

async function stalenessCheck(
  knowledgeBases: Record<string, KnowledgeBase>,
): Promise<void> {
  const dirs = getWatchDirs(knowledgeBases);
  const currentMtimes = new Map<string, number>();
  for (const { dir } of dirs) {
    const mtime = await getDirMtime(dir);
    if (mtime !== null) currentMtimes.set(dir, mtime);
  }

  const { needsUpdate, updatedMtimes } = computeNeedsUpdate(
    dirs,
    currentMtimes,
    dirMtimes,
  );
  dirMtimes = updatedMtimes;

  if (!needsUpdate) {
    log.info("staleness check: no changes since last check, skipping");
    return;
  }

  try {
    await execFileAsync("qmd", ["update"], { timeout: 120_000 });
    log.info("staleness check: update completed");
  } catch (err) {
    log.warn("staleness check: update failed", { error: String(err) });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

async function runQmd(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 30_000,
): Promise<string> {
  const { stdout } = await execFileAsync("qmd", args, {
    cwd,
    signal,
    timeout,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      ...process.env,
      QMD_EMBED_MODEL:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    },
  });
  return stdout;
}

export function safeJson<T>(
  raw: string,
): T | { parseError: string; preview: string } {
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return { parseError: "invalid JSON", preview: raw.slice(0, 500) };
  }
}

function toolLabel(suffix: string): string {
  return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

/**
 * Format a structured search/query result into text + metadata details.
 *
 * Pure function: takes tool suffix, query, and parsed data, returns
 * the formatted text and details map.  Used by execQuery, execSearch,
 * etc. to avoid duplicating the markdown formatting logic.
 */
export function formatToolResult(
  toolSuffix: string,
  query: string,
  data: unknown,
): { text: string; details: Record<string, unknown> } {
  const count = Array.isArray(data) ? data.length : 1;
  return {
    text: [
      `### QMD ${toolLabel(toolSuffix)}: ${query}`,
      count > 0
        ? `Found ${count} result${count === 1 ? "" : "s"}.`
        : "No results found.",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
    ].join("\n"),
    details: {
      tool: `qmd_${toolSuffix}`,
      query,
      resultCount: count,
      results: data,
    },
  };
}

// ── Args builders (pure) ──────────────────────────────────────────────────

/**
 * Build a qmd query string from typed sub-queries (searches) or a simple query.
 *
 * When searches are provided, a multi-line document is built with each
 * `type: query` on its own line.  When searches are omitted, `opts.query`
 * is used as a simple expand query (single line, auto-expanded by LLM).
 *
 * See https://github.com/tobi/qmd/blob/main/docs/SYNTAX.md
 */
export function buildQueryString(opts: {
  query: string;
  searches?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
  intent?: string;
}): string {
  if (opts.searches && opts.searches.length > 0) {
    const lines: string[] = [];
    for (const s of opts.searches) {
      lines.push(`${s.type}: ${s.query}`);
    }
    return lines.join("\n");
  }
  return opts.query;
}

export function buildQueryArgs(opts: {
  query: string;
  searches?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
  collections?: string[];
  intent?: string;
  limit?: number;
  minScore?: number;
  rerank?: boolean;
}): string[] {
  const query = buildQueryString(opts);
  const args = ["query", query, "--json"];
  if (opts.limit) args.push("-n", String(opts.limit));
  if (opts.minScore !== undefined)
    args.push("--min-score", String(opts.minScore));
  if (opts.rerank === false) args.push("--no-rerank");
  if (opts.intent && !opts.searches) args.push("--intent", opts.intent);
  if (opts.collections) for (const c of opts.collections) args.push("-c", c);
  return args;
}

export function buildGetArgs(opts: {
  file: string;
  fromLine?: number;
  maxLines?: number;
  lineNumbers?: boolean;
}): string[] {
  const args = ["get", opts.file];
  if (opts.fromLine) args.push("--from", String(opts.fromLine));
  if (opts.maxLines) args.push("-l", String(opts.maxLines));
  if (opts.lineNumbers === false) args.push("--no-line-numbers");
  return args;
}

export function buildMultiGetArgs(opts: {
  pattern: string;
  maxBytes?: number;
  maxLines?: number;
  lineNumbers?: boolean;
}): string[] {
  const args = ["multi-get", opts.pattern, "--json"];
  if (opts.maxBytes) args.push("--max-bytes", String(opts.maxBytes));
  if (opts.maxLines) args.push("-l", String(opts.maxLines));
  if (opts.lineNumbers === false) args.push("--no-line-numbers");
  return args;
}

export function buildSearchArgs(opts: {
  query: string;
  collections?: string[];
  limit?: number;
}): string[] {
  const args = ["search", opts.query, "--json"];
  if (opts.limit) args.push("-n", String(opts.limit));
  if (opts.collections) for (const c of opts.collections) args.push("-c", c);
  return args;
}

// ── Tool: qmd_query ────────────────────────────────────────────────────────

/**
 * Result handling strategy:
 *
 * - execGet / execStatus: raw stdout pass-through.  qmd get returns
 *   document content (markdown text), qmd status returns human-readable
 *   CLI output — parsing JSON adds no value and loses formatting.
 * - execQuery / execSearch / execMultiGet: safeJson parse + structured
 *   details.  Search results benefit from structured metadata
 *   (resultCount, results array) for agent consumption.
 */

const QuerySchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Natural language search query for the knowledge base.",
  }),
  searches: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Union([
          Type.Literal("lex"),
          Type.Literal("vec"),
          Type.Literal("hyde"),
        ]),
        query: Type.String(),
      }),
      {
        description:
          "Typed sub-queries (lex/vec/hyde), 1-10. First gets 2x weight. Omit for simple query auto-expansion.",
      },
    ),
  ),
  collections: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Collection names to restrict to (OR). Omit to search all default collections.",
    }),
  ),
  intent: Type.Optional(
    Type.String({
      description:
        "Disambiguation context that helps refine the search (does not search on its own).",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Max results (default 10).",
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Minimum relevance score 0-1 (default 0).",
    }),
  ),
  rerank: Type.Optional(
    Type.Boolean({
      description:
        "Run LLM reranking (default true). Set false for RRF-only results.",
    }),
  ),
});

type QueryOpts = {
  query: string;
  searches?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
  collections?: string[];
  intent?: string;
  limit?: number;
  minScore?: number;
  rerank?: boolean;
};

async function execQuery(
  ctx: ExtensionContext,
  opts: QueryOpts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const args = buildQueryArgs(opts);

  try {
    const stdout = await runQmd(args, ctx.cwd, ctx.signal, 300_000);
    const data = safeJson<unknown>(stdout);

    if (data && typeof data === "object" && "parseError" in data) {
      const errorData = data as { parseError: string; preview: string };
      return textResult(
        `qmd query returned non-JSON output.\n${errorData.preview}`,
        { tool: "qmd_query", query: opts.query, raw: stdout.slice(0, 1000) },
      );
    }

    const { text, details } = formatToolResult("query", opts.query, data);
    return textResult(text, details);
  } catch (err) {
    return textResult(
      `qmd query failed: ${err instanceof Error ? err.message : String(err)}`,
      { tool: "qmd_query", query: opts.query, error: String(err) },
    );
  }
}

// ── Tool: qmd_get ──────────────────────────────────────────────────────────

const GetSchema = Type.Object({
  file: Type.String({
    description:
      "Document path, docid (#abc123), or path:from:count (e.g. #abc123:120:40).",
  }),
  fromLine: Type.Optional(
    Type.Integer({
      description: "Start line (1-indexed); overrides the :from suffix.",
    }),
  ),
  maxLines: Type.Optional(
    Type.Integer({ description: "Limit returned lines." }),
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Prefix lines with numbers (default true).",
    }),
  ),
});

type GetOpts = {
  file: string;
  fromLine?: number;
  maxLines?: number;
  lineNumbers?: boolean;
};

async function execGet(
  ctx: ExtensionContext,
  opts: GetOpts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const args = buildGetArgs(opts);

  try {
    const stdout = await runQmd(args, ctx.cwd, ctx.signal);
    return textResult(stdout, { tool: "qmd_get", file: opts.file });
  } catch (err) {
    return textResult(
      `qmd get failed: ${err instanceof Error ? err.message : String(err)}`,
      { tool: "qmd_get", file: opts.file, error: String(err) },
    );
  }
}

// ── Tool: qmd_multi_get ────────────────────────────────────────────────────

const MultiGetSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern or comma-separated list of paths/docids.",
  }),
  maxBytes: Type.Optional(
    Type.Integer({
      description: "Skip files larger than N bytes (default 10240).",
    }),
  ),
  maxLines: Type.Optional(
    Type.Integer({ description: "Limit lines per file." }),
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Prefix lines with numbers (default true).",
    }),
  ),
});

type MultiGetOpts = {
  pattern: string;
  maxBytes?: number;
  maxLines?: number;
  lineNumbers?: boolean;
};

async function execMultiGet(
  ctx: ExtensionContext,
  opts: MultiGetOpts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const args = buildMultiGetArgs(opts);

  try {
    const stdout = await runQmd(args, ctx.cwd, ctx.signal);
    const data = safeJson<unknown>(stdout);
    if (typeof data === "object" && data !== null && "parseError" in data) {
      return textResult(stdout, {
        tool: "qmd_multi_get",
        pattern: opts.pattern,
      });
    }
    return textResult(`\`\`\`json\n${JSON.stringify(data)}\n\`\`\``, {
      tool: "qmd_multi_get",
      pattern: opts.pattern,
      result: data,
    });
  } catch (err) {
    return textResult(
      `qmd multi_get failed: ${err instanceof Error ? err.message : String(err)}`,
      { tool: "qmd_multi_get", pattern: opts.pattern, error: String(err) },
    );
  }
}

// ── Tool: qmd_search ───────────────────────────────────────────────────────

const SearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Full-text BM25 keyword query (no LLM expansion).",
  }),
  collections: Type.Optional(
    Type.Array(Type.String(), {
      description: "Collection names to restrict to (OR).",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Max results (default 10).",
    }),
  ),
});

type SearchOpts = {
  query: string;
  collections?: string[];
  limit?: number;
};

async function execSearch(
  ctx: ExtensionContext,
  opts: SearchOpts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const args = buildSearchArgs(opts);

  try {
    const stdout = await runQmd(args, ctx.cwd, ctx.signal);
    const data = safeJson<unknown>(stdout);

    if (data && typeof data === "object" && "parseError" in data) {
      const errorData = data as { parseError: string; preview: string };
      return textResult(
        `qmd search returned non-JSON output.\n${errorData.preview}`,
        { tool: "qmd_search", query: opts.query, raw: stdout.slice(0, 1000) },
      );
    }

    const { text, details } = formatToolResult("search", opts.query, data);
    return textResult(text, details);
  } catch (err) {
    return textResult(
      `qmd search failed: ${err instanceof Error ? err.message : String(err)}`,
      { tool: "qmd_search", query: opts.query, error: String(err) },
    );
  }
}

// ── Tool: qmd_status ───────────────────────────────────────────────────────

const StatusSchema = Type.Object({});

async function execStatus(
  ctx: ExtensionContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const knowledgeBases = loadKnowledgeBases(ctx.cwd);
  const kbs = Object.entries(knowledgeBases).map(([name, kb]) => ({
    name,
    path: kb.path,
    pattern: kb.pattern ?? "**/*.md",
    collections: kb.collections ?? [],
  }));

  try {
    const stdout = await runQmd(["status"], ctx.cwd, ctx.signal);
    const lines = [
      "## QMD Status",
      "",
      "### Configured Knowledge Bases",
      ...(kbs.length
        ? kbs.map((kb) => `- **${kb.name}**: \`${kb.path}\` (${kb.pattern})`)
        : ["  _(none configured)_"]),
      "",
      "### QMD CLI Output",
      "```",
      stdout.trim(),
      "```",
    ];

    return textResult(lines.join("\n"), {
      tool: "qmd_status",
      knowledgeBases: kbs,
    });
  } catch (err) {
    return textResult(
      [
        "## QMD Status",
        "",
        "### Configured Knowledge Bases",
        ...(kbs.length
          ? kbs.map((kb) => `- **${kb.name}**: \`${kb.path}\` (${kb.pattern})`)
          : ["  _(none configured)_"]),
        "",
        "### QMD Status",
        `qmd status failed: ${err instanceof Error ? err.message : String(err)}`,
      ].join("\n"),
      {
        tool: "qmd_status",
        knowledgeBases: kbs,
        error: String(err),
      },
    );
  }
}

// ── Slash commands ─────────────────────────────────────────────────────────

function makeQmdCommandHandler(
  cmd: string,
  timeout: number,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (_args: string, ctx: ExtensionCommandContext) => {
    try {
      const { stdout, stderr } = await execFileAsync("qmd", [cmd], {
        cwd: ctx.cwd,
        timeout,
        env: {
          ...process.env,
          QMD_EMBED_MODEL:
            "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
        },
      });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      ctx.ui.notify(out || `${cmd} done (no output)`, "info");
    } catch (err) {
      ctx.ui.notify(
        `${cmd} failed: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
    }
  };
}

// ── Extension entry ────────────────────────────────────────────────────────

export default function qmdSearchExtension(pi: ExtensionAPI): void {
  let cleanup: (() => void) | null = null;
  let registered = false;

  function registerAll(): void {
    if (registered) return;
    registered = true;

    // Tools
    pi.registerTool({
      name: "qmd_query",
      label: "QMD Query",
      description:
        "Hybrid search across qmd knowledge bases using BM25 + vector + optional LLM reranking.",
      promptSnippet:
        "qmd_query: hybrid search across knowledge bases using BM25 + vector + reranking.",
      promptGuidelines: [
        "Use qmd_query for semantic search across markdown knowledge bases indexed by qmd.",
        "Simple usage: pass a natural language query string; QMD auto-expands and runs hybrid search.",
        "Advanced: pass typed searches (lex/vec/hyde) for explicit sub-query control.",
        "Use intent for disambiguation context (e.g., 'web page load times').",
        "Use collections to restrict to specific collections.",
        "When you find relevant documents, use qmd_get to read the full content.",
      ],
      parameters: QuerySchema,
      execute(_id, params, _signal, _onUpdate, ctx) {
        return execQuery(ctx, params as QueryOpts);
      },
    });

    pi.registerTool({
      name: "qmd_get",
      label: "QMD Get",
      description:
        "Retrieve a single document from the qmd knowledge base by path or docid.",
      promptSnippet:
        "qmd_get: retrieve a single document from the knowledge base by path or docid.",
      promptGuidelines: [
        "Use qmd_get after qmd_query to read full document content.",
        "Pass file path (e.g., 'docs/guide.md'), docid (e.g., '#abc123'), or path:from:count.",
        "Use fromLine and maxLines to read a specific line range.",
      ],
      parameters: GetSchema,
      execute(_id, params, _signal, _onUpdate, ctx) {
        return execGet(ctx, params as GetOpts);
      },
    });

    pi.registerTool({
      name: "qmd_multi_get",
      label: "QMD Multi Get",
      description:
        "Batch retrieve multiple documents from the qmd knowledge base by glob pattern or comma-separated list.",
      promptSnippet:
        "qmd_multi_get: batch retrieve multiple documents by glob or list.",
      promptGuidelines: [
        "Use qmd_multi_get to retrieve multiple documents at once.",
        "Pass a glob pattern (e.g., 'docs/**/*.md') or comma-separated list.",
        "Use maxBytes to skip files larger than a threshold (default 10KB).",
      ],
      parameters: MultiGetSchema,
      execute(_id, params, _signal, _onUpdate, ctx) {
        return execMultiGet(ctx, params as MultiGetOpts);
      },
    });

    pi.registerTool({
      name: "qmd_search",
      label: "QMD Search",
      description:
        "Full-text BM25 keyword search across qmd knowledge bases (no LLM). Fast and reliable for keyword lookups.",
      promptSnippet:
        "qmd_search: full-text keyword search across knowledge bases (no LLM).",
      promptGuidelines: [
        "Use qmd_search for fast keyword/BM25 search when you know exact terms.",
        "Unlike qmd_query, this does NOT use LLM query expansion or reranking.",
        "Use collections to restrict to specific collections.",
        "When you find relevant documents, use qmd_get to read the full content.",
      ],
      parameters: SearchSchema,
      execute(_id, params, _signal, _onUpdate, ctx) {
        return execSearch(ctx, params as SearchOpts);
      },
    });

    pi.registerTool({
      name: "qmd_status",
      label: "QMD Status",
      description: "Show qmd knowledge base index health and collection info.",
      promptSnippet:
        "qmd_status: knowledge base index health and collection status.",
      promptGuidelines: [
        "Use qmd_status to check which knowledge bases are configured and their index health.",
        "Run this first to verify qmd is properly set up.",
      ],
      parameters: StatusSchema,
      execute(_id, _params, _signal, _onUpdate, ctx) {
        return execStatus(ctx);
      },
    });

    // Slash commands
    pi.registerCommand("qmd-update", {
      description:
        "Re-index all qmd knowledge base collections (scan filesystem for changes).",
      handler: makeQmdCommandHandler("update", 120_000),
    });

    pi.registerCommand("qmd-embed", {
      description: "Generate vector embeddings for all qmd indexed documents.",
      handler: makeQmdCommandHandler("embed", 300_000),
    });

    pi.registerCommand("qmd-doctor", {
      description:
        "Diagnose the qmd installation (runtime, sqlite-vec, GPU probe, etc.).",
      handler: makeQmdCommandHandler("doctor", 30_000),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const qmdPath = await findQmdBinary();
    log.info("qmd binary check", { found: Boolean(qmdPath) });

    if (!qmdPath) {
      log.info("qmd not found; skip registration");
      return;
    }

    log.info("qmd found; registering tools & commands");
    registerAll();

    const knowledgeBases = loadKnowledgeBases(ctx.cwd);
    log.info("knowledge bases", {
      count: Object.keys(knowledgeBases).length,
    });

    // Non-blocking startup staleness check (skips if no KB dir mtime changes)
    stalenessCheck(knowledgeBases);

    // File watchers for auto-indexing
    cleanup = setupWatchers(ctx.cwd, knowledgeBases);
  });

  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = null;
  });
}
