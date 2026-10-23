import { describe, expect, it } from "vitest";
import {
  type BtwActive,
  type BtwExchange,
  capHistory,
  clampScroll,
  currentSelection,
  extractTextContent,
  FOLLOW_BOTTOM,
  formatInjectedPayload,
  formatThread,
  isScrollable,
  MAX_HISTORY_EXCHANGES,
  scrollByLines,
} from "./core.js";

// core.ts 是纯逻辑层：无 IO、无 TUI、无会话依赖，测试不需要任何 mock。

describe("currentSelection", () => {
  it("优先展示正在回答中的交换", () => {
    const active: BtwActive = {
      question: "q",
      answer: "partial",
      toolName: null,
    };
    const selection = currentSelection(active, [], 0);
    expect(selection?.label).toBe("answering…");
    expect(selection?.question).toBe("q");
  });

  it("历史为空时返回 null", () => {
    expect(currentSelection(null, [], 0)).toBeNull();
  });

  it("展示 viewIndex 指向的历史交换，并带序号 label", () => {
    const exchanges: BtwExchange[] = [
      { question: "a", answer: "1" },
      { question: "b", answer: "2" },
    ];
    const selection = currentSelection(null, exchanges, 1);
    expect(selection?.label).toBe("2/2");
    expect(selection?.question).toBe("b");
    expect(selection?.answer).toBe("2");
  });

  it("aborted / error 交换在 label 带后缀并保留 error", () => {
    const exchanges: BtwExchange[] = [
      { question: "a", answer: "1", aborted: true },
      { question: "b", answer: "2", error: "boom" },
    ];
    expect(currentSelection(null, exchanges, 0)?.label).toContain("(aborted)");
    const errSel = currentSelection(null, exchanges, 1);
    expect(errSel?.label).toContain("(error)");
    expect(errSel?.error).toBe("boom");
  });
});

describe("capHistory", () => {
  it("不超过上限时原样返回", () => {
    const exchanges: BtwExchange[] = [{ question: "a", answer: "1" }];
    expect(capHistory(exchanges, 0)).toEqual({ exchanges, viewIndex: 0 });
  });

  it("超过上限时裁掉最老的一批并同步 viewIndex", () => {
    const exchanges: BtwExchange[] = Array.from(
      { length: MAX_HISTORY_EXCHANGES + 5 },
      (_, i) => ({
        question: `q${i}`,
        answer: `a${i}`,
      }),
    );
    const { exchanges: pruned, viewIndex } = capHistory(
      exchanges,
      exchanges.length - 1,
    );
    expect(pruned).toHaveLength(MAX_HISTORY_EXCHANGES);
    expect(pruned[0].question).toBe("q5");
    expect(viewIndex).toBe(exchanges.length - 1 - 5);
  });
});

describe("formatThread", () => {
  it("把每轮 User/Assistant 拼成线程文本", () => {
    const exchanges: BtwExchange[] = [
      { question: "  hi ", answer: "hello" },
      { question: "again?", answer: "yes" },
    ];
    expect(formatThread(exchanges)).toBe(
      "User: hi\nAssistant: hello\n\n---\n\nUser: again?\nAssistant: yes",
    );
  });
});

describe("formatInjectedPayload", () => {
  it("thread 无指令时用默认 intro 和 btw-thread 标签", () => {
    expect(formatInjectedPayload("thread", "body", "")).toBe(
      [
        "Here's a side conversation I had for additional context:",
        "",
        "<btw-thread>",
        "body",
        "</btw-thread>",
      ].join("\n"),
    );
  });

  it("thread 带指令时把指令拼进 intro", () => {
    expect(formatInjectedPayload("thread", "body", "implement this")).toContain(
      "Here's a side conversation I had. implement this",
    );
  });

  it("summary 用 btw-summary 标签", () => {
    expect(formatInjectedPayload("summary", "s", "")).toContain(
      "<btw-summary>\ns\n</btw-summary>",
    );
    expect(formatInjectedPayload("summary", "s", "carry it")).toContain(
      "Here's a summary of a side conversation I had. carry it",
    );
  });
});

describe("clampScroll / scrollByLines", () => {
  const content = 100;
  const rows = 20;
  const maxOffset = content - rows;

  it("跟随尾部时贴在最后一行", () => {
    expect(clampScroll(FOLLOW_BOTTOM, content, rows)).toEqual({
      offset: maxOffset,
      followBottom: true,
    });
  });

  it("内容装得下就停在顶部，也不当作可滚动", () => {
    expect(isScrollable(rows, rows)).toBe(false);
    expect(isScrollable(rows + 1, rows)).toBe(true);
    expect(clampScroll(FOLLOW_BOTTOM, rows, rows)).toEqual({
      offset: 0,
      followBottom: true,
    });
  });

  it("向上滚停在上边界，并停止跟随", () => {
    const once = scrollByLines(FOLLOW_BOTTOM, -5, content, rows);
    expect(once).toEqual({ offset: maxOffset - 5, followBottom: false });

    const past = scrollByLines(once, -500, content, rows);
    expect(past).toEqual({ offset: 0, followBottom: false });
  });

  it("向下滚回底部就恢复跟随", () => {
    const up = scrollByLines(FOLLOW_BOTTOM, -5, content, rows);
    expect(scrollByLines(up, 500, content, rows)).toEqual({
      offset: maxOffset,
      followBottom: true,
    });
  });

  it("流式追加内容时不改变用户停下的位置", () => {
    const scrolled = scrollByLines(FOLLOW_BOTTOM, -5, content, rows);
    expect(clampScroll(scrolled, content + 30, rows)).toEqual({
      offset: maxOffset - 5,
      followBottom: false,
    });
  });
});

describe("extractTextContent", () => {
  it("字符串原样返回", () => {
    expect(extractTextContent("plain")).toBe("plain");
  });

  it("从 TextContent[] 里过滤出 text 并换行拼接", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "b" },
    ];
    expect(extractTextContent(content)).toBe("a\nb");
  });

  it("非字符串非数组返回空串", () => {
    expect(extractTextContent(42)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });
});
