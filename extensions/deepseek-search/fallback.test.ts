/**
 * 跨扩展兜底链路：codex-web-search 失败 → 总线请求 → deepseek-search 应答。
 * 网络用假 fetch，只验「谁能应答、结果怎么回到 web_search」这段接线。
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true }));

vi.mock("../shared/settings.ts", () => ({
  getGlobalSettingsPath: () => "/test/.pi/agent/third_extension_settings.json",
  loadGlobalSettings: () => ({
    globalPath: "/test/.pi/agent/third_extension_settings.json",
    global: { deepseekSearch: { enabled: state.enabled } },
  }),
  writeSettingsFile: () => undefined,
}));

import { executeCodexWebSearch } from "../codex-web-search/codex.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../codex-web-search/settings.ts";
import { createWebSearchFallbackRequester } from "../shared/web-search-fallback.ts";
import deepseekSearchExtension from "./index.ts";

const DEEPSEEK_SSE = [
  'data: {"type":"message_start","message":{"model":"deepseek-v4-flash","usage":{"input_tokens":11}}}',
  "",
  'data: {"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","title":"Node.js releases","url":"https://nodejs.org/en/about/previous-releases","page_age":"3 days"}]}}',
  "",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Node 24 is the current LTS."}}',
  "",
  'data: {"type":"message_delta","usage":{"output_tokens":7}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const bootDeepSeek = async () => {
  const events = createEventBus();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

  deepseekSearchExtension({
    events,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  } as never);

  await handlers.get("session_start")?.(
    { reason: "start" },
    {
      cwd: process.cwd(),
      modelRegistry: {
        getApiKeyForProvider: async (provider: string) =>
          provider === "deepseek" ? "test-key" : undefined,
      },
      ui: { notify: () => undefined },
    },
  );

  return events;
};

const failingCodex = async () => {
  throw new Error("Codex exec failed: stream disconnected before completion");
};

describe("deepseek fallback over the extension bus", () => {
  beforeEach(() => {
    state.enabled = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the DeepSeek answer after Codex fails", async () => {
    vi.stubGlobal("fetch", async () =>
      Promise.resolve(
        new Response(DEEPSEEK_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const events = await bootDeepSeek();
    const result = await executeCodexWebSearch(
      { query: "latest node lts", mode: "fast" },
      {
        cwd: process.cwd(),
        settings: { ...DEFAULT_WEB_SEARCH_SETTINGS },
        runner: failingCodex,
        fallback: createWebSearchFallbackRequester({ events }),
      },
    );

    expect(result.details.deepseekFallback).toEqual({
      provider: "deepseek",
      reason: expect.stringContaining("stream disconnected"),
      sourceCount: 1,
    });
    expect(result.details.failure).toBeUndefined();
    expect(result.details.sources).toEqual([
      {
        title: "Node.js releases",
        url: "https://nodejs.org/en/about/previous-releases",
        snippet: "",
      },
    ]);
    expect(result.content[0]?.text).toContain(
      "This result comes from the deepseek fallback",
    );
    expect(result.content[0]?.text).toContain("Node 24 is the current LTS.");
  });

  it("stays out of the way when the user never enabled DeepSeek search", async () => {
    state.enabled = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const events = await bootDeepSeek();
    const result = await executeCodexWebSearch(
      { query: "latest node lts", mode: "fast" },
      {
        cwd: process.cwd(),
        settings: { ...DEFAULT_WEB_SEARCH_SETTINGS },
        runner: failingCodex,
        fallback: createWebSearchFallbackRequester({ events }),
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.details.deepseekFallback).toBeUndefined();
    expect(result.details.failure?.kind).toBe("transport");
  });

  it("keeps the failure path when the requester has no provider at all", async () => {
    const events = createEventBus();
    const result = await executeCodexWebSearch(
      { query: "latest node lts", mode: "fast" },
      {
        cwd: process.cwd(),
        settings: { ...DEFAULT_WEB_SEARCH_SETTINGS },
        runner: failingCodex,
        fallback: createWebSearchFallbackRequester({ events }),
      },
    );

    expect(result.details.deepseekFallback).toBeUndefined();
    expect(result.details.failure?.kind).toBe("transport");
  });
});
