import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildForwardMessageHtml,
  buildSummaryPrompt,
  buildTelegramMessageLink,
  checkRelevanceFromSummary,
  loadFilterCheckpoint,
  matchKeywords,
  parseLlmResponse,
  parseTgFilterOutput,
  saveFilterCheckpoint,
  selectSubagentLlmOutput,
  selectTgExportJsonOutput,
  shouldUpdateCheckpointAfterForward,
} from "./telegram-channel-filter.ts";

// ── Keyword matching (pure) ─────────────────────────

describe("matchKeywords", () => {
  const keywords = ["debug", "ebpf", "rust", "性能优化", "kernel"];

  it("returns match: true when any keyword is found (case-insensitive)", () => {
    const result = matchKeywords(
      "This is a DEBUG post about tracing",
      keywords,
    );
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("debug");
  });

  it("matches Chinese keywords", () => {
    const result = matchKeywords("这篇讲性能优化的实践", keywords);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("性能优化");
  });

  it("returns match: false when no keyword is found", () => {
    const result = matchKeywords("Just a random post about cooking", keywords);
    expect(result.matched).toBe(false);
    expect(result.matchedKeywords).toHaveLength(0);
  });

  it("handles empty content", () => {
    const result = matchKeywords("", keywords);
    expect(result.matched).toBe(false);
  });

  it("handles empty keywords list", () => {
    const result = matchKeywords("debug is here", []);
    expect(result.matched).toBe(false);
  });

  it("matches multiple keywords", () => {
    const result = matchKeywords("rust kernel ebpf trace", keywords);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toHaveLength(3);
  });

  it("is case-insensitive", () => {
    const result = matchKeywords("EBPF and Kernel", keywords);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("ebpf");
    expect(result.matchedKeywords).toContain("kernel");
  });
});

// ── Relevance check from LLM summary (pure) ───────────

describe("checkRelevanceFromSummary", () => {
  const topics = ["debug", "ebpf", "内存管理", "性能优化"];

  it("returns relevant when topic found (case-insensitive)", () => {
    const result = checkRelevanceFromSummary(
      "这篇关于 eBPF 性能优化的文章",
      topics,
    );
    expect(result.relevant).toBe(true);
    expect(result.matchedTopics).toContain("ebpf");
    expect(result.matchedTopics).toContain("性能优化");
  });

  it("returns not relevant when no topic found", () => {
    const result = checkRelevanceFromSummary(
      "今天天气不错，适合出去玩",
      topics,
    );
    expect(result.relevant).toBe(false);
    expect(result.matchedTopics).toHaveLength(0);
  });

  it("handles empty summary", () => {
    const result = checkRelevanceFromSummary("", topics);
    expect(result.relevant).toBe(false);
  });

  it("handles empty topics", () => {
    const result = checkRelevanceFromSummary("eBPF debug", []);
    expect(result.relevant).toBe(false);
  });
});

// ── LLM prompt building (pure) ───────────────────────

describe("buildSummaryPrompt", () => {
  it("includes the message content", () => {
    const prompt = buildSummaryPrompt("cilium/ebpf ringbuf merged");
    expect(prompt).toContain("cilium/ebpf ringbuf merged");
  });

  it("asks for Chinese summary", () => {
    const prompt = buildSummaryPrompt("test");
    expect(prompt).toContain("中文");
  });

  it("truncates long content", () => {
    const longContent = "x".repeat(3000);
    const prompt = buildSummaryPrompt(longContent);
    expect(prompt).toContain("x".repeat(2000));
    expect(prompt).not.toContain("x".repeat(2001));
  });
});

// ── Subagent output selection (pure) ─────────────────

describe("selectSubagentLlmOutput", () => {
  it("uses extracted summary from Pi JSON-mode output when available", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "event" }],
      },
    });
    const summary = '{"summary":"ok","topics":["eBPF"],"relevant":true}';

    expect(selectSubagentLlmOutput(stdout, summary)).toBe(summary);
  });

  it("falls back to stdout when summary is missing", () => {
    const stdout = '{"summary":"ok","topics":[],"relevant":true}';

    expect(selectSubagentLlmOutput(stdout, undefined)).toBe(stdout);
  });
});

// ── LLM response parsing (pure) ──────────────────────

describe("parseLlmResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      summary: "cilium/ebpf 的 zero-copy ringbuf 终于合并",
      topics: ["eBPF", "性能优化", "Go"],
      relevant: true,
    });
    const result = parseLlmResponse(response);
    expect(result.summary).toBe("cilium/ebpf 的 zero-copy ringbuf 终于合并");
    expect(result.topics).toEqual(["eBPF", "性能优化", "Go"]);
    expect(result.relevant).toBe(true);
  });

  it("handles irrelevant messages", () => {
    const response = JSON.stringify({
      summary: "今天天气不错",
      topics: ["生活"],
      relevant: false,
    });
    const result = parseLlmResponse(response);
    expect(result.relevant).toBe(false);
  });

  it("handles markdown-wrapped JSON from LLM", () => {
    const response =
      '```json\n{"summary": "test", "topics": ["debug"], "relevant": true}\n```';
    const result = parseLlmResponse(response);
    expect(result.summary).toBe("test");
    expect(result.topics).toEqual(["debug"]);
    expect(result.relevant).toBe(true);
  });

  it("returns defaults for invalid JSON", () => {
    const result = parseLlmResponse("some random text without json");
    expect(result.summary).toBe("");
    expect(result.topics).toEqual([]);
    expect(result.relevant).toBe(false);
  });

  it("returns defaults for malformed JSON", () => {
    const result = parseLlmResponse("{invalid json}");
    expect(result.summary).toBe("");
    expect(result.topics).toEqual([]);
    expect(result.relevant).toBe(false);
  });

  it("handles partial fields gracefully", () => {
    const response = JSON.stringify({ summary: "test" });
    const result = parseLlmResponse(response);
    expect(result.summary).toBe("test");
    expect(result.topics).toEqual([]);
    expect(result.relevant).toBe(false);
  });
});

// ── Forward message formatting (pure) ────────────────

describe("buildTelegramMessageLink", () => {
  it("builds a stable permalink from configured channel username", () => {
    const link = buildTelegramMessageLink(
      { title: "Welcome to the Black Parade", username: "TheB1ackParade" },
      "1082",
    );

    expect(link).toBe("https://t.me/TheB1ackParade/1082");
  });

  it("accepts usernames with @ prefix", () => {
    const link = buildTelegramMessageLink(
      { title: "Welcome to the Black Parade", username: "@TheB1ackParade" },
      "1082",
    );

    expect(link).toBe("https://t.me/TheB1ackParade/1082");
  });
});

describe("buildForwardMessageHtml", () => {
  const source = {
    title: "Welcome to the Black Parade",
    username: "TheB1ackParade",
  };

  it("sends original text with the source message link and hides LLM summary", () => {
    const result = buildForwardMessageHtml({
      message: {
        id: "1082",
        content: "original eBPF post",
        timestamp: "2026-06-30T12:00:00Z",
        channel: source.title,
        llmSummary: "summary should not be sent",
      },
      source,
    });

    expect(result.html).toContain("original eBPF post");
    expect(result.html).toContain("https://t.me/TheB1ackParade/1082");
    expect(result.html).not.toContain("summary should not be sent");
    expect(result.truncated).toBe(false);
  });

  it("truncates by final Telegram HTML length while preserving the link", () => {
    const result = buildForwardMessageHtml({
      message: {
        id: "1082",
        content: `**${"x".repeat(500)}**`,
        timestamp: "2026-06-30T12:00:00Z",
        channel: source.title,
      },
      source,
      maxHtmlLength: 180,
    });

    expect(result.html.length).toBeLessThanOrEqual(180);
    expect(result.html).toContain("https://t.me/TheB1ackParade/1082");
    expect(result.html).toContain("…");
    expect(result.truncated).toBe(true);
  });
});

describe("shouldUpdateCheckpointAfterForward", () => {
  it("updates checkpoint only when all relevant messages were forwarded", () => {
    expect(shouldUpdateCheckpointAfterForward(false)).toBe(true);
    expect(shouldUpdateCheckpointAfterForward(true)).toBe(false);
  });
});

// ── Checkpoint (IO, but testable with temp files) ───

describe("loadFilterCheckpoint / saveFilterCheckpoint", () => {
  it("returns empty map when file does not exist", () => {
    const state = loadFilterCheckpoint("/nonexistent/path.json");
    expect(state).toEqual(new Map());
  });

  it("round-trips checkpoint state", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-filter-test-"));
    const path = join(dir, "checkpoint.json");
    try {
      const state = new Map([
        ["channel1", "msg100"],
        ["channel2", "msg200"],
      ]);
      saveFilterCheckpoint(state, path);
      const loaded = loadFilterCheckpoint(path);
      expect(loaded.get("channel1")).toBe("msg100");
      expect(loaded.get("channel2")).toBe("msg200");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty map for corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-filter-test-"));
    const path = join(dir, "corrupt.json");
    try {
      writeFileSync(path, "not-json{", "utf-8");
      const state = loadFilterCheckpoint(path);
      expect(state).toEqual(new Map());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories on save", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-filter-test-"));
    const nested = join(dir, "sub", "nested", "checkpoint.json");
    try {
      const state = new Map([["ch", "msg1"]]);
      saveFilterCheckpoint(state, nested);
      expect(existsSync(nested)).toBe(true);
      const loaded = loadFilterCheckpoint(nested);
      expect(loaded.get("ch")).toBe("msg1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── tg export output selection ───────────────────────

describe("selectTgExportJsonOutput", () => {
  it("uses stdout when tg writes JSON there", () => {
    const stdout = '[{"msg_id":1,"content":"from stdout"}]';
    const stderr = "progress logs";

    expect(selectTgExportJsonOutput(stdout, stderr)).toBe(stdout);
  });

  it("falls back to stderr when stdout is empty", () => {
    const stderr = '[{"msg_id":2,"content":"from stderr"}]';

    expect(selectTgExportJsonOutput("", stderr)).toBe(stderr);
  });

  it("falls back to stderr when stdout is only whitespace", () => {
    const stderr = '[{"msg_id":3,"content":"from stderr"}]';

    expect(selectTgExportJsonOutput("\n  ", stderr)).toBe(stderr);
  });
});

// ── JSON parsing ─────────────────────────────────────

describe("parseTgFilterOutput", () => {
  it("parses valid tg filter JSON output", () => {
    const json = JSON.stringify({
      ok: true,
      data: [
        {
          msg_id: 100,
          content: "debug post",
          timestamp: "2026-06-30T10:00:00Z",
          chat_name: "Test Channel",
        },
      ],
    });
    const result = parseTgFilterOutput(json);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("100");
    expect(result[0].content).toBe("debug post");
    expect(result[0].channel).toBe("Test Channel");
  });

  it("throws on failed tg filter output", () => {
    const json = JSON.stringify({ ok: false, error: "chat_not_found" });
    expect(() => parseTgFilterOutput(json)).toThrow("tg filter failed");
  });

  it("parses raw array format from tg export", () => {
    const json = JSON.stringify([
      {
        msg_id: 200,
        content: "export message",
        timestamp: "2026-06-30T12:00:00Z",
        chat_name: "Export Channel",
      },
    ]);
    const result = parseTgFilterOutput(json);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("200");
    expect(result[0].content).toBe("export message");
    expect(result[0].channel).toBe("Export Channel");
  });

  it("parses tg export output with raw newlines inside message content", () => {
    const json = `[
      {
        "msg_id": 201,
        "content": "first line
second line",
        "timestamp": "2026-06-30T12:00:00Z",
        "chat_name": "Export Channel"
      }
    ]`;

    const result = parseTgFilterOutput(json);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("201");
    expect(result[0].content).toBe("first line\nsecond line");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTgFilterOutput("not-json")).toThrow();
  });
});
