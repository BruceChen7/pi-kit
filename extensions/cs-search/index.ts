import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("cs-search", { stderr: null });

const TOOL_NAME = "cs_search";
const DEFAULT_MAX_RESULTS = 3;

const KIND_HINTS: Record<NonNullable<CsSearchParams["kind"]>, string | null> = {
  implementation: "implementation concrete logic behavior",
  declaration: "declaration definition exported symbol interface type",
  usage: "usage callsite invocation reference",
  comment: "comment documentation explanation",
  string: "string literal error message text",
  auto: null,
};

type ShellContext = {
  shell?: {
    which?: (name: string) => Promise<string | null>;
    execFile?: (
      command: string,
      args: string[],
      options?: {
        cwd?: string;
        signal?: AbortSignal;
      },
    ) => Promise<{ stdout: string; stderr?: string }>;
  };
};

type Shell = NonNullable<ShellContext["shell"]>;

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

type CsSearchResult = {
  filename?: string;
  location?: string;
  line_number?: number;
  snippet?: string;
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

function getShell(ctx: ExtensionContext): ShellContext["shell"] {
  return (ctx as ShellContext).shell;
}

function hasBinaryLookup(shell: ShellContext["shell"]): shell is Shell {
  return typeof shell?.which === "function";
}

async function findCsBinary(
  shell: ShellContext["shell"],
): Promise<string | null> {
  return shell?.which?.("cs") ?? null;
}

function toComparablePath(result: CsSearchResult): string {
  return result.location || result.filename || "";
}

function normalizeLanguage(language: string | undefined): string | undefined {
  return language?.trim().replace(/^\./, "").toLowerCase() || undefined;
}

function buildSearchQuery(params: CsSearchParams): string {
  const parts = [params.query.trim()];

  const kindHint = params.kind ? KIND_HINTS[params.kind] : null;
  if (kindHint) {
    parts.push(kindHint);
  }

  if (params.explain_query?.trim()) {
    parts.push(params.explain_query.trim());
  }

  return parts.join(" ");
}

function filterResults(
  results: CsSearchResult[],
  params: CsSearchParams,
): CsSearchResult[] {
  const pathFilter = params.path?.trim().replace(/^\.\//, "");
  const languageFilter = normalizeLanguage(params.language);

  return results.filter((result) => {
    const comparablePath = toComparablePath(result);

    if (pathFilter && !comparablePath.startsWith(pathFilter)) {
      return false;
    }

    if (!languageFilter) {
      return true;
    }

    const lowerPath = comparablePath.toLowerCase();
    return (
      lowerPath.endsWith(`.${languageFilter}`) ||
      lowerPath.includes(`.${languageFilter}.`)
    );
  });
}

function summarizeResult(result: CsSearchResult, index: number): string {
  const path = toComparablePath(result);
  const location = result.line_number ? `${path}:${result.line_number}` : path;
  const snippet = result.snippet?.trim() || "(no snippet)";
  const score = result.score === undefined ? "" : ` [score: ${result.score}]`;

  return `${index + 1}. ${location}${score}\n   ${snippet}`;
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
  const shell = getShell(ctx);
  const csPath = await findCsBinary(shell);
  const execFile = shell?.execFile;

  if (!csPath || !execFile) {
    return textResult(
      "cs_search is unavailable because the cs binary is not installed.",
      { available: false },
    );
  }

  const searchQuery = buildSearchQuery(params);
  const { stdout } = await execFile(csPath, [searchQuery, "--format", "json"], {
    cwd: ctx.cwd,
    signal: ctx.signal,
  });
  const parsedResults = JSON.parse(stdout) as CsSearchResult[];
  const filteredResults = filterResults(parsedResults, params);
  const maxResults = Math.min(params.max_results ?? DEFAULT_MAX_RESULTS, 10);
  const topResults = filteredResults.slice(0, maxResults);

  return textResult(formatResults(params, topResults), {
    available: true,
    query: params.query,
    effective_query: searchQuery,
    kind: params.kind ?? "auto",
    path: params.path ?? null,
    language: params.language ?? null,
    max_results: maxResults,
    total_results: filteredResults.length,
    results: topResults.map((result) => ({
      path: toComparablePath(result),
      line: result.line_number ?? null,
      score: result.score ?? null,
      snippet: result.snippet?.trim() || "",
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
        "Use path or language to narrow large repos, and ask for max_results 3 to 5 when you want candidates to compare before calling read.",
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

  pi.on("session_start", async (_event, ctx) => {
    const shell = getShell(ctx);
    if (!hasBinaryLookup(shell)) {
      log.warn("cs binary detection unavailable; skipping registration");
      return;
    }

    const csPath = await findCsBinary(shell);
    if (!csPath) {
      log.info("cs binary not found; skipping registration");
      return;
    }

    log.info("cs binary found; registering tool", { csPath });
    registerTool();
  });
}
