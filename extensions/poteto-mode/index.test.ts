import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PLAN_MODE_BADGE_CHANNEL } from "../shared/internal-events.js";
import { renderGuidance } from "./guidance.js";
import potetoMode from "./index.js";
import { POTETO_MODE_ENTRY } from "./state.js";

const PLAYBOOKS = fileURLToPath(
  new URL("../../skills/poteto-playbooks/playbooks", import.meta.url),
);

const GUIDANCE = renderGuidance(
  readFileSync(new URL("./guidance.md", import.meta.url), "utf8").trim(),
  PLAYBOOKS,
);

type Handler = (event: unknown, ctx: TestCtx) => Promise<unknown> | unknown;
type TestCtx = {
  cwd: string;
  mode: string;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
  sessionManager: { getBranch: () => unknown[] };
};

type BuildOptions = {
  flags?: Record<string, boolean>;
  defaultEnabled?: boolean;
};

const build = (branch: unknown[] = [], options: BuildOptions = {}) => {
  const flags = options.flags ?? {};
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: TestCtx) => Promise<unknown> | unknown }
  >();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const badges: Array<{ channel: string; payload: Record<string, unknown> }> =
    [];

  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (
      name: string,
      registration: { handler: (args: string, ctx: TestCtx) => unknown },
    ) => {
      commands.set(name, registration);
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
    registerFlag: vi.fn(),
    getFlag: (name: string) => flags[name] ?? false,
    events: {
      on: vi.fn(),
      emit: (channel: string, payload: Record<string, unknown>) => {
        badges.push({ channel, payload });
      },
    },
  };

  potetoMode(api as unknown as ExtensionAPI, {
    loadConfig: () => ({ defaultEnabled: options.defaultEnabled ?? false }),
  });

  const ctx: TestCtx = {
    cwd: "/repo",
    mode: "tui",
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getBranch: () => branch },
  };

  const emit = async (event: string, payload: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
    }
    return result;
  };

  const run = async (args: string) => {
    const command = commands.get("poteto-mode");
    if (!command) {
      throw new Error("poteto-mode command is not registered");
    }
    return command.handler(args, ctx);
  };

  return { emit, run, ctx, appended, badges };
};

const start = { systemPrompt: "BASE" };

describe("poteto-mode", () => {
  it("injects nothing until the branch opts in", async () => {
    const { emit } = build();
    expect(await emit("before_agent_start", start)).toEqual({});
  });

  it("appends the guidance body once enabled", async () => {
    const { emit, run, appended } = build();
    await run("on");
    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    expect(result.systemPrompt).toContain("poteto 模式（常驻）");
    expect(appended).toEqual([
      { customType: POTETO_MODE_ENTRY, data: { version: 1, enabled: true } },
    ]);
  });

  it("points at a playbook directory that exists from any working directory", async () => {
    const { emit, run } = build();
    await run("on");
    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).not.toContain("{{PLAYBOOKS}}");
    expect(result.systemPrompt).toContain(PLAYBOOKS);
    expect(existsSync(PLAYBOOKS)).toBe(true);
  });

  it("replaces the body with the off notice once disabled", async () => {
    const { emit, run } = build();
    await run("on");
    await run("off");
    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("早先的自动模式提醒不再适用");
    expect(result.systemPrompt).not.toContain("## 路由");
  });

  it("reports status and the exact injected text", async () => {
    const { run, ctx } = build();
    await run("");
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("poteto mode off");
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("本分支未设置");

    await run("on");
    await run("status");
    const status = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(status).toContain("poteto mode on");
    expect(status).toContain("注入");

    await run("preview");
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toBe(GUIDANCE);
    expect(GUIDANCE).toContain("route: <类型>");
  });

  it("refuses an unknown verb without touching state", async () => {
    const { emit, run, ctx, appended } = build();
    await run("enable");
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("未知动词");
    expect(appended).toEqual([]);
    expect(await emit("before_agent_start", start)).toEqual({});
  });

  it("broadcasts the footer badge instead of writing a status key", async () => {
    const { run, ctx, badges } = build();
    await run("on");

    expect(badges.at(-1)).toEqual({
      channel: PLAN_MODE_BADGE_CHANNEL,
      payload: {
        type: "plan-mode.badge",
        ctx,
        cwd: "/repo",
        key: "poteto",
        text: "poteto on",
      },
    });
    // footer 只有一个写点：本扩展不再直接碰状态行。
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("retracts the badge when the mode is turned off", async () => {
    const { run, badges } = build();
    await run("on");
    await run("off");

    expect(badges.at(-1)?.payload.text).toBeNull();
  });

  it("starts enabled from the --poteto-mode flag without writing an entry", async () => {
    const { emit, appended } = build([], { flags: { "poteto-mode": true } });
    await emit("session_start");

    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("poteto 模式（常驻）");
    // 脚本化验证用：不污染会话状态。
    expect(appended).toEqual([]);
  });

  it("starts enabled from the configured default", async () => {
    const { emit, appended } = build([], { defaultEnabled: true });
    await emit("session_start");

    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("poteto 模式（常驻）");
    expect(appended).toEqual([]);
  });

  it("lets an explicit off record beat the configured default", async () => {
    const branch = [
      {
        type: "custom",
        customType: POTETO_MODE_ENTRY,
        data: { version: 1, enabled: false },
      },
    ];
    const { emit } = build(branch, { defaultEnabled: true });
    await emit("session_start");

    const result = (await emit("before_agent_start", start)) as {
      systemPrompt: string;
    };
    // 显式关掉不等于「什么都没注入」：还要告诉模型早先的自动提醒已失效。
    expect(result.systemPrompt).toContain("早先的自动模式提醒不再适用");
    expect(result.systemPrompt).not.toContain("## 路由");
  });

  it("restores the last snapshot on session start", async () => {
    const branch = [
      {
        type: "custom",
        customType: POTETO_MODE_ENTRY,
        data: { version: 1, enabled: true },
      },
      { type: "message", data: "hi" },
    ];
    const { emit, run, ctx, badges } = build(branch);
    await emit("session_start");
    expect(badges.at(-1)?.payload.text).toBe("poteto on");
    await run("status");
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("poteto mode on");
  });
});
