/**
 * DeepSeek 搜索边的行为测试：SSE 事件 → 状态（value in / value out），
 * 以及 source 到跨扩展 DTO 的映射。不联网。
 */

import { describe, expect, it } from "vitest";
import {
  applyDeepSeekStreamEvent,
  buildSearchRequestBody,
  collectSources,
  createDeepSeekStreamState,
  type DeepSeekStreamState,
  formatSources,
  parseDeepSeekErrorMessage,
  toFallbackSources,
} from "./search.ts";

const applyAll = (
  payloads: string[],
  initial: DeepSeekStreamState = createDeepSeekStreamState(),
): DeepSeekStreamState =>
  payloads.reduce(
    (state, payload) => applyDeepSeekStreamEvent(state, payload),
    initial,
  );

const searchBlock = (entries: Array<Record<string, unknown>>) =>
  JSON.stringify({
    type: "content_block_start",
    content_block: { type: "web_search_tool_result", content: entries },
  });

describe("applyDeepSeekStreamEvent", () => {
  it("collects model, tokens, answer text, and sources from one stream", () => {
    const state = applyAll([
      JSON.stringify({
        type: "message_start",
        message: {
          model: "deepseek-v4-flash",
          usage: { input_tokens: 12 },
        },
      }),
      searchBlock([
        {
          type: "web_search_result",
          title: "Node.js releases",
          url: "https://nodejs.org/en/about/previous-releases",
          page_age: "2 days",
        },
      ]),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Node 24 " },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "is the current LTS." },
      }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } }),
    ]);

    expect(state.model).toBe("deepseek-v4-flash");
    expect(state.inputTokens).toBe(12);
    expect(state.outputTokens).toBe(30);
    expect(state.answerParts).toEqual(["Node 24 is the current LTS."]);
    expect(state.sources).toEqual([
      {
        title: "Node.js releases",
        url: "https://nodejs.org/en/about/previous-releases",
        pageAge: "2 days",
      },
    ]);
  });

  it("skips malformed events and the DONE marker without losing prior state", () => {
    const start = applyDeepSeekStreamEvent(
      createDeepSeekStreamState(),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "first" },
      }),
    );

    const afterGarbage = applyDeepSeekStreamEvent(start, "{not json");
    const afterDone = applyDeepSeekStreamEvent(afterGarbage, "[DONE]");

    expect(afterDone.answerParts).toEqual(["first"]);
  });

  it("starts a new answer part only when no part exists yet", () => {
    const state = applyAll([
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "a" },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "b" },
      }),
    ]);

    expect(state.answerParts).toEqual(["ab"]);
  });
});

describe("collectSources", () => {
  it("ignores blocks that are not web search results", () => {
    expect(collectSources({ type: "text", text: "hi" })).toEqual([]);
    expect(collectSources(null)).toEqual([]);
  });

  it("keeps only well-shaped entries and defaults the title", () => {
    expect(
      collectSources({
        type: "web_search_tool_result",
        content: [
          { type: "web_search_result", url: "https://a.example" },
          { type: "other", url: "https://b.example" },
        ],
      }),
    ).toEqual([{ title: "Untitled", url: "https://a.example", pageAge: null }]);
  });
});

describe("toFallbackSources", () => {
  it("drops empty urls, caps the list, and keeps titles usable", () => {
    const sources = toFallbackSources(
      [
        { title: "  ", url: "https://a.example" },
        { title: "Two", url: "https://b.example" },
        { title: "No url", url: "" },
        { title: "Three", url: "https://c.example" },
      ],
      2,
    );

    expect(sources).toEqual([
      { title: "https://a.example", url: "https://a.example", snippet: "" },
      { title: "Two", url: "https://b.example", snippet: "" },
    ]);
  });
});

describe("buildSearchRequestBody", () => {
  it("passes domain filters into the server tool", () => {
    const body = buildSearchRequestBody({
      query: "node lts",
      allowed_domains: ["nodejs.org"],
    });
    const tools = body.tools as Array<Record<string, unknown>>;

    expect(body.messages).toEqual([{ role: "user", content: "node lts" }]);
    expect(tools[0]?.allowed_domains).toEqual(["nodejs.org"]);
    expect(tools[0]?.blocked_domains).toBeUndefined();
  });
});

describe("formatSources", () => {
  it("renders a markdown link list and stays empty when there is nothing", () => {
    expect(formatSources([])).toBe("");
    expect(
      formatSources([
        { title: "Docs", url: "https://a.example", pageAge: null },
      ]),
    ).toContain("1. [Docs](https://a.example)");
  });
});

describe("parseDeepSeekErrorMessage", () => {
  it("reads the API error message", () => {
    expect(
      parseDeepSeekErrorMessage(
        '{"error":{"message":"Insufficient Balance (request_id: abc)"}}',
      ),
    ).toBe("Insufficient Balance (request_id: abc)");
  });

  it("returns undefined for empty, malformed, or message-less bodies", () => {
    expect(parseDeepSeekErrorMessage("")).toBeUndefined();
    expect(parseDeepSeekErrorMessage("not json")).toBeUndefined();
    expect(
      parseDeepSeekErrorMessage('{"error":{"message":"   "}}'),
    ).toBeUndefined();
    expect(parseDeepSeekErrorMessage('{"error":{}}')).toBeUndefined();
  });
});
