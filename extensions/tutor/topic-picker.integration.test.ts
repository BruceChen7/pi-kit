/**
 * `/md-topic` 章节 picker 的接线集成测试：假 pi 捕获命令 handler，假 ctx.ui
 * 按预设 key 序列驱动 picker，真实落盘到临时 vault。
 *
 * 只断言「绑到了哪个文件 / 建没建文件 / notify 什么」——不做内部编排断言。
 * 要守住的契约：
 *   给主题（或从主题 picker 选完）后弹章节 picker；显式章节参数绕过 picker；
 *   取消不绑定；章节行绑定已有文件而不新建、不改编号。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNotes } from "./notes-store.ts";

type CommandHandler = (args: string, ctx: never) => Promise<unknown>;

type PickerScript = {
  /** 每次 `ctx.ui.custom` 调用消费一段按键序列；缺省按 esc。 */
  keys: string[][];
  /** 每次 `ctx.ui.input` 的返回值；用完后返回 undefined。 */
  inputs: (string | undefined)[];
};

type Component = {
  handleInput(data: string): void;
  /** 可选：用于断言渲染出的搜索框（如 CURSOR_MARKER）。 */
  render?(width: number): string[];
};

let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-topic-picker-"));
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

/** 把整个主题目录的文件 mtime 统一成给定时刻，让主题列表顺序可预测。 */
const stampTopic = (topic: string, iso: string): void => {
  const time = new Date(iso);
  const dir = topicDir(topic);
  for (const name of fs.readdirSync(dir)) {
    fs.utimesSync(path.join(dir, name), time, time);
  }
};

/** 固定 mtime：第 1 章最新（= resume 章节 = picker 初始光标），其余递减。 */
const stamp = (file: string, second: number): void => {
  const time = new Date(
    `2026-09-18T00:00:${String(second).padStart(2, "0")}.000Z`,
  );
  fs.utimesSync(file, time, time);
};

const prepareTopic = (topic: string, names: string[]): void => {
  const dir = topicDir(topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), `# ${topic}\n`);
  names.forEach((name, index) => {
    const file = path.join(
      dir,
      `${String(index + 1).padStart(2, "0")}-${name}.md`,
    );
    fs.writeFileSync(file, `# 第${index + 1}章 · ${name}\n`);
    stamp(file, 50 - index);
  });
  stamp(path.join(dir, "01-a.md"), 60);
};

const setup = (script: PickerScript) => {
  const commands = new Map<string, CommandHandler>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sessionNames: string[] = [];
  const notify = vi.fn();
  const counter = { customCalls: 0 };
  /** 每次 ctx.ui.custom 上屏的组件（用于断言搜索框渲染）。 */
  const components: Component[] = [];
  registerNotes({
    registerTool: () => {},
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    },
    on: () => {},
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    // 绑定成功会顺手给会话起名（仅当还没名字）。
    getSessionName: () => undefined,
    setSessionName: (name: string) => {
      sessionNames.push(name);
    },
  } as never);

  const ctx = {
    cwd,
    ui: {
      notify,
      setStatus: vi.fn(),
      input: async () => script.inputs.shift(),
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          counter.customCalls += 1;
          const keys = script.keys.shift() ?? ["\u001b"];
          let settled = false;
          const done = (value: unknown): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          const component = factory({ requestRender: () => {} }, {}, {}, done);
          components.push(component);
          for (const key of keys) {
            if (settled) break;
            component.handleInput(key);
          }
          if (!settled) throw new Error("picker 没有结算：key 序列不完整");
        }),
    },
    sessionManager: { getEntries: () => [] },
  };

  const mdTopic = async (args: string): Promise<void> => {
    const handler = commands.get("md-topic");
    if (!handler) throw new Error("md-topic 未注册");
    await handler(args, ctx as never);
  };

  const boundFiles = (): string[] =>
    entries.map((entry) => (entry.data as { file: string }).file);
  const topicFiles = (topic: string): string[] =>
    fs.readdirSync(topicDir(topic)).sort();

  return {
    mdTopic,
    entries,
    notify,
    boundFiles,
    topicFiles,
    counter,
    components,
    sessionNames,
  };
};

/**
 * Ghostty/Kitty 键盘协议（pi 以 flags 1|2|4 启用）下真正到达组件的字节：
 * esc = CSI 27 u，up = CSI 1;1A，down = CSI 1;1B。
 * 用裸 `\u001b` / `\u001b[A` 比较的组件在这里会全部失配 —— 这正是线上 bug。
 */
const KITTY_ESC = "\u001b[27u";
const KITTY_UP = "\u001b[1;1A";
const KITTY_DOWN = "\u001b[1;1B";

describe("md-topic picker 在 Kitty 键盘协议下的按键", () => {
  it("esc（CSI 27u）取消章节 picker", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [[KITTY_ESC]], inputs: [] });

    await h.mdTopic("分布式共识");

    expect(h.entries).toEqual([]);
    expect(h.notify).toHaveBeenCalledWith("未选择章节。", "warning");
  });

  it("up/down（CSI 1;1A/B）移动章节光标", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    // down ×2 → 「＋新建章节…」
    const down = setup({
      keys: [[KITTY_DOWN, KITTY_DOWN, "\r"]],
      inputs: ["c"],
    });

    await down.mdTopic("分布式共识");

    expect(down.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "03-c.md"),
    ]);

    // down ×2 再 up ×1 → 回到 02-b（用另一个主题，避免上一个用例新建的章节改变 resume 光标）
    prepareTopic("分布式共识二", ["a", "b"]);
    const up = setup({
      keys: [[KITTY_DOWN, KITTY_DOWN, KITTY_UP, "\r"]],
      inputs: [],
    });

    await up.mdTopic("分布式共识二");

    expect(up.boundFiles()).toEqual([
      path.join(topicDir("分布式共识二"), "02-b.md"),
    ]);
  });

  it("无参主题 picker：esc 取消、down 移动光标", async () => {
    prepareTopic("主题甲", ["a"]);
    prepareTopic("主题乙", ["a"]);
    // 主题列表按 lastTouched 倒序：甲最新，所以乙是第二行（down 的目标）。
    stampTopic("主题甲", "2026-09-18T00:10:00.000Z");
    stampTopic("主题乙", "2026-09-18T00:00:10.000Z");
    const esc = setup({ keys: [[KITTY_ESC]], inputs: [] });

    await esc.mdTopic("");

    expect(esc.entries).toEqual([]);
    expect(esc.notify).toHaveBeenCalledWith("未选择主题。", "warning");

    const down = setup({ keys: [[KITTY_DOWN, "\r"], ["\r"]], inputs: [] });

    await down.mdTopic("");

    expect(down.counter.customCalls).toBe(2);
    expect(down.boundFiles()).toEqual([
      path.join(topicDir("主题乙"), "01-a.md"),
    ]);
  });
  it("shift 过的可打印键（CSI 98:66;2u = B）也能进 filter", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({
      keys: [["\u001b[98:66;2u", "\r"]],
      inputs: [],
    });

    await h.mdTopic("分布式共识");

    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "02-b.md"),
    ]);
  });

  it("粘贴（bracketed paste）也能进 filter", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({
      keys: [["\u001b[200~b\u001b[201~", "\r"]],
      inputs: [],
    });

    await h.mdTopic("分布式共识");

    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "02-b.md"),
    ]);
  });

  it("无参主题 picker 也能 type 过滤（搜索框不是摆设）", async () => {
    prepareTopic("主题甲", ["a"]);
    prepareTopic("主题乙", ["a"]);
    stampTopic("主题甲", "2026-09-18T00:10:00.000Z");
    stampTopic("主题乙", "2026-09-18T00:00:10.000Z");
    // 打字「乙」→ 只剩主题乙一行；不打字时 enter 会选中第一行（主题甲）。
    const h = setup({ keys: [["乙", "\r"], ["\r"]], inputs: [] });

    await h.mdTopic("");

    expect(h.boundFiles()).toEqual([path.join(topicDir("主题乙"), "01-a.md")]);
  });

  it("搜索框发 CURSOR_MARKER：硬件光标/IME 才落得到框里", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["\r"]], inputs: [] });

    await h.mdTopic("分布式共识");

    const lines = h.components[0]?.render?.(40).join("\n") ?? "";
    expect(lines).toContain(CURSOR_MARKER);
  });
});

describe("md-topic 章节 picker", () => {
  it("给主题时弹章节 picker：选中已有章节绑到它的文件，不碰索引页", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["\r"]], inputs: [] });

    await h.mdTopic("分布式共识");

    expect(h.counter.customCalls).toBe(1);
    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "01-a.md"),
    ]);
    expect(h.entries[0].data).toEqual({
      file: path.join(topicDir("分布式共识"), "01-a.md"),
      chapter: "a",
    });
    // 没有新建任何章节文件（行为变更前这里绑的是 <主题>/<主题>.md）
    expect(h.topicFiles("分布式共识")).toEqual([
      "01-a.md",
      "02-b.md",
      "分布式共识.md",
    ]);
  });

  it("filter 输入后 enter 选中过滤行", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["b", "\r"]], inputs: [] });

    await h.mdTopic("分布式共识");

    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "02-b.md"),
    ]);
  });

  it("＋新建章节…：input 名字后建下一个号并绑定", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({
      keys: [["\u001b[B", "\u001b[B", "\r"]],
      inputs: ["c"],
    });

    await h.mdTopic("分布式共识");

    expect(h.topicFiles("分布式共识")).toEqual([
      "01-a.md",
      "02-b.md",
      "03-c.md",
      "分布式共识.md",
    ]);
    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "03-c.md"),
    ]);
  });

  it("主题索引页：绑 <主题>.md，chapter 为 null", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["索引", "\r"]], inputs: [] });

    await h.mdTopic("分布式共识");

    expect(h.entries[0].data).toEqual({
      file: path.join(topicDir("分布式共识"), "分布式共识.md"),
      chapter: null,
    });
  });

  it("esc 取消：不绑定、不建文件、notify 警告", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["\u001b"]], inputs: [] });

    await h.mdTopic("分布式共识");

    expect(h.counter.customCalls).toBe(1);
    expect(h.entries).toEqual([]);
    expect(h.topicFiles("分布式共识")).toEqual([
      "01-a.md",
      "02-b.md",
      "分布式共识.md",
    ]);
    expect(h.notify).toHaveBeenCalledWith("未选择章节。", "warning");
  });

  it("显式章节参数绕过 picker（兼容直通路径）", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [], inputs: [] });

    await h.mdTopic("分布式共识 b");

    expect(h.counter.customCalls).toBe(0);
    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "02-b.md"),
    ]);
  });

  it("无参：主题 picker → 章节 picker 链，主题来自 ctx.cwd 的设置", async () => {
    prepareTopic("分布式共识", ["a", "b"]);
    const h = setup({ keys: [["\r"], ["\r"]], inputs: [] });

    await h.mdTopic("");

    expect(h.counter.customCalls).toBe(2);
    expect(h.boundFiles()).toEqual([
      path.join(topicDir("分布式共识"), "01-a.md"),
    ]);
  });
});
