/**
 * 镜像接线的集成测试：用假 pi 按**真实事件顺序**喂事件，断言块落在哪个文件、顺序如何。
 *
 * 要守住的契约（pi 的顺序是「消息定稿 → 工具执行」）：
 *   一条消息里同时有正文和 `bind_notes` 调用时，正文属于**新**章节，
 *   而不是它落盘那一刻还绑着的旧章节。
 *
 * 只断言落盘结果（哪个文件里有哪段文字、先后顺序），不断言内部调用编排。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTER_PICKER_NEW_ID } from "./notes-core.ts";
import { registerNotes } from "./notes-store.ts";

type EventHandler = (event: never, ctx: never) => unknown;
type ToolExecute = (...args: never[]) => unknown;

let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-mirror-"));
  vault = path.join(root, "vault");
  cwd = path.join(root, "cwd");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "third_extension_settings.json"),
    JSON.stringify({ tutor: { vaultRoot: vault, topDir: "Learn" } }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

type Harness = {
  fire: (event: string, payload: unknown) => Promise<void>;
  bind: (toolCallId: string, chapter: string) => Promise<void>;
  bindCancelled: (toolCallId: string, chapter: string) => Promise<void>;
  topicDir: string;
  readChapter: (prefix: string) => string;
  ctx: never;
};

const setup = (topic: string): Harness => {
  const handlers = new Map<string, EventHandler[]>();
  const tools = new Map<string, { execute: ToolExecute }>();
  registerNotes({
    registerTool: (tool: { name: string }) => {
      tools.set(tool.name, tool as never);
    },
    registerCommand: () => {},
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: () => {},
    getSessionName: () => "已有名字",
    setSessionName: () => {},
  } as never);

  /** 落点 gate 会弹章节 picker：默认模拟学习者接受 agent 的提议（新建章节）。 */
  let proposedChapter: string | undefined;
  let nextPick: string | undefined = CHAPTER_PICKER_NEW_ID;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      custom: async () => nextPick,
      input: async () => proposedChapter,
    },
    // 会话已经绑定到这个主题的索引页（等价于学习者先跑过 /md-topic 选完主题）：
    // 镜像测试要验的是「绑定切换时块落在哪」，不是 picker 本身。
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "tutor-notes",
          data: { file: path.join(vault, "Learn", topic, `${topic}.md`) },
        },
      ],
    },
  };

  const fire = async (event: string, payload: unknown): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload as never, ctx as never);
    }
  };

  const bindTool = tools.get("bind_notes");
  if (!bindTool) throw new Error("bind_notes 未注册");
  /** 按 pi 的真实顺序跑一次 bind：tool_call → execute → tool_result。 */
  const bind = async (toolCallId: string, chapter: string): Promise<void> => {
    const params = { topic, chapter };
    proposedChapter = chapter;
    await fire("tool_call", {
      type: "tool_call",
      toolName: "bind_notes",
      toolCallId,
      input: params,
    });
    const result = (await bindTool.execute(
      toolCallId as never,
      params as never,
      undefined as never,
      undefined as never,
      ctx as never,
    )) as { details?: unknown; isError?: boolean };
    await fire("tool_result", {
      type: "tool_result",
      toolName: "bind_notes",
      toolCallId,
      input: params,
      details: result?.details,
      isError: result?.isError ?? false,
    });
  };

  const topicDir = path.join(vault, "Learn", topic);
  const readChapter = (prefix: string): string => {
    const file = fs
      .readdirSync(topicDir)
      .find((name) => name.startsWith(prefix));
    if (!file) throw new Error(`找不到 ${prefix} 章节文件`);
    return fs.readFileSync(path.join(topicDir, file), "utf-8");
  };

  return {
    fire,
    bind,
    /** 学习者 Esc 的 bind：同一个流程，但 picker 返回取消。 */
    bindCancelled: async (toolCallId: string, chapter: string) => {
      nextPick = undefined;
      try {
        await bind(toolCallId, chapter);
      } finally {
        nextPick = CHAPTER_PICKER_NEW_ID;
      }
    },
    topicDir,
    readChapter,
    ctx: ctx as never,
  };
};

/** 一条 assistant 消息：正文 + 可选的工具调用块。 */
const assistantMessage = (
  text: string,
  ...toolCalls: Array<{ id: string; name: string; arguments?: unknown }>
) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    ],
  },
});

describe("镜像接线 / 同轮 bind 的块归属", () => {
  it("同轮 bind 新章节：正文落在新章节文件，不落旧文件", async () => {
    const h = setup("镜像归属");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire(
      "message_end",
      assistantMessage("## 第2章 · 第二章\n\n本章正文。", {
        id: "b2",
        name: "bind_notes",
        arguments: { topic: "镜像归属", chapter: "第二章" },
      }),
    );
    await h.bind("b2", "第二章");

    expect(h.readChapter("02-")).toContain("本章正文。");
    expect(h.readChapter("01-")).not.toContain("本章正文。");
  });

  it("关闸期间到来的题面块排在正文之后（顺序不乱）", async () => {
    const h = setup("镜像顺序");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire(
      "message_end",
      assistantMessage("## 第2章 · 第二章\n\n本章正文。", {
        id: "b2",
        name: "bind_notes",
        arguments: { topic: "镜像顺序", chapter: "第二章" },
      }),
    );
    // quiz 是 sequential：它的题面块在 bind 结果之前就可能上屏。
    await h.fire("tool_call", {
      type: "tool_call",
      toolName: "ask_user_question",
      toolCallId: "q1",
      input: {
        question: "这道题问什么？",
        options: [{ label: "甲" }, { label: "乙" }],
      },
    });
    await h.bind("b2", "第二章");

    const chapter = h.readChapter("02-");
    expect(chapter.indexOf("本章正文。")).toBeGreaterThan(-1);
    expect(chapter.indexOf("本章正文。")).toBeLessThan(
      chapter.indexOf("这道题问什么？"),
    );
  });

  it("兜底：bind 的结果一直没来，turn_end 也要把正文写出去", async () => {
    const h = setup("镜像兜底");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire(
      "message_end",
      assistantMessage("## 第2章 · 第二章\n\n本章正文。", {
        id: "b2",
        name: "bind_notes",
        arguments: { topic: "镜像兜底", chapter: "第二章" },
      }),
    );
    expect(h.readChapter("01-")).not.toContain("本章正文。");

    await h.fire("turn_end", { type: "turn_end" });

    // 宁可落在旧文件，绝不丢字。
    expect(h.readChapter("01-")).toContain("本章正文。");
  });

  it("回归：不带 bind 的消息立即写入当前章节", async () => {
    const h = setup("镜像回归");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire("message_end", assistantMessage("第一章的正文。"));
    expect(h.readChapter("01-")).toContain("第一章的正文。");
  });
});

describe("镜像接线 / 首轮注入不落笔记", () => {
  it("tutor-brief 是角色 custom 的注入消息：不进笔记（也不清空已绑定的文件）", async () => {
    const h = setup("镜像注入");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire("message_end", {
      type: "message_end",
      message: {
        role: "custom",
        customType: "tutor-brief",
        content: [{ type: "text", text: "[tutor] 本会话已绑定《镜像注入》" }],
      },
    });

    const chapter = h.readChapter("01-");
    expect(chapter).not.toContain("[tutor]");
    expect(chapter).not.toContain("本会话已绑定");
  });
});

describe("镜像接线 / 落点被取消", () => {
  it("学习者 Esc：不新建章节，扣住的正文落在原来那章（绝不丢字）", async () => {
    const h = setup("镜像取消");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire(
      "message_end",
      assistantMessage("第二章的正文。", {
        id: "b2",
        name: "bind_notes",
        arguments: { topic: "镜像取消", chapter: "第二章" },
      }),
    );
    await h.bindCancelled("b2", "第二章");

    // 没有 02-第二章.md：落点没被确认
    expect(fs.readdirSync(h.topicDir).sort()).toEqual([
      "01-第一章.md",
      "镜像取消.md",
    ]);
    // 正文没丢，落在原来那章
    expect(h.readChapter("01-")).toContain("第二章的正文。");
  });
});
