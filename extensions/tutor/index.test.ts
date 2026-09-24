/**
 * 接线测试：用一个假的 ExtensionAPI 断言 tutor 注册了哪些工具/命令/事件，
 * 以及 `tutor-mode` 开关真的在改 active tools。只断言"看得见的效果"：
 * 工具集内容 + 写进会话的条目，不断言内部调用编排。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tutorExtension from "./index.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BIND_NOTES_TOOL_NAME,
  QUIZ_TOOL_NAME,
  TUTOR_SESSION_TOOL_NAMES,
} from "./names.ts";

type EventHandler = (event: never, ctx: never) => unknown;
type CommandHandler = (args: string, ctx: never) => unknown;

/** 每个用例一个临时 vault + 一份指向它的项目设置，保证不读真实笔记目录。 */
let root: string;
let vault: string;
let cwd: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-wiring-"));
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

/** 造一个主题：索引页 + N 章，返回章节文件路径。 */
const seedTopic = (topic: string, chapters: string[]): string[] => {
  const dir = path.join(vault, "Learn", topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${topic}.md`), `# ${topic}\n`);
  return chapters.map((name, index) => {
    const file = path.join(
      dir,
      `${String(index + 1).padStart(2, "0")}-${name}.md`,
    );
    fs.writeFileSync(file, `# 第${index + 1}章 · ${name}\n`);
    return file;
  });
};

type Registered = {
  tools: string[];
  toolDefs: Map<string, { name: string; executionMode?: string }>;
  commands: string[];
  events: string[];
  handlers: Map<string, EventHandler[]>;
  commandHandlers: Map<string, CommandHandler>;
  active: string[];
  setActiveCalls: string[][];
  entries: Array<{ customType: string; data: unknown }>;
};

const TUTOR_TOOLS = [...TUTOR_SESSION_TOOL_NAMES];
const OTHER_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "rg",
  "fd",
  "validate_mermaid",
  "render_mermaid",
];

const fakePi = (): { api: never; seen: Registered } => {
  const seen: Registered = {
    tools: [],
    toolDefs: new Map(),
    commands: [],
    events: [],
    handlers: new Map(),
    commandHandlers: new Map(),
    active: [...OTHER_TOOLS, ...TUTOR_TOOLS],
    setActiveCalls: [],
    entries: [],
  };
  const api = {
    registerTool: vi.fn((tool: { name: string; executionMode?: string }) => {
      seen.tools.push(tool.name);
      seen.toolDefs.set(tool.name, tool);
    }),
    registerCommand: vi.fn(
      (name: string, options: { handler: CommandHandler }) => {
        seen.commands.push(name);
        seen.commandHandlers.set(name, options.handler);
      },
    ),
    on: vi.fn((event: string, handler: EventHandler) => {
      seen.events.push(event);
      seen.handlers.set(event, [...(seen.handlers.get(event) ?? []), handler]);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      seen.entries.push({ customType, data });
    }),
    getActiveTools: () => [...seen.active],
    setActiveTools: (names: string[]) => {
      seen.setActiveCalls.push([...names]);
      seen.active = [...names];
    },
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  return { api: api as never, seen };
};

/** 会话上下文替身：开关只用到 cwd + getEntries + ui.notify。 */
const ctxWith = (
  entries: readonly unknown[] = [],
  cwdOverride?: string,
): never =>
  ({
    cwd: cwdOverride ?? cwd,
    hasUI: true,
    sessionManager: { getEntries: () => [...entries] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  }) as never;

/** 会话开始时 pi 会跑这个事件的所有 handler（notes-store 也注册了一个）。 */
const sessionStart = async (
  seen: Registered,
  entries: readonly unknown[] = [],
): Promise<never> => {
  const ctx = ctxWith(entries);
  for (const handler of seen.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start" } as never, ctx as never);
  }
  return ctx;
};

const turnStart = async (
  seen: Registered,
  prompt: string,
  entries: readonly unknown[] = [],
): Promise<unknown[]> => {
  const ctx = ctxWith(entries);
  const injected: unknown[] = [];
  for (const handler of seen.handlers.get("before_agent_start") ?? []) {
    const result = await handler(
      { type: "before_agent_start", prompt } as never,
      ctx as never,
    );
    if (result) injected.push(result);
  }
  return injected;
};

const userInput = async (
  seen: Registered,
  text: string,
  streaming: boolean,
): Promise<void> => {
  const ctx = ctxWith();
  for (const handler of seen.handlers.get("input") ?? []) {
    await handler(
      {
        type: "input",
        text,
        streamingBehavior: streaming ? "steer" : undefined,
      } as never,
      ctx as never,
    );
  }
};

const runTutorModeCommand = async (
  seen: Registered,
  args: string,
): Promise<never> => {
  const handler = seen.commandHandlers.get("tutor-mode");
  if (!handler) throw new Error("tutor-mode command was not registered");
  const ctx = ctxWith([modeEntry(true)]);
  await handler(args as never, ctx as never);
  return ctx;
};

const modeEntry = (active: boolean) => ({
  type: "custom",
  customType: "tutor-mode",
  data: { active },
});

const skillBlock = `<skill name="tutor" location="/Users/x/skills/tutor/SKILL.md">\n# Tutor\n</skill>`;

const expectTutorToolsVisible = (seen: Registered, visible: boolean) => {
  for (const name of TUTOR_TOOLS) {
    expect(seen.active.includes(name), `${name} active=${seen.active}`).toBe(
      visible,
    );
  }
};

describe("tutor extension wiring", () => {
  it("registers the teaching tools, note commands and mirror events", () => {
    const { api, seen } = fakePi();
    tutorExtension(api);

    expect(seen.tools).toEqual([
      "quiz",
      "ask_user_question",
      "bind_notes",
      "number_chapters",
      "split_topic",
      "note_concept",
      "check_concepts",
      "topic_status",
      "validate_mermaid",
      "render_mermaid",
    ]);
    expect(seen.commands).toEqual([
      "tutor-mode",
      "md-topic",
      "md-log",
      "md-unlog",
      "concepts",
    ]);
    expect(seen.events).toEqual(
      expect.arrayContaining([
        "session_start",
        "message_end",
        "tool_execution_update",
        "tool_call",
        "tool_result",
        "before_agent_start",
        "input",
      ]),
    );
    // 按名字摘工具：任何一个改名都会让 gating 静默失效。
    for (const name of TUTOR_TOOLS) expect(seen.tools).toContain(name);
  });

  it("marks the terminal-owning tools sequential", () => {
    // 独占终端 UI 的工具不能和别的 tool call 并行跑：pi 只要看到批内有一个
    // sequential 就会把整批串行执行，否则后上屏的组件会把先上屏的摘掉（见 ui-concurrency.test.ts）。
    // bind_notes 也在此列：落点 gate 会弹主题/章节 picker。
    const { api, seen } = fakePi();
    tutorExtension(api);

    const owning = [
      QUIZ_TOOL_NAME,
      ASK_USER_QUESTION_TOOL_NAME,
      BIND_NOTES_TOOL_NAME,
    ];
    for (const name of owning) {
      expect(seen.toolDefs.get(name)?.executionMode, name).toBe("sequential");
    }
    // 其余工具不带这个字段，免得整批被无谓地串行化。
    for (const name of seen.tools) {
      if (owning.includes(name)) continue;
      expect(seen.toolDefs.get(name)?.executionMode, name).toBeUndefined();
    }
  });

  it("hides the tutor tools in a session that never ran the skill", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);

    await sessionStart(seen);

    expect(seen.active).toEqual(OTHER_TOOLS);
    expect(seen.setActiveCalls).toEqual([OTHER_TOOLS]);
  });

  it("exposes them on the very turn that carries the skill block", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    await sessionStart(seen);

    await turnStart(seen, `${skillBlock}\n\nDocker实现`);

    expectTutorToolsVisible(seen, true);
    // 翻转落一条 tutor-mode；首轮还落一条 tutor-brief（状态注入的记账）。
    // 只断言「都落了」，不断言两者的先后：它们是互不相关的记账。
    const types = seen.entries.map((entry) => entry.customType);
    expect(types).toContain("tutor-mode");
    expect(types).toContain("tutor-brief");
  });

  it("injects one topic brief per session and stays quiet afterwards", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    const [chapter] = seedTopic("redis高可用", ["四个动作", "收口三场景"]);
    await sessionStart(seen, [
      { type: "custom", customType: "tutor-notes", data: { file: chapter } },
    ]);

    const first = await turnStart(seen, "继续", [
      { type: "custom", customType: "tutor-notes", data: { file: chapter } },
    ]);
    const injected = first.find(
      (result) =>
        (result as { message?: { customType?: string } }).message
          ?.customType === "tutor-brief",
    ) as { message: { content: string; display: boolean } } | undefined;

    expect(injected, "first turn should inject the brief").toBeDefined();
    expect(injected?.message.display).toBe(false);
    expect(injected?.message.content).toContain("redis高可用");
    expect(injected?.message.content).toContain("第1章 · 四个动作");
    expect(injected?.message.content).toContain("续做：");

    const second = await turnStart(seen, "继续", [
      { type: "custom", customType: "tutor-notes", data: { file: chapter } },
    ]);
    expect(
      second.some(
        (result) =>
          (result as { message?: { customType?: string } }).message
            ?.customType === "tutor-brief",
      ),
    ).toBe(false);
  });

  it("does not inject a brief into a session that is not teaching", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    seedTopic("redis高可用", ["四个动作"]);
    await sessionStart(seen);

    const results = await turnStart(seen, "帮我改一下这个扩展");

    expect(results).toEqual([]);
  });

  it("keeps them on later turns without rewriting the loadout", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    await sessionStart(seen);
    await turnStart(seen, skillBlock);
    const callsBefore = seen.setActiveCalls.length;

    // 第二轮：prompt 里没有 skill 块，但转录里有（真实会话就是这样）。
    // 模式从会话事实重新推导，推导结果没变就不重写工具集。
    await turnStart(seen, "继续", [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: skillBlock }],
        },
      },
    ]);

    expect(seen.setActiveCalls).toHaveLength(callsBefore);
    expectTutorToolsVisible(seen, true);
  });

  it("restores the on state from a vault binding alone", async () => {
    // 上一轮 `/md-topic` 绑定了 vault 内的笔记：resume 之后工具该在，不需要 skill 块。
    const { api, seen } = fakePi();
    tutorExtension(api);
    const [chapter] = seedTopic("Docker实现", ["重建地基"]);

    await sessionStart(seen, [
      { type: "custom", customType: "tutor-notes", data: { file: chapter } },
    ]);

    expectTutorToolsVisible(seen, true);
  });

  it("opens the gate as soon as bind_notes binds into the vault", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    seedTopic("Docker实现", ["重建地基"]);
    await sessionStart(seen);
    expectTutorToolsVisible(seen, false);

    const bind = seen.toolDefs.get(BIND_NOTES_TOOL_NAME) as unknown as {
      execute: (
        id: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: never,
      ) => Promise<{ isError: boolean }>;
    };
    // 会话已绑到《Docker实现》索引页，这次只要索引页（不涉及章节）⇒ 不需要 picker。
    const ctx = ctxWith([
      {
        type: "custom",
        customType: "tutor-notes",
        data: {
          file: path.join(vault, "Learn", "Docker实现", "Docker实现.md"),
        },
      },
    ]);
    const result = await bind.execute(
      "call-1",
      { topic: "Docker实现" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(false);
    expectTutorToolsVisible(seen, true);
    // 绑定本身就是持久信号（`tutor-notes` 条目），不再另写一条 tutor-mode——
    // 否则 /md-unlog 之后会被那条显式条目钉在 on。
    expect(
      seen.entries.some((entry) => entry.customType === "tutor-mode"),
    ).toBe(false);
  });

  it("closes the gate on the turn after /md-unlog", async () => {
    // 闸门开合按会话条目每轮重新推导：解绑（file: null）后下一轮工具就该藏起来。
    const { api, seen } = fakePi();
    tutorExtension(api);
    const [chapter] = seedTopic("Docker实现", ["重建地基"]);
    const bound = {
      type: "custom",
      customType: "tutor-notes",
      data: { file: chapter },
    };
    const unbound = {
      type: "custom",
      customType: "tutor-notes",
      data: { file: null },
    };

    await sessionStart(seen, [bound]);
    await turnStart(seen, "继续", [bound]);
    expectTutorToolsVisible(seen, true);

    await turnStart(seen, "继续", [bound, unbound]);

    expectTutorToolsVisible(seen, false);
  });

  it("restores an on state from the persisted entry", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);

    await sessionStart(seen, [modeEntry(true)]);

    expect(seen.active).toEqual([...OTHER_TOOLS, ...TUTOR_TOOLS]);
  });

  it("restores an on state from the transcript alone", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);

    await sessionStart(seen, [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: skillBlock }],
        },
      },
    ]);

    expectTutorToolsVisible(seen, true);
  });

  it("turns on for a mid-stream /skill:tutor steer, but not for a normal one", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    await sessionStart(seen);

    await userInput(seen, "/skill:tutor Docker实现", false);
    expect(seen.active).toEqual(OTHER_TOOLS);

    await userInput(seen, "/skill:tutor Docker实现", true);
    expectTutorToolsVisible(seen, true);
  });

  it("/tutor-mode off hides them and persists the switch", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    await sessionStart(seen, [modeEntry(true)]);
    expectTutorToolsVisible(seen, true);

    const ctx = await runTutorModeCommand(seen, "off");

    expect(seen.active).toEqual(OTHER_TOOLS);
    expect(seen.entries).toEqual([
      { customType: "tutor-mode", data: { active: false } },
    ]);
    const notify = (
      ctx as unknown as { ui: { notify: ReturnType<typeof vi.fn> } }
    ).ui.notify;
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("0/8"));
  });
});
