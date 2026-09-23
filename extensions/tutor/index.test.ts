/**
 * 接线测试：用一个假的 ExtensionAPI 断言 tutor 注册了哪些工具/命令/事件，
 * 以及 `tutor-mode` 开关真的在改 active tools。只断言"看得见的效果"：
 * 工具集内容 + 写进会话的条目，不断言内部调用编排。
 */

import { describe, expect, it, vi } from "vitest";
import tutorExtension from "./index.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  QUIZ_TOOL_NAME,
  TUTOR_SESSION_TOOL_NAMES,
} from "./names.ts";

type EventHandler = (event: never, ctx: never) => unknown;
type CommandHandler = (args: string, ctx: never) => unknown;

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
  };
  return { api: api as never, seen };
};

/** 会话上下文替身：开关只用到 getEntries + ui.notify。 */
const ctxWith = (entries: readonly unknown[] = []): never =>
  ({
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

const turnStart = async (seen: Registered, prompt: string): Promise<void> => {
  const ctx = ctxWith();
  for (const handler of seen.handlers.get("before_agent_start") ?? []) {
    await handler(
      { type: "before_agent_start", prompt } as never,
      ctx as never,
    );
  }
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
      "validate_mermaid",
      "render_mermaid",
    ]);
    expect(seen.commands).toEqual([
      "md-topic",
      "md-log",
      "md-unlog",
      "concepts",
      "tutor-mode",
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

  it("marks the two terminal-owning tools sequential", () => {
    // 独占终端 UI 的工具不能和别的 tool call 并行跑：pi 只要看到批内有一个
    // sequential 就会把整批串行执行，否则后上屏的组件会把先上屏的摘掉（见 ui-concurrency.test.ts）。
    const { api, seen } = fakePi();
    tutorExtension(api);

    for (const name of [QUIZ_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME]) {
      expect(seen.toolDefs.get(name)?.executionMode, name).toBe("sequential");
    }
    // 其余工具不带这个字段，免得整批被无谓地串行化。
    for (const name of seen.tools) {
      if ([QUIZ_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME].includes(name))
        continue;
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
    expect(seen.entries).toEqual([
      { customType: "tutor-mode", data: { active: true } },
    ]);
  });

  it("keeps them on later turns without rewriting the loadout", async () => {
    const { api, seen } = fakePi();
    tutorExtension(api);
    await sessionStart(seen);
    await turnStart(seen, skillBlock);
    const callsBefore = seen.setActiveCalls.length;

    await turnStart(seen, "继续");

    expect(seen.setActiveCalls).toHaveLength(callsBefore);
    expectTutorToolsVisible(seen, true);
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
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("0/7"));
  });
});
