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
import type { PickerOption } from "../shared/picker-core.ts";
import { CHAPTER_PICKER_NEW_ID } from "./notes-core.ts";
import { registerNotes } from "./notes-store.ts";

type EventHandler = (event: never, ctx: never) => unknown;
type ToolExecute = (...args: never[]) => unknown;

/** 假 UI 的「学习者选中行」：真 picker 结算的是整行（见 notes-store 的 showPicker）。 */
const newChapterRow: PickerOption = {
  id: CHAPTER_PICKER_NEW_ID,
  label: "＋ 新建章节…",
  value: CHAPTER_PICKER_NEW_ID,
  kind: "other",
};

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
  fire: (event: string, payload: unknown) => Promise<unknown[]>;
  toolCall: (toolName: string, input: unknown) => Promise<unknown>;
  bind: (toolCallId: string, chapter: string) => Promise<void>;
  bindCancelled: (toolCallId: string, chapter: string) => Promise<void>;
  runCommand: (name: string, args: string) => Promise<void>;
  topicDir: string;
  readChapter: (prefix: string) => string;
  ctx: never;
};

/** 假会话日志：pi 在消息定稿前就把条目追加进去，backfill 读的就是这一份。 */
const setup = (
  topic: string,
  options: { bindAtStart?: boolean } = {},
): Harness => {
  const handlers = new Map<string, EventHandler[]>();
  const tools = new Map<string, { execute: ToolExecute }>();
  const commands = new Map<string, (args: string, ctx: never) => unknown>();
  const entries: Array<Record<string, unknown>> =
    options.bindAtStart === false
      ? []
      : [
          {
            type: "custom",
            customType: "tutor-notes",
            data: { file: path.join(vault, "Learn", topic, `${topic}.md`) },
          },
        ];
  registerNotes({
    registerTool: (tool: { name: string }) => {
      tools.set(tool.name, tool as never);
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: never) => unknown },
    ) => {
      commands.set(name, command.handler);
    },
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: () => {},
    getSessionName: () => "已有名字",
    setSessionName: () => {},
  } as never);

  /** 落点 gate 会弹章节 picker：默认模拟学习者接受 agent 的提议（新建章节）。 */
  let proposedChapter: string | undefined;
  let nextPick: PickerOption | undefined = newChapterRow;
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
    sessionManager: { getEntries: () => entries },
  };

  const fire = async (event: string, payload: unknown): Promise<unknown[]> => {
    if (event === "message_end") {
      const message = (payload as { message?: unknown }).message;
      entries.push({ type: "message", message });
    }
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload as never, ctx as never));
    }
    return results;
  };

  /** 一次工具调用的判定：第一个非空 handler 返回值（pi 的 `{ block, reason }`）。 */
  const toolCall = async (
    toolName: string,
    input: unknown,
  ): Promise<unknown> => {
    const results = await fire("tool_call", {
      type: "tool_call",
      toolName,
      toolCallId: `call-${toolName}`,
      input,
    });
    return results.find((result) => result !== undefined);
  };

  /** 人敲的斜杠命令（`/md-topic`、`/md-log`）：与真实 handler 同一个入口。 */
  const runCommand = async (name: string, args: string): Promise<void> => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`${name} 未注册`);
    await handler(args, ctx as never);
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
    toolCall,
    bind,
    runCommand,
    /** 学习者 Esc 的 bind：同一个流程，但 picker 返回取消。 */
    bindCancelled: async (toolCallId: string, chapter: string) => {
      nextPick = undefined;
      try {
        await bind(toolCallId, chapter);
      } finally {
        nextPick = newChapterRow;
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

describe("镜像接线 / 单写入口（一个会话只写一章）", () => {
  const blocked = (value: unknown): { block?: boolean; reason?: string } =>
    (value ?? {}) as { block?: boolean; reason?: string };

  it("绑定 01 时写 02：拦，理由点名当前章节", async () => {
    const h = setup("单写入口");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    const verdict = blocked(
      await h.toolCall("write", {
        path: path.join(h.topicDir, "02-第二章.md"),
        content: "第2章正文",
      }),
    );
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("第1章 · 第一章");
    expect(verdict.reason).toContain("bind_notes");
  });

  it("绑定章本身不能手写正文；补一行重讲标题放行", async () => {
    const h = setup("单写入口二");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");
    const boundFile = path.join(h.topicDir, "01-第一章.md");

    expect(
      blocked(
        await h.toolCall("write", { path: boundFile, content: "再写一遍" }),
      ).block,
    ).toBe(true);
    expect(
      await h.toolCall("edit", {
        path: boundFile,
        oldText: "第一遍的正文。",
        newText: "### C1-1 · 换角度：换个入口\n\n第一遍的正文。",
      }),
    ).toBeUndefined();
  });

  it("索引页与概念表放行", async () => {
    const h = setup("单写入口三");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    expect(
      await h.toolCall("write", {
        path: path.join(h.topicDir, "单写入口三.md"),
        content: "索引页的已知边界",
      }),
    ).toBeUndefined();
    expect(
      await h.toolCall("write", {
        path: path.join(h.topicDir, "概念.md"),
        content: "概念表",
      }),
    ).toBeUndefined();
  });

  it("bash 追写章节文件被拦，读章节文件放行", async () => {
    const h = setup("单写入口四");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    expect(
      blocked(
        await h.toolCall("bash", { command: "echo 补测 >> 01-第一章.md" }),
      ).block,
    ).toBe(true);
    expect(
      await h.toolCall("bash", { command: "grep -n quiz 01-第一章.md" }),
    ).toBeUndefined();
  });

  it("patch 载荷（multi-edit 的 apply_patch 形状）同样被拦", async () => {
    const h = setup("单写入口五");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    const verdict = blocked(
      await h.toolCall("edit", {
        patch: [
          "*** Begin Patch",
          `*** Update File: ${path.join(h.topicDir, "02-第二章.md")}`,
          "@@",
          "-旧",
          "+新",
          "*** End Patch",
        ].join("\n"),
      }),
    );
    expect(verdict.block).toBe(true);
  });
});

describe("镜像接线 / 供应商工具调用残留", () => {
  /**
   * 实录（2026-10-13 第10章）：provider 把 `check_concepts` 调用写进了 content，
   * `finish_reason` 报 stop——pi 没有这种方言的解析器，整块 markup 成了 assistant
   * 的 text part。镜像只追加不改写，所以必须在写盘前按形状丢掉。
   */
  const leaked = [
    "切换本身便宜到几乎不用计数。",
    "",
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="codemode">',
    '<｜｜DSML｜｜ parameter name="code" string="true">const R = "/opt/homebrew/Cellar/go/1.25.5/libexec/src/runtime";',
    "const [goe] = await Promise.all([",
    "  tools.bash({ command: `cd /opt/homebrew/Cellar/go/1.25.5/libexec/src/runtime && echo '=== goexit ==='`, timeout: null }),",
    "]);",
    "text(goe.output);",
    "</｜｜DSML｜｜ parameter>",
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ calls>",
  ].join("\n");

  it("落盘前丢掉泄漏的调用块，正文照写", async () => {
    const h = setup("镜像泄漏");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire("message_end", assistantMessage(leaked));

    const chapter = h.readChapter("01-");
    expect(chapter).toContain("切换本身便宜到几乎不用计数。");
    expect(chapter).not.toContain("DSML");
    expect(chapter).not.toContain("tools.bash");
  });

  it("整条消息只有泄漏块：不写出空的 PI 块", async () => {
    const h = setup("镜像纯泄漏");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire(
      "message_end",
      assistantMessage(leaked.split("\n").slice(2).join("\n")),
    );

    const chapter = h.readChapter("01-");
    expect(chapter).not.toContain("DSML");
    expect(chapter).not.toContain("> [!abstract] PI");
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

describe("镜像接线 / 换绑不重放历史（回填的归属）", () => {
  /**
   * 实录（2026-10-27，Kafka实现 第6/7章）：会话先绑在第7章，教完第6章补测后
   * 人敲 `/md-topic Kafka实现 控制面` 换绑第6章——`/md-topic` 的 backfill 把整个
   * 会话重放了一遍，第6章补测那四块于是同时躺在 06 与 07 两个文件里。
   * 已经镜像过的块有主了，换绑不能把它们再投影一份到新章节。
   */
  it("换绑另一章：已镜像的块不写进新章节", async () => {
    const h = setup("镜像重放");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");

    await h.fire("message_end", assistantMessage("第一章补测的说明。"));
    await h.runCommand("md-topic", "镜像重放 第二章");

    expect(h.readChapter("01-")).toContain("第一章补测的说明。");
    expect(h.readChapter("02-")).not.toContain("第一章补测的说明。");
  });

  it("绑定前那段没镜像过的会话照样回填（会话先聊、后绑笔记）", async () => {
    const h = setup("镜像开场", { bindAtStart: false });
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "先聊两句。" }],
      },
    });
    await h.fire("message_end", assistantMessage("绑定前的回答。"));

    const target = path.join(h.topicDir, "开场笔记.md");
    fs.mkdirSync(h.topicDir, { recursive: true });
    fs.writeFileSync(target, "# 开场笔记\n", "utf-8");
    await h.runCommand("md-log", target);

    const note = fs.readFileSync(target, "utf-8");
    expect(note).toContain("先聊两句。");
    expect(note).toContain("绑定前的回答。");
  });

  it("反复换绑不累积：同一块在文件里只出现一次", async () => {
    const h = setup("镜像重复绑");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");
    await h.fire("message_end", assistantMessage("只该写一次。"));
    await h.runCommand("md-topic", "镜像重复绑 第二章");
    await h.runCommand("md-topic", "镜像重复绑 第一章");

    const chapter = h.readChapter("01-");
    expect(chapter.split("只该写一次。").length - 1).toBe(1);
  });

  it("解绑之后那一段照样回填，绑着时写过的块不重写", async () => {
    const h = setup("镜像解绑");
    await h.fire("session_start", { type: "session_start" });
    await h.bind("b1", "第一章");
    await h.fire("message_end", assistantMessage("绑着时写的。"));
    await h.runCommand("md-unlog", "");
    await h.fire("message_end", assistantMessage("解绑后写的。"));

    const target = path.join(h.topicDir, "01-第一章.md");
    await h.runCommand("md-log", target);

    const chapter = h.readChapter("01-");
    expect(chapter.split("绑着时写的。").length - 1).toBe(1);
    expect(chapter.split("解绑后写的。").length - 1).toBe(1);
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
