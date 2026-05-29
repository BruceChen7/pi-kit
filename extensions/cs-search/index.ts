import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";

const execFileAsync = promisify(execFile);

const log = createLogger("cs-search", { stderr: null });

const TOOL_NAME = "cs_search";
const DEFAULT_MAX_RESULTS = 3;
const CS_BINARY_DETECTION_COMMANDS = [
  ["which", ["cs"]],
  ["sh", ["-lc", "command -v cs"]],
] as const;

const KIND_FLAGS: Record<NonNullable<CsSearchParams["kind"]>, string[]> = {
  implementation: ["--only-code", "--gravity=brain"],
  declaration: ["--only-declarations"],
  usage: ["--only-usages"],
  comment: ["--only-comments"],
  string: ["--only-strings"],
  auto: [],
};

type CsSearchParams = {
  query: string;
  kind?:
    | "implementation"
    | "declaration"
    | "usage"
    | "comment"
    | "string"
    | "auto";
  path?: string;
  language?: string;
  max_results?: number;
  explain_query?: string;
};

type CsSearchLineResult = {
  line_number?: number;
  content?: string;
  match_positions?: number[][];
};

type NormalizedLineResult = {
  line: number | null;
  content: string;
};

type CsSearchResult = {
  filename?: string;
  location?: string;
  line_number?: number;
  snippet?: string;
  content?: string;
  lines?: CsSearchLineResult[];
  score?: number;
};

const toolParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Search query for ranked structural code search.",
  }),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("implementation"),
      Type.Literal("declaration"),
      Type.Literal("usage"),
      Type.Literal("comment"),
      Type.Literal("string"),
      Type.Literal("auto"),
    ]),
  ),
  path: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional path prefix to filter results to a directory or file.",
    }),
  ),
  language: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional language hint or file extension filter such as ts, go, py, or md.",
    }),
  ),
  max_results: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10,
      description: "Maximum number of ranked results to return. Prefer 3 to 5.",
    }),
  ),
  explain_query: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional short explanation of the search intent to refine ranked retrieval.",
    }),
  ),
});

function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function findCsBinary(): Promise<string | null> {
  for (const [command, args] of CS_BINARY_DETECTION_COMMANDS) {
    try {
      const { stdout } = await execFileAsync(command, args);
      return stdout?.trim() || null;
    } catch {}
  }

  return null;
}

function toComparablePath(result: CsSearchResult): string {
  return result.location || result.filename || "";
}

function normalizeLanguage(language: string | undefined): string | undefined {
  return language?.trim().replace(/^\./, "").toLowerCase() || undefined;
}

function buildSearchQuery(params: CsSearchParams): string {
  const parts = [params.query.trim()];
  const pathFilter = params.path?.trim().replace(/^\.\//, "");
  const languageFilter = normalizeLanguage(params.language);

  if (pathFilter) {
    parts.push(`path:${pathFilter}`);
  }

  if (languageFilter) {
    parts.push(`ext:${languageFilter}`);
  }

  return parts.join(" ");
}

function buildSearchArgs(params: CsSearchParams): string[] {
  const kind = params.kind ?? "auto";
  return [buildSearchQuery(params), ...KIND_FLAGS[kind], "--format", "json"];
}

async function runSearch(
  csPath: string,
  ctx: ExtensionContext,
  params: CsSearchParams,
): Promise<{
  searchQuery: string;
  searchArgs: string[];
  parsedResults: CsSearchResult[];
}> {
  const searchQuery = buildSearchQuery(params);
  const searchArgs = buildSearchArgs(params);
  const { stdout } = await execFileAsync(csPath, searchArgs, {
    cwd: ctx.cwd,
    signal: ctx.signal,
  });

  return {
    searchQuery,
    searchArgs,
    parsedResults: parseSearchResults(stdout),
  };
}

function parseSearchResults(stdout: string): CsSearchResult[] {
  const parsed = JSON.parse(stdout) as CsSearchResult[] | null;
  return Array.isArray(parsed) ? parsed : [];
}

function getResultLineNumber(result: CsSearchResult): number | null {
  if (typeof result.line_number === "number") {
    return result.line_number;
  }

  const firstLineNumber = result.lines?.find(
    (line) => typeof line.line_number === "number",
  )?.line_number;

  return typeof firstLineNumber === "number" ? firstLineNumber : null;
}

function getResultSnippet(result: CsSearchResult): string {
  if (result.snippet?.trim()) {
    return result.snippet.trim();
  }

  if (result.content?.trim()) {
    return result.content.trim();
  }

  const firstLineContent = result.lines?.find(
    (line) =>
      typeof line.content === "string" && line.content.trim().length > 0,
  )?.content;

  return firstLineContent?.trim() || "";
}

function getResultLines(result: CsSearchResult): NormalizedLineResult[] {
  return (
    result.lines
      ?.map((line) => ({
        line: typeof line.line_number === "number" ? line.line_number : null,
        content: line.content?.trim() || "",
      }))
      .filter((line) => line.content.length > 0) || []
  );
}

function summarizeResult(result: CsSearchResult, index: number): string {
  const path = toComparablePath(result);
  const lineNumber = getResultLineNumber(result);
  const location = lineNumber ? `${path}:${lineNumber}` : path;
  const snippet = getResultSnippet(result) || "(no snippet)";
  const score = result.score === undefined ? "" : ` [score: ${result.score}]`;
  const lines = getResultLines(result);
  const lineDetails = lines.map(
    ({ line, content }) => `   ${line === null ? "?" : line}: ${content}`,
  );

  return [
    `${index + 1}. ${location}${score}`,
    `   ${snippet}`,
    ...lineDetails,
  ].join("\n");
}

function formatResults(
  params: CsSearchParams,
  results: CsSearchResult[],
): string {
  if (results.length === 0) {
    return [
      "No ranked results found.",
      `query: ${params.query}`,
      "Try a shorter query, an English keyword, or use rg for exact text.",
    ].join("\n");
  }

  return [
    `Top ${results.length} ranked result${results.length === 1 ? "" : "s"} for: ${params.query}`,
    ...results.map(summarizeResult),
    "Next step: read the most relevant file(s) for full context.",
  ].join("\n\n");
}

async function executeSearch(
  ctx: ExtensionContext,
  params: CsSearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const csPath = await findCsBinary();

  if (!csPath) {
    return textResult(
      "cs_search is unavailable because the cs binary is not installed.",
      { available: false },
    );
  }

  const initialSearch = await runSearch(csPath, ctx, params);
  let finalSearch = initialSearch;
  let fallbackSearch: Awaited<ReturnType<typeof runSearch>> | null = null;

  if (params.path && initialSearch.parsedResults.length === 0) {
    fallbackSearch = await runSearch(csPath, ctx, {
      ...params,
      path: undefined,
    });
    finalSearch = fallbackSearch;
  }

  const maxResults = Math.min(params.max_results ?? DEFAULT_MAX_RESULTS, 10);
  const topResults = finalSearch.parsedResults.slice(0, maxResults);

  return textResult(formatResults(params, topResults), {
    available: true,
    query: params.query,
    effective_query: finalSearch.searchQuery,
    applied_flags: finalSearch.searchArgs.slice(1, -2),
    kind: params.kind ?? "auto",
    path: params.path ?? null,
    language: params.language ?? null,
    max_results: maxResults,
    total_results: finalSearch.parsedResults.length,
    fallback_applied: Boolean(fallbackSearch),
    initial_effective_query: initialSearch.searchQuery,
    initial_total_results: initialSearch.parsedResults.length,
    fallback_effective_query: fallbackSearch?.searchQuery ?? null,
    fallback_total_results: fallbackSearch?.parsedResults.length ?? null,
    results: topResults.map((result) => ({
      path: toComparablePath(result),
      line: getResultLineNumber(result),
      score: result.score ?? null,
      snippet: getResultSnippet(result),
      lines: getResultLines(result),
    })),
  });
}

export default function csSearchExtension(pi: ExtensionAPI) {
  let toolRegistered = false;

  const registerTool = (): void => {
    if (toolRegistered) {
      return;
    }

    pi.registerTool({
      name: TOOL_NAME,
      label: "CS Search",
      description:
        "Run ranked structural code search via boyter/cs to find the most relevant implementation, declaration, usage, comment, or string match.",
      promptSnippet:
        "cs_search: ranked likely code locations for implementations, definitions, usages, comments, and strings; best used before read.",
      promptGuidelines: [
        "Use cs_search when you need the most likely implementation, declaration, usage, comment, or string match for a concept, feature, or behavior.",
        "Prefer short noun-phrase queries like 'create worktree', 'auth middleware', or 'retry backoff' instead of full questions.",
        "Set kind to implementation/declaration/usage/comment/string when you know the intent; leave it auto when uncertain.",
        "Start with query first; add language when helpful, and use path only after you have confirmed the real repo directory.",
        "For unique identifiers like feature names, extension names, or command names, the first cs_search should usually omit path.",
        "Use path or language to narrow large repos only as a second-pass refinement, and ask for max_results 3 to 5 when you want candidates to compare before calling read.",
        "Recommended flow: call cs_search first, then read the top result or the best 2 to 3 candidates for full context.",
        "Use rg instead when you need exact text, regex matches, exhaustive results, or a precise error string.",
      ],
      parameters: toolParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return executeSearch(ctx, params as CsSearchParams);
      },
    });

    toolRegistered = true;
  };

  pi.on("session_start", async (_event, _ctx) => {
    const csPath = await findCsBinary();
    log.info("checking cs binary", { csPath });
    if (!csPath) {
      log.info("cs binary not found; skipping registration");
      return;
    }

    log.info("cs binary found; registering tool", { csPath });
    registerTool();
  });
}
