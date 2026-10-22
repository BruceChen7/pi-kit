/**
 * web-search-fallback — 两个搜索扩展之间的消息契约（Functional Core + 总线适配）。
 *
 * 背景：`codex-web-search` 是主路径，`deepseek-search` 只在 Codex 已经失败后兜底。
 * 让前者 import 后者的客户端会把两个扩展绑死：任一方改内部实现都会牵动对方，
 * 单测也得把那边的网络栈拖进来。这里改成只在 `pi.events` 上来回三条消息，
 * 双方各自只依赖本文件里的频道名与纯数据 DTO。
 *
 * 时序（probe 是同步的，所以没有 provider 时 0 等待）：
 *   requester  emit(probe)   → provider 同步登记 responder
 *   requester  emit(request) → provider 发一次搜索，emit(result)
 *   requester  按 id 收结果，超时或中断就放弃
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

export const WEB_SEARCH_FALLBACK_PROBE_CHANNEL =
  "pi-kit/web-search-fallback/probe";
export const WEB_SEARCH_FALLBACK_REQUEST_CHANNEL =
  "pi-kit/web-search-fallback/request";
export const WEB_SEARCH_FALLBACK_RESULT_CHANNEL =
  "pi-kit/web-search-fallback/result";

export const DEFAULT_WEB_SEARCH_FALLBACK_TIMEOUT_MS = 65_000;

export type WebSearchFallbackSource = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchFallbackOutcome =
  | {
      ok: true;
      provider: string;
      summary: string;
      sources: WebSearchFallbackSource[];
    }
  | { ok: false; provider: string; error: string };

export type WebSearchFallbackQuery = {
  query: string;
  maxSources: number;
};

export type WebSearchFallbackRequest = WebSearchFallbackQuery & {
  id: string;
};

export type WebSearchFallbackResponse = {
  id: string;
  outcome: WebSearchFallbackOutcome;
};

export type WebSearchFallbackProbe = {
  responder?: string;
};

export type WebSearchFallbackRequester = (
  query: WebSearchFallbackQuery,
  options?: { signal?: AbortSignal },
) => Promise<WebSearchFallbackOutcome | undefined>;

/** 总线只需要这两个方法，方便测试塞假实现。 */
export type WebSearchFallbackBus = Pick<EventBus, "emit" | "on">;

export type ProvideWebSearchFallbackOptions = {
  events: WebSearchFallbackBus;
  provider: string;
  isAvailable: () => boolean;
  runSearch: (
    request: WebSearchFallbackRequest,
  ) => Promise<WebSearchFallbackOutcome>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isSource = (value: unknown): value is WebSearchFallbackSource =>
  isRecord(value) &&
  isText(value.title) &&
  isText(value.url) &&
  isText(value.snippet);

/** 成功与失败两个分支都完整校验；畸形 outcome 一律判否，不让它流到上游读取。 */
const isOutcome = (value: unknown): value is WebSearchFallbackOutcome => {
  if (!isRecord(value) || !isText(value.provider)) {
    return false;
  }
  if (value.ok === true) {
    return (
      isText(value.summary) &&
      Array.isArray(value.sources) &&
      value.sources.every(isSource)
    );
  }
  if (value.ok === false) {
    return isText(value.error);
  }
  return false;
};

const isProbe = (value: unknown): value is WebSearchFallbackProbe =>
  isRecord(value) && (value.responder === undefined || isText(value.responder));

const isRequest = (value: unknown): value is WebSearchFallbackRequest =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.query) &&
  typeof value.maxSources === "number";

const isResponse = (value: unknown): value is WebSearchFallbackResponse =>
  isRecord(value) && isText(value.id) && isOutcome(value.outcome);

/**
 * 创建一个兜底 requester。探测不到 provider 时立刻返回 `undefined`，
 * 让调用方保留原始失败，而不是白等一个超时。
 */
export const createWebSearchFallbackRequester = (options: {
  events: WebSearchFallbackBus;
  timeoutMs?: number;
}): WebSearchFallbackRequester => {
  const { events, timeoutMs = DEFAULT_WEB_SEARCH_FALLBACK_TIMEOUT_MS } =
    options;
  let counter = 0;

  return async (query, callOptions = {}) => {
    const { signal } = callOptions;
    if (signal?.aborted) {
      return undefined;
    }

    const probe: WebSearchFallbackProbe = {};
    events.emit(WEB_SEARCH_FALLBACK_PROBE_CHANNEL, probe);
    if (!probe.responder) {
      return undefined;
    }

    counter += 1;
    const id = `${probe.responder}:${counter}`;

    return await new Promise<WebSearchFallbackOutcome | undefined>(
      (resolve) => {
        let settled = false;

        const finish = (value: WebSearchFallbackOutcome | undefined): void => {
          if (settled) {
            return;
          }
          settled = true;
          stopListening();
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };

        const stopListening = events.on(
          WEB_SEARCH_FALLBACK_RESULT_CHANNEL,
          (payload) => {
            if (!isResponse(payload) || payload.id !== id) {
              return;
            }
            finish(payload.outcome);
          },
        );

        const onAbort = (): void => finish(undefined);
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });

        events.emit(WEB_SEARCH_FALLBACK_REQUEST_CHANNEL, {
          id,
          query: query.query,
          maxSources: query.maxSources,
        } satisfies WebSearchFallbackRequest);
      },
    );
  };
};

/**
 * 注册一个兜底 provider，返回取消注册的函数。
 * provider 不可用时也要应答（`ok: false`），否则 requester 只能等到超时。
 */
export const provideWebSearchFallback = (
  options: ProvideWebSearchFallbackOptions,
): (() => void) => {
  const { events, provider, isAvailable, runSearch } = options;

  const stopProbe = events.on(WEB_SEARCH_FALLBACK_PROBE_CHANNEL, (payload) => {
    if (!isProbe(payload) || !isAvailable()) {
      return;
    }
    payload.responder = provider;
  });

  const stopRequest = events.on(
    WEB_SEARCH_FALLBACK_REQUEST_CHANNEL,
    async (payload) => {
      if (!isRequest(payload)) {
        return;
      }

      let outcome: WebSearchFallbackOutcome;
      if (!isAvailable()) {
        outcome = {
          ok: false,
          provider,
          error: `${provider} search is not enabled`,
        };
      } else {
        try {
          outcome = await runSearch(payload);
        } catch (error) {
          outcome = {
            ok: false,
            provider,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      events.emit(WEB_SEARCH_FALLBACK_RESULT_CHANNEL, {
        id: payload.id,
        outcome,
      } satisfies WebSearchFallbackResponse);
    },
  );

  return () => {
    stopProbe();
    stopRequest();
  };
};
