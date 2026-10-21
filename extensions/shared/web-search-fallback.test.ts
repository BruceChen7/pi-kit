/**
 * web-search-fallback 的行为测试：只断言线上可观察的效果——有没有应答、
 * 结果是否按 id 对上、超时与中断是否清理干净、无人应答时是否 0 等待。
 */

import { describe, expect, it } from "vitest";
import {
  createWebSearchFallbackRequester,
  provideWebSearchFallback,
  WEB_SEARCH_FALLBACK_REQUEST_CHANNEL,
  WEB_SEARCH_FALLBACK_RESULT_CHANNEL,
  type WebSearchFallbackBus,
  type WebSearchFallbackOutcome,
  type WebSearchFallbackRequest,
} from "./web-search-fallback.ts";

type Handler = (data: unknown) => void;

type FakeBus = WebSearchFallbackBus & {
  listenerCount: (channel: string) => number;
  deliver: (channel: string, data: unknown) => void;
  requests: WebSearchFallbackRequest[];
};

const createBus = (): FakeBus => {
  const channels = new Map<string, Set<Handler>>();
  const requests: WebSearchFallbackRequest[] = [];

  const handlersOf = (channel: string): Set<Handler> => {
    const existing = channels.get(channel);
    if (existing) {
      return existing;
    }
    const created = new Set<Handler>();
    channels.set(channel, created);
    return created;
  };

  return {
    requests,
    emit(channel, data) {
      if (channel === WEB_SEARCH_FALLBACK_REQUEST_CHANNEL) {
        requests.push(data as WebSearchFallbackRequest);
      }
      for (const handler of [...handlersOf(channel)]) {
        handler(data);
      }
    },
    on(channel, handler) {
      const set = handlersOf(channel);
      set.add(handler);
      return () => set.delete(handler);
    },
    listenerCount(channel) {
      return handlersOf(channel).size;
    },
    deliver(channel, data) {
      for (const handler of [...handlersOf(channel)]) {
        handler(data);
      }
    },
  };
};

const okOutcome = (summary: string): WebSearchFallbackOutcome => ({
  ok: true,
  provider: "deepseek",
  summary,
  sources: [{ title: "t", url: "https://example.com", snippet: "s" }],
});

describe("createWebSearchFallbackRequester", () => {
  it("无人应答时立刻返回 undefined，且不残留监听", async () => {
    const bus = createBus();
    const request = createWebSearchFallbackRequester({ events: bus });

    const outcome = await request({ query: "q", maxSources: 3 });

    expect(outcome).toBeUndefined();
    expect(bus.requests).toHaveLength(0);
    expect(bus.listenerCount(WEB_SEARCH_FALLBACK_RESULT_CHANNEL)).toBe(0);
  });

  it("有 provider 时发出带 id 的请求并返回它的结果", async () => {
    const bus = createBus();
    const stop = provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => true,
      runSearch: async () => okOutcome("来自 DeepSeek"),
    });
    const request = createWebSearchFallbackRequester({ events: bus });

    const outcome = await request({ query: "q", maxSources: 2 });

    expect(outcome).toEqual(okOutcome("来自 DeepSeek"));
    expect(bus.requests).toHaveLength(1);
    expect(bus.requests[0]?.query).toBe("q");
    expect(bus.requests[0]?.maxSources).toBe(2);
    expect(bus.listenerCount(WEB_SEARCH_FALLBACK_RESULT_CHANNEL)).toBe(0);
    stop();
  });

  it("只认第一个匹配 id 的结果，别的 id 直接忽略", async () => {
    const bus = createBus();
    provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => true,
      runSearch: async () => new Promise<never>(() => {}),
    });
    const request = createWebSearchFallbackRequester({ events: bus });
    const pending = request({ query: "q", maxSources: 1 });

    const id = bus.requests[0]?.id;
    expect(id).toBeTypeOf("string");
    bus.deliver(WEB_SEARCH_FALLBACK_RESULT_CHANNEL, {
      id: "someone-else:1",
      outcome: okOutcome("别人的结果"),
    });
    bus.deliver(WEB_SEARCH_FALLBACK_RESULT_CHANNEL, {
      id,
      outcome: okOutcome("第一个正确结果"),
    });
    bus.deliver(WEB_SEARCH_FALLBACK_RESULT_CHANNEL, {
      id,
      outcome: okOutcome("迟到的结果"),
    });

    expect(await pending).toEqual(okOutcome("第一个正确结果"));
  });

  it("provider 不可用时应答失败而不是让人等超时", async () => {
    const bus = createBus();
    provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => false,
      runSearch: async () => okOutcome("不该被调用"),
    });
    const request = createWebSearchFallbackRequester({ events: bus });

    const outcome = await request({ query: "q", maxSources: 1 });

    expect(outcome).toEqual(undefined);
    expect(bus.requests).toHaveLength(0);
  });

  it("provider 报错时把错误作为 outcome 返回，不抛", async () => {
    const bus = createBus();
    provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => true,
      runSearch: async () => {
        throw new Error("402 Insufficient Balance");
      },
    });
    const request = createWebSearchFallbackRequester({ events: bus });

    const outcome = await request({ query: "q", maxSources: 1 });

    expect(outcome).toEqual({
      ok: false,
      provider: "deepseek",
      error: "402 Insufficient Balance",
    });
  });

  it("超时返回 undefined 并清掉监听", async () => {
    const bus = createBus();
    bus.on(WEB_SEARCH_FALLBACK_REQUEST_CHANNEL, () => {});
    const request = createWebSearchFallbackRequester({
      events: bus,
      timeoutMs: 5,
    });

    const outcome = await request({ query: "q", maxSources: 1 });

    expect(outcome).toBeUndefined();
    expect(bus.listenerCount(WEB_SEARCH_FALLBACK_RESULT_CHANNEL)).toBe(0);
  });

  it("调用前已中断就不发请求；途中中断则放弃等待", async () => {
    const bus = createBus();
    provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => true,
      runSearch: async () => new Promise<never>(() => {}),
    });
    const request = createWebSearchFallbackRequester({ events: bus });

    const preAborted = new AbortController();
    preAborted.abort();
    expect(
      await request(
        { query: "q", maxSources: 1 },
        {
          signal: preAborted.signal,
        },
      ),
    ).toBeUndefined();
    expect(bus.requests).toHaveLength(0);

    const controller = new AbortController();
    const pending = request(
      { query: "q", maxSources: 1 },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(bus.listenerCount(WEB_SEARCH_FALLBACK_RESULT_CHANNEL)).toBe(0);
  });

  it("取消注册后不再应答", async () => {
    const bus = createBus();
    const stop = provideWebSearchFallback({
      events: bus,
      provider: "deepseek",
      isAvailable: () => true,
      runSearch: async () => okOutcome("不该出现"),
    });
    stop();
    const request = createWebSearchFallbackRequester({ events: bus });

    expect(await request({ query: "q", maxSources: 1 })).toBeUndefined();
    expect(bus.requests).toHaveLength(0);
  });
});
