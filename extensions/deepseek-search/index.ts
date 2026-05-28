import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.ts";

const ANTHROPIC_BASE = "https://api.deepseek.com/anthropic";
const SEARCH_MODEL = process.env.DEEPSEEK_SEARCH_MODEL || "deepseek-v4-flash";
const TOOL_NAME =
  process.env.DEEPSEEK_SEARCH_TOOL_NAME || "deepseek_web_search";
const DEFAULT_MAX_TOKENS = 1500;
const REQUEST_TIMEOUT_MS = 60_000;
const SERVER_TOOL_TYPE = "web_search_20260209";

const log = createLogger("deepseek-search", { stderr: null });

type SearchSource = {
  title: string;
  url: string;
  pageAge?: string | null;
};

type CallAnthropicOptions = {
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

type CallAnthropicResult = {
  answerParts: string[];
  sources: SearchSource[];
  model: string;
  tokens: number;
};

type DeepSeekSearchParams = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

type ToolDetails = Record<string, unknown>;

type ToolErrorResult = AgentToolResult<ToolDetails> & { isError: true };

const webSearchParams = Type.Object({
  query: Type.String({
    minLength: 2,
    description: "The search query. Be specific and include relevant keywords.",
  }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict results to these domains (e.g. ['python.org']). Cannot combine with blocked_domains.",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude these domains from results. Cannot combine with allowed_domains.",
    }),
  ),
});

async function resolveApiKey(ctx: ExtensionContext): Promise<string> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
  if (key) {
    log.debug("resolved DeepSeek API key from model registry");
    return key;
  }

  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicToken) {
    log.debug("resolved DeepSeek API key from ANTHROPIC_AUTH_TOKEN fallback");
    return anthropicToken;
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    log.debug("resolved DeepSeek API key from DEEPSEEK_API_KEY fallback");
    return deepseekKey;
  }

  log.warn("DeepSeek API key not found");
  throw new Error(
    "No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.",
  );
}

function getAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function collectSources(block: Record<string, unknown>): SearchSource[] {
  if (
    block.type !== "web_search_tool_result" ||
    !Array.isArray(block.content)
  ) {
    return [];
  }

  const sources: SearchSource[] = [];
  for (const entry of block.content) {
    if (!isRecord(entry) || entry.type !== "web_search_result") {
      continue;
    }

    sources.push({
      title: typeof entry.title === "string" ? entry.title : "Untitled",
      url: typeof entry.url === "string" ? entry.url : "",
      pageAge: typeof entry.page_age === "string" ? entry.page_age : null,
    });
  }

  return sources;
}

function textResult(
  text: string,
  details: ToolDetails = {},
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(text: string): ToolErrorResult {
  return {
    ...textResult(text),
    isError: true,
  };
}

function notifyProgress(
  onUpdate: AgentToolUpdateCallback<ToolDetails> | undefined,
  text: string,
): void {
  onUpdate?.(textResult(text));
}

async function readDeepSeekError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function callAnthropic({
  apiKey,
  body,
  signal,
  onProgress,
}: CallAnthropicOptions): Promise<CallAnthropicResult> {
  log.info("DeepSeek Anthropic search request started", {
    model: body.model,
    serverTool: SERVER_TOOL_TYPE,
    maxTokens: body.max_tokens,
  });

  const startedAt = Date.now();
  const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: getAbortSignal(signal),
  });

  if (!response.ok) {
    const detail = await readDeepSeekError(response);
    log.warn("DeepSeek Anthropic search request failed", {
      status: response.status,
      detail,
      elapsedMs: Date.now() - startedAt,
    });
    throw new Error(`DeepSeek API ${response.status}: ${detail}`);
  }

  if (!response.body) {
    log.warn("DeepSeek Anthropic search response had no body");
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const answerParts: string[] = [];
  const sources: SearchSource[] = [];
  let modelName = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6);
      if (data === "[DONE]") {
        continue;
      }

      try {
        const event = JSON.parse(data);
        if (!isRecord(event)) {
          continue;
        }

        if (event.type === "message_start" && isRecord(event.message)) {
          if (typeof event.message.model === "string") {
            modelName = event.message.model;
          }
          if (isRecord(event.message.usage)) {
            inputTokens = Number(event.message.usage.input_tokens || 0);
          }
        }

        if (
          event.type === "content_block_start" &&
          isRecord(event.content_block)
        ) {
          const newSources = collectSources(event.content_block);
          if (newSources.length > 0) {
            sources.push(...newSources);
            onProgress?.(
              `Found ${newSources.length} result${newSources.length === 1 ? "" : "s"}…`,
            );
            log.debug("DeepSeek search result block received", {
              resultCount: newSources.length,
              totalSources: sources.length,
            });
          }
        }

        if (event.type === "content_block_delta" && isRecord(event.delta)) {
          const delta = event.delta;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            const lastIndex = answerParts.length - 1;
            if (lastIndex >= 0) {
              answerParts[lastIndex] += delta.text;
            } else {
              answerParts.push(delta.text);
            }
          }
        }

        if (event.type === "message_delta" && isRecord(event.usage)) {
          outputTokens = Number(event.usage.output_tokens || 0);
        }
      } catch (error) {
        log.debug("Skipping malformed DeepSeek stream event", {
          error: readErrorMessage(error),
        });
      }
    }
  }

  const result = {
    answerParts,
    sources,
    model: modelName || SEARCH_MODEL,
    tokens: inputTokens + outputTokens,
  };

  log.info("DeepSeek Anthropic search request completed", {
    model: result.model,
    sourceCount: result.sources.length,
    tokens: result.tokens,
    elapsedMs: Date.now() - startedAt,
  });

  return result;
}

function formatSources(sources: SearchSource[]): string {
  if (sources.length === 0) {
    return "";
  }

  return [
    "",
    "Links:",
    ...sources.map(
      (source, index) =>
        `${index + 1}. [${source.title}](${source.url})${source.pageAge ? ` (${source.pageAge})` : ""}`,
    ),
  ].join("\n");
}

function buildSearchTool(
  params: DeepSeekSearchParams,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: SERVER_TOOL_TYPE,
    name: "web_search",
    max_uses: 8,
  };

  if (params.allowed_domains?.length) {
    tool.allowed_domains = params.allowed_domains;
  }
  if (params.blocked_domains?.length) {
    tool.blocked_domains = params.blocked_domains;
  }

  return tool;
}

function buildSearchRequestBody(
  query: string,
  params: DeepSeekSearchParams,
): Record<string, unknown> {
  return {
    model: SEARCH_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: query }],
    system:
      "You are an assistant for performing a web search tool use. Return only the search results as plain text. Never output function_calls, invoke, or tool_call XML tags.",
    tools: [buildSearchTool(params)],
  };
}

const citationReminder =
  "\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

export default function deepseekSearchExtension(pi: ExtensionAPI) {
  log.info("deepseek-search extension loaded", {
    toolName: TOOL_NAME,
    searchModel: SEARCH_MODEL,
    endpoint: ANTHROPIC_BASE,
  });

  let toolRegistered = false;

  const registerSearchTool = (): void => {
    if (toolRegistered) {
      log.debug("deepseek-search tool already registered", {
        toolName: TOOL_NAME,
      });
      return;
    }

    pi.registerTool({
      name: TOOL_NAME,
      label: "DeepSeek Web Search",
      description: `Search the web via DeepSeek server-side web search. Returns results with titles, URLs, and a brief summary. The current date is ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })} — use the current year for recent queries.`,
      promptSnippet: `${TOOL_NAME}: search the web via DeepSeek. Returns results with titles, URLs, and a brief summary.`,
      promptGuidelines: [
        `Use ${TOOL_NAME} when DeepSeek-backed current or source-backed web information is needed.`,
        `After receiving ${TOOL_NAME} results, synthesize a clear answer and cite sources with markdown hyperlinks.`,
      ],
      parameters: webSearchParams,
      renderCall(args, theme) {
        const params = args as DeepSeekSearchParams;
        let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
        text += theme.fg("accent", `"${params.query || "..."}"`);

        const tags: string[] = [];
        if (params.allowed_domains?.length) {
          tags.push(`+${params.allowed_domains.length}d`);
        }
        if (params.blocked_domains?.length) {
          tags.push(`-${params.blocked_domains.length}d`);
        }
        if (tags.length) {
          text += ` ${theme.fg("dim", tags.join(" "))}`;
        }

        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const first = result.content[0];
        const body = first?.type === "text" ? first.text : "";
        const clean = body.replace(/\n*REMINDER:.*$/s, "");
        const lines = clean.split("\n");

        if (!expanded) {
          const preview = lines.slice(0, 6);
          if (lines.length > 6) {
            preview.push(
              theme.fg(
                "dim",
                `... ${lines.length - 6} more lines · ctrl+o to expand`,
              ),
            );
          }
          return new Text(preview.join("\n"), 0, 0);
        }

        return new Text(clean, 0, 0);
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const searchParams = params as DeepSeekSearchParams;
        const query = searchParams.query?.trim();
        if (!query) {
          log.warn("DeepSeek search rejected empty query");
          return errorResult("Error: query is required.");
        }

        notifyProgress(onUpdate, "Searching DeepSeek…");
        log.info("DeepSeek search tool execution started", {
          query,
          allowedDomains: searchParams.allowed_domains?.length ?? 0,
          blockedDomains: searchParams.blocked_domains?.length ?? 0,
        });

        let firstProgress = true;
        const onProgress = (message: string): void => {
          if (!firstProgress) {
            return;
          }
          notifyProgress(onUpdate, message);
          firstProgress = false;
        };

        try {
          const apiKey = await resolveApiKey(ctx);
          const result = await callAnthropic({
            apiKey,
            body: buildSearchRequestBody(query, searchParams),
            signal,
            onProgress,
          });

          const answer =
            result.answerParts.join("\n\n") || `No results for: ${query}`;
          const sourceText =
            answer + formatSources(result.sources) + citationReminder;
          const footer = `\n\n*${result.tokens.toLocaleString()} tokens · ${result.model}*`;

          log.info("DeepSeek search tool execution completed", {
            query,
            sourceCount: result.sources.length,
            tokens: result.tokens,
            model: result.model,
          });

          return textResult(sourceText + footer, { sources: result.sources });
        } catch (error) {
          const message = readErrorMessage(error);
          log.warn("DeepSeek search tool execution failed", {
            query,
            error: message,
          });
          return errorResult(`Search failed: ${message}`);
        }
      },
    });
    toolRegistered = true;
    log.info("deepseek-search tool registered", {
      toolName: TOOL_NAME,
      searchModel: SEARCH_MODEL,
    });
  };

  pi.on("session_start", async (event, ctx) => {
    try {
      await resolveApiKey(ctx);
      log.info("deepseek-search available for session", {
        reason: event.reason,
        cwd: ctx.cwd,
        toolName: TOOL_NAME,
        searchModel: SEARCH_MODEL,
      });
      registerSearchTool();
    } catch (error) {
      log.warn("deepseek-search unavailable for session", {
        reason: event.reason,
        cwd: ctx.cwd,
        error: readErrorMessage(error),
      });
    }
  });
}
