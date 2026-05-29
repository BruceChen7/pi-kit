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

type SearchAttempt = {
  kind: "initial" | "fallback";
  params: CsSearchParams;
};

type SearchExecution = {
  searchQuery: string;
  searchArgs: string[];
  parsedResults: CsSearchResult[];
};

type SearchFailureKind = "exec_failed" | "invalid_output";

type SearchFailure = {
  kind: SearchFailureKind;
  message: string;
};

type SearchAttemptResult =
  | {
      status: "ok";
      attempt: SearchAttempt;
      execution: SearchExecution;
    }
  | {
      status: "error";
      attempt: SearchAttempt;
      error: SearchFailure;
    };

type SearchPlanDecision = {
  attempts: SearchAttempt[];
  maxResults: number;
};

type SearchOutcome = {
  availability: "available" | "unavailable";
  params: CsSearchParams;
  plan?: SearchPlanDecision;
  initialAttempt?: SearchAttemptResult;
  fallbackAttempt?: SearchAttemptResult | null;
  finalAttempt?: SearchAttemptResult;
  topResults?: Array<{
    path: string;
    line: number | null;
    score: number | null;
    snippet: string;
    lines: NormalizedLineResult[];
  }>;
  finalFailure?: SearchFailure;
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

export function buildSearchQuery(params: CsSearchParams): string {
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

export function buildSearchArgs(params: CsSearchParams): string[] {
  const kind = params.kind ?? "auto";
  return [buildSearchQuery(params), ...KIND_FLAGS[kind], "--format", "json"];
}

export function decideSearchPlan(params: CsSearchParams): SearchPlanDecision {
  const maxResults = Math.min(params.max_results ?? DEFAULT_MAX_RESULTS, 10);
  const attempts: SearchAttempt[] = [{ kind: "initial", params }];

  if (params.path) {
    attempts.push({
      kind: "fallback",
      params: { ...params, path: undefined },
    });
  }

  return { attempts, maxResults };
}

async function runSearch(
  csPath: string,
  ctx: ExtensionContext,
  attempt: SearchAttempt,
): Promise<SearchAttemptResult> {
  const searchQuery = buildSearchQuery(attempt.params);
  const searchArgs = buildSearchArgs(attempt.params);

  try {
    const { stdout } = await execFileAsync(csPath, searchArgs, {
      cwd: ctx.cwd,
      signal: ctx.signal,
    });

    return {
      status: "ok",
      attempt,
      execution: {
        searchQuery,
        searchArgs,
        parsedResults: parseSearchResults(stdout),
      },
    };
  } catch (error) {
    return {
      status: "error",
      attempt,
      error: translateSearchError(error),
    };
  }
}

function translateSearchError(error: unknown): SearchFailure {
  if (error instanceof SyntaxError) {
    return {
      kind: "invalid_output",
      message: error.message,
    };
  }

  return {
    kind: "exec_failed",
    message: error instanceof Error ? error.message : String(error),
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

function buildUnavailableResponse(
  params: CsSearchParams,
): AgentToolResult<Record<string, unknown>> {
  return textResult(
    "cs_search is unavailable because the cs binary is not installed. Install it with: go install github.com/boyter/cs/v3@latest",
    {
      available: false,
      query: params.query,
      outcome: "unavailable",
    },
  );
}

export function chooseSearchOutcome(
  params: CsSearchParams,
  plan: SearchPlanDecision,
  attempts: SearchAttemptResult[],
): SearchOutcome {
  const [initialAttempt, fallbackAttempt = null] = attempts;
  const finalAttempt =
    initialAttempt?.status === "ok" &&
    initialAttempt.execution.parsedResults.length === 0 &&
    fallbackAttempt?.status === "ok"
      ? fallbackAttempt
      : initialAttempt;

  if (!finalAttempt) {
    return {
      availability: "available",
      params,
      plan,
      initialAttempt,
      fallbackAttempt,
      finalFailure: {
        kind: "exec_failed",
        message: "search did not execute",
      },
    };
  }

  if (finalAttempt.status === "error") {
    return {
      availability: "available",
      params,
      plan,
      initialAttempt,
      fallbackAttempt,
      finalAttempt,
      finalFailure: finalAttempt.error,
    };
  }

  const topResults = finalAttempt.execution.parsedResults
    .slice(0, plan.maxResults)
    .map((result) => ({
      path: toComparablePath(result),
      line: getResultLineNumber(result),
      score: result.score ?? null,
      snippet: getResultSnippet(result),
      lines: getResultLines(result),
    }));

  return {
    availability: "available",
    params,
    plan,
    initialAttempt,
    fallbackAttempt,
    finalAttempt,
    topResults,
  };
}

export function buildSearchResponse(
  outcome: SearchOutcome,
): AgentToolResult<Record<string, unknown>> {
  if (outcome.availability === "unavailable") {
    return buildUnavailableResponse(outcome.params);
  }

  if (outcome.finalFailure) {
    const errorLabel =
      outcome.finalFailure.kind === "invalid_output"
        ? "invalid cs JSON output"
        : "cs execution failed";

    return textResult(
      `cs_search failed: ${errorLabel}.\nquery: ${outcome.params.query}\nTry a shorter query, a different path filter, or use rg for exact text.`,
      {
        available: true,
        query: outcome.params.query,
        outcome: outcome.finalFailure.kind,
        error: outcome.finalFailure.message,
        kind: outcome.params.kind ?? "auto",
        path: outcome.params.path ?? null,
        language: outcome.params.language ?? null,
        max_results: outcome.plan?.maxResults ?? DEFAULT_MAX_RESULTS,
        fallback_applied: outcome.fallbackAttempt?.status === "ok",
        initial_effective_query:
          outcome.initialAttempt?.status === "ok"
            ? outcome.initialAttempt.execution.searchQuery
            : null,
        initial_total_results:
          outcome.initialAttempt?.status === "ok"
            ? outcome.initialAttempt.execution.parsedResults.length
            : null,
        fallback_effective_query:
          outcome.fallbackAttempt?.status === "ok"
            ? outcome.fallbackAttempt.execution.searchQuery
            : null,
        fallback_total_results:
          outcome.fallbackAttempt?.status === "ok"
            ? outcome.fallbackAttempt.execution.parsedResults.length
            : null,
        results: [],
      },
    );
  }

  const finalAttempt = outcome.finalAttempt;
  const initialAttempt = outcome.initialAttempt;
  const fallbackAttempt = outcome.fallbackAttempt;
  const topResults = outcome.topResults ?? [];
  const finalExecution =
    finalAttempt?.status === "ok" ? finalAttempt.execution : null;
  const initialExecution =
    initialAttempt?.status === "ok" ? initialAttempt.execution : null;
  const fallbackExecution =
    fallbackAttempt?.status === "ok" ? fallbackAttempt.execution : null;

  return textResult(
    formatResults(
      outcome.params,
      finalExecution?.parsedResults.slice(0, outcome.plan?.maxResults) ?? [],
    ),
    {
      available: true,
      query: outcome.params.query,
      outcome: "ok",
      effective_query: finalExecution?.searchQuery ?? null,
      applied_flags: finalExecution?.searchArgs.slice(1, -2) ?? [],
      kind: outcome.params.kind ?? "auto",
      path: outcome.params.path ?? null,
      language: outcome.params.language ?? null,
      max_results: outcome.plan?.maxResults ?? DEFAULT_MAX_RESULTS,
      total_results: finalExecution?.parsedResults.length ?? 0,
      fallback_applied: Boolean(
        fallbackExecution && finalAttempt?.attempt.kind === "fallback",
      ),
      initial_effective_query: initialExecution?.searchQuery ?? null,
      initial_total_results: initialExecution?.parsedResults.length ?? null,
      fallback_effective_query: fallbackExecution?.searchQuery ?? null,
      fallback_total_results: fallbackExecution?.parsedResults.length ?? null,
      results: topResults,
    },
  );
}

async function executeSearch(
  ctx: ExtensionContext,
  params: CsSearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const csPath = await findCsBinary();

  if (!csPath) {
    return buildUnavailableResponse(params);
  }

  const plan = decideSearchPlan(params);
  const attempts: SearchAttemptResult[] = [];

  for (const attempt of plan.attempts) {
    const result = await runSearch(csPath, ctx, attempt);
    attempts.push(result);

    if (result.status === "error") {
      break;
    }

    if (
      result.attempt.kind === "initial" &&
      result.execution.parsedResults.length === 0 &&
      plan.attempts.length > 1
    ) {
      continue;
    }

    break;
  }

  return buildSearchResponse(chooseSearchOutcome(params, plan, attempts));
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
