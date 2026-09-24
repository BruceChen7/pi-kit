/**
 * bind_notes 的落点 gate 集成测试（Shell：只测接缝）。
 *
 * 契约：教学内容落到哪个主题 / 哪个章节**只能由学习者在 picker 里选定**——
 * 插件不做名字匹配、不替人决定，也不会在学习者没选的情况下写盘。
 *
 * 这里只断言看得见的效果：磁盘上出了什么文件、会话里落了什么条目、
 * 工具返回的文案里说了什么；不断言内部调用编排（picker 自身的按键逻辑
 * 由 topic-picker.integration.test.ts 覆盖）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNotes } from "./notes-store.ts";

type ToolExecute = (
  id: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: never,
) => Promise<{
  content: Array<{ text?: string }>;
  details?: Record<string, unknown>;
  isError: boolean;
}>;

let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-bind-gate-"));
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

const topicDir = (topic: string): string => path.join(vault, "Learn", topic);

const seedTopic = (topic: string, chapters: string[]): void => {
  const dir = topicDir(topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), `# ${topic}\n`);
  chapters.forEach((name, index) => {
    fs.writeFileSync(
      path.join(dir, `${String(index + 1).padStart(2, "0")}-${name}.md`),
      `# 第${index + 1}章 · ${name}\n`,
    );
  });
};

const boundEntry = (topic: string) => ({
  type: "custom",
  customType: "tutor-notes",
  data: { file: path.join(topicDir(topic), `${topic}.md`) },
});

type Harness = {
  bind: (params: {
    topic: string;
    chapter?: string;
  }) => Promise<Awaited<ReturnType<ToolExecute>>>;
  runCommand: (name: string, args: string) => Promise<void>;
  custom: ReturnType<typeof vi.fn>;
  onBindingChange: ReturnType<typeof vi.fn>;
  entries: Array<{ customType: string; data: unknown }>;
};

const setup = (options: {
  entries?: readonly unknown[];
  /** 非 TUI（print / json / rpc）走「交回对话」那条路。 */
  mode?: "tui" | "print";
  /** `ctx.ui.custom` 的返回值队列（每次 picker 消费一个）。 */
  picks?: Array<string | undefined>;
  /** `ctx.ui.input` 的返回值队列（「＋新建主题/章节…」消费一个）。 */
  inputs?: Array<string | undefined>;
}): Harness => {
  const tools = new Map<string, { execute: ToolExecute }>();
  const commands = new Map<string, (args: string, ctx: never) => unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const onBindingChange = vi.fn();
  const notify = vi.fn();
  registerNotes(
    {
      registerTool: (tool: { name: string }) =>
        tools.set(tool.name, tool as unknown as { execute: ToolExecute }),
      registerCommand: (
        name: string,
        options: { handler: (args: string, ctx: never) => unknown },
      ) => {
        commands.set(name, options.handler);
      },
      on: () => {},
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ customType, data });
      },
      getSessionName: () => undefined,
      setSessionName: () => {},
    } as never,
    { onBindingChange },
  );

  const custom = vi.fn(async () => options.picks?.shift());
  const ctx = {
    cwd,
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") === "tui",
    ui: {
      notify,
      setStatus: vi.fn(),
      custom,
      input: async () => options.inputs?.shift(),
    },
    sessionManager: { getEntries: () => [...(options.entries ?? [])] },
  };

  const bindTool = tools.get("bind_notes");
  if (!bindTool) throw new Error("bind_notes 未注册");
  return {
    bind: (params) =>
      bindTool.execute("call-1", params, undefined, undefined, ctx as never),
    runCommand: async (name, args) => {
      const handler = commands.get(name);
      if (!handler) throw new Error(`${name} 未注册`);
      await handler(args, ctx as never);
    },
    custom,
    onBindingChange,
    entries,
  };
};

describe("bind_notes 落点 gate", () => {
  it("学习者选定落点后才写盘：章节名当主题名不再造出新主题", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup({
      picks: ["redis高可用", "redis集群方案和实现"],
    });

    const result = await h.bind({ topic: "redis集群方案和实现" });

    expect(result.isError).toBe(false);
    // 绑到了学习者选的《redis高可用》新章节，而不是请求里那个名字
    expect(result.details?.topic).toBe("redis高可用");
    expect(result.details?.path).toBe(
      path.join(topicDir("redis高可用"), "02-redis集群方案和实现.md"),
    );
    expect(
      fs.existsSync(path.join(vault, "Learn", "redis集群方案和实现")),
    ).toBe(false);
    // 学习者的两次选择都被尊重（先主题、后章节）——落盘的是选出来的那个主题。
    expect(h.onBindingChange).toHaveBeenCalledWith({
      file: path.join(topicDir("redis高可用"), "02-redis集群方案和实现.md"),
      inVault: true,
    });
    // 绑定条目写的是真正落盘的那个文件
    expect(h.entries.at(-1)).toEqual({
      customType: "tutor-notes",
      data: {
        file: path.join(topicDir("redis高可用"), "02-redis集群方案和实现.md"),
        chapter: "redis集群方案和实现",
      },
    });
  });

  it("学习者取消（Esc）：一个字节都不写", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup({ picks: [undefined] });

    const result = await h.bind({ topic: "redis集群方案和实现" });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("没有写盘");
    expect(result.details?.cancelled).toBe(true);
    expect(
      fs.existsSync(path.join(vault, "Learn", "redis集群方案和实现")),
    ).toBe(false);
    // 《redis高可用》也没被动过：没有新章节文件
    expect(fs.readdirSync(topicDir("redis高可用")).sort()).toEqual([
      "01-四个动作.md",
      "redis高可用.md",
    ]);
    expect(h.onBindingChange).not.toHaveBeenCalled();
  });

  it("没有 UI（print / json）：不猜落点，把选择交回对话", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup({ mode: "print" });
    const result = await h.bind({ topic: "redis集群方案和实现" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ask_user_question");
    expect(h.custom).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(vault, "Learn", "redis集群方案和实现")),
    ).toBe(false);
  });

  it("同一主题内换章 / 新建章：不惊动学习者，直接绑", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup({ entries: [boundEntry("redis高可用")] });

    const result = await h.bind({
      topic: "redis高可用",
      chapter: "redis集群方案和实现",
    });

    expect(result.isError).toBe(false);
    expect(h.custom).not.toHaveBeenCalled();
    expect(result.details?.chapterNumber).toBe(2);
  });

  it("md-log 绑到 vault 外的文件：镜像可用，但不开 tutor 闸门（inVault=false）", async () => {
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "# 别处\n");
    const h = setup({});

    await h.runCommand("md-log", outside);

    expect(h.onBindingChange).toHaveBeenCalledWith({
      file: outside,
      inVault: false,
    });
  });

  it("解绑（/md-unlog）：回报 file=null 的事实，不再宣称任何绑定", async () => {
    seedTopic("redis高可用", ["四个动作"]);
    const h = setup({ entries: [boundEntry("redis高可用")] });
    await h.bind({ topic: "redis高可用", chapter: "四个动作" });
    h.onBindingChange.mockClear();

    await h.runCommand("md-unlog", "");

    expect(h.onBindingChange).toHaveBeenCalledWith({
      file: null,
      inVault: false,
    });
  });
});
