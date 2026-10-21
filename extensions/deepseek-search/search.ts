// DeepSeek 的 Anthropic 兼容端点：HTTP 与 SSE 都在这一层，外面只拿纯数据。
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.ts";
import type { WebSearchFallbackSource } from "../shared/web-search-fallback.ts";

const ANTHROPIC_BASE = "https://api.deepseek.com/anthropic";
export const SEARCH_MODEL =
  process.env.DEEPSEEK_SEARCH_MODEL || "deepseek-v4-flash";
const DEFAULT_MAX_TOKENS = 1500;
const REQUEST_TIMEOUT_MS = 60_000;
const SERVER_TOOL_TYPE = "web_search_20260209";

const log = createLogger("deepseek-search", { stderr: null });

export type SearchSource = {
  title: string;
  url: string;
  pageAge?: string | null;
};

export type DeepSeekSearchParams = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

export type DeepSeekSearchResult = {
  answerParts: string[];
  sources: SearchSource[];
  model: string;
  tokens: number;
};

export type DeepSeekStreamState = {
  answerParts: string[];
  sources: SearchSource[];
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type RunDeepSeekWebSearchOptions = {
  apiKey: string;
  params: DeepSeekSearchParams;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

export const createDeepSeekStreamState = (): DeepSeekStreamState => ({
  answerParts: [],
  sources: [],
  model: "",
  inputTokens: 0,
  outputTokens: 0,
});

export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

export const resolveDeepSeekApiKey = async (
  ctx: ExtensionContext,
): Promise<string> => {
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
};

const getAbortSignal = (signal?: AbortSignal): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
};

export const collectSources = (block: unknown): SearchSource[] => {
  if (
    !isRecord(block) ||
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
};

/**
 * 一条 SSE `data:` 载荷进来，出一条新状态。
 * 畸形事件按原样跳过：搜索结果比一次解析失败重要。
 */
export const applyDeepSeekStreamEvent = (
  state: DeepSeekStreamState,
  payload: string,
): DeepSeekStreamState => {
  if (payload === "[DONE]") {
    return state;
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return state;
  }
  if (!isRecord(event)) {
    return state;
  }

  const next: DeepSeekStreamState = {
    answerParts: [...state.answerParts],
    sources: [...state.sources],
    model: state.model,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
  };

  if (event.type === "message_start" && isRecord(event.message)) {
    if (typeof event.message.model === "string") {
      next.model = event.message.model;
    }
    if (isRecord(event.message.usage)) {
      next.inputTokens = Number(event.message.usage.input_tokens || 0);
    }
  }

  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const added = collectSources(event.content_block);
    if (added.length > 0) {
      next.sources.push(...added);
    }
  }

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const lastIndex = next.answerParts.length - 1;
      if (lastIndex >= 0) {
        next.answerParts[lastIndex] += delta.text;
      } else {
        next.answerParts.push(delta.text);
      }
    }
  }

  if (event.type === "message_delta" && isRecord(event.usage)) {
    next.outputTokens = Number(event.usage.output_tokens || 0);
  }

  return next;
};

export const buildSearchTool = (
  params: DeepSeekSearchParams,
): Record<string, unknown> => {
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
};

export const buildSearchRequestBody = (
  params: DeepSeekSearchParams,
): Record<string, unknown> => ({
  model: SEARCH_MODEL,
  max_tokens: DEFAULT_MAX_TOKENS,
  thinking: { type: "disabled" },
  messages: [{ role: "user", content: params.query }],
  system:
    "You are an assistant for performing a web search tool use. Return only the search results as plain text. Never output function_calls, invoke, or tool_call XML tags.",
  tools: [buildSearchTool(params)],
});

/**
 * DeepSeek 的错误体不一定能解析：代理、编码、空体都会让 JSON 解析失败。
 * 这里永远给出一个非空的原因，否则兜底会退化成一个没有信息的 402。
 */
export const parseDeepSeekErrorMessage = (text: string): string | undefined => {
  try {
    const payload = JSON.parse(text) as { error?: { message?: unknown } };
    const message = payload.error?.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

export const readDeepSeekError = async (
  response: Response,
): Promise<string> => {
  const text = await response.text().catch(() => "");
  return (
    parseDeepSeekErrorMessage(text) ||
    response.statusText ||
    text.slice(0, 200) ||
    "no detail in the response"
  );
};

export const formatSources = (sources: SearchSource[]): string => {
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
};

export const toFallbackSources = (
  sources: SearchSource[],
  maxSources: number,
): WebSearchFallbackSource[] =>
  sources
    .filter((source) => source.url.length > 0)
    .slice(0, Math.max(1, maxSources))
    .map((source) => ({
      title: source.title.trim() || source.url,
      url: source.url,
      snippet: "",
    }));

export const runDeepSeekWebSearch = async (
  options: RunDeepSeekWebSearchOptions,
): Promise<DeepSeekSearchResult> => {
  const { apiKey, params, signal, onProgress } = options;
  const body = buildSearchRequestBody(params);

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
      "accept-encoding": "identity",
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
  let state = createDeepSeekStreamState();
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

      const previousSources = state.sources.length;
      state = applyDeepSeekStreamEvent(state, line.slice(6));
      const added = state.sources.length - previousSources;
      if (added > 0) {
        onProgress?.(`Found ${added} result${added === 1 ? "" : "s"}…`);
        log.debug("DeepSeek search result block received", {
          resultCount: added,
          totalSources: state.sources.length,
        });
      }
    }
  }

  const result: DeepSeekSearchResult = {
    answerParts: state.answerParts,
    sources: state.sources,
    model: state.model || SEARCH_MODEL,
    tokens: state.inputTokens + state.outputTokens,
  };

  log.info("DeepSeek Anthropic search request completed", {
    model: result.model,
    sourceCount: result.sources.length,
    tokens: result.tokens,
    elapsedMs: Date.now() - startedAt,
  });

  return result;
};
