import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSettingsCache,
  getGlobalSettingsPath,
} from "../shared/settings.js";

type MockEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

type MockContext = {
  hasUI: boolean;
  cwd: string;
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
  ui: {
    getEditorText: () => string;
    setEditorText: (next: string) => void;
    notify: (message: string, type?: string) => void;
  };
  sessionManager: {
    getEntries: () => MockEntry[];
  };
};

type MockEvent = Record<string, unknown>;
type RegisteredHandler = (event: MockEvent, ctx: MockContext) => unknown;
type HandlerMap = Map<string, RegisteredHandler[]>;

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

const registerTempDir = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

const createTempDir = (prefix: string): string =>
  registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const createTempHome = (): string => {
  const dir = createTempDir("pi-kit-plannotator-auto-home-");
  process.env.HOME = dir;
  return dir;
};

const restoreHome = (): void => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
};

const createHandlerMap = (): HandlerMap => new Map();

const registerHandler = (
  handlers: HandlerMap,
  event: string,
  handler: RegisteredHandler,
): void => {
  const existing = handlers.get(event) ?? [];
  existing.push(handler);
  handlers.set(event, existing);
};

const createMockContext = (cwd: string) => {
  const editorUpdates: string[] = [];
  let editorText = "";
  let idle = true;
  let pendingMessages = false;

  const ctx: MockContext = {
    hasUI: true,
    cwd,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    ui: {
      getEditorText: () => editorText,
      setEditorText: (next: string) => {
        editorText = next;
        editorUpdates.push(next);
      },
      notify: (_message: string, _type?: string) => undefined,
    },
    sessionManager: {
      getEntries: () => [],
    },
  };

  return {
    ctx,
    editorUpdates,
    setPendingMessages: (value: boolean) => {
      pendingMessages = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
};

const createMockPi = (handlers: HandlerMap): ExtensionAPI =>
  ({
    on: (event: string, handler: RegisteredHandler) => {
      registerHandler(handlers, event, handler);
    },
    getCommands: () => [
      { name: "plannotator-set-file" },
      { name: "plannotator" },
      { name: "plannotator-annotate" },
    ],
  }) as unknown as ExtensionAPI;

const loadPlannotatorAuto = async () => {
  vi.resetModules();
  return import("./index.js");
};

const writePlannotatorAutoSettings = (): void => {
  const globalPath = getGlobalSettingsPath();
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(
    globalPath,
    JSON.stringify(
      {
        plannotatorAuto: {
          planFile: ".pi/PLAN.md",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
};

const setupPlannotatorAuto = async (cwd: string): Promise<HandlerMap> => {
  writePlannotatorAutoSettings();
  const handlers = createHandlerMap();
  const { default: plannotatorAuto } = await loadPlannotatorAuto();
  plannotatorAuto(createMockPi(handlers));
  return handlers;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearSettingsCache();
  restoreHome();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plannotator-auto", () => {
  it("submits commands on successful write tool_result", async () => {
    vi.useFakeTimers();
    createTempHome();
    const cwd = createTempDir("pi-kit-plannotator-auto-cwd-");

    const handlers = await setupPlannotatorAuto(cwd);
    const toolResultHandlers = handlers.get("tool_result");
    expect(toolResultHandlers?.length).toBeGreaterThan(0);

    const context = createMockContext(cwd);
    vi.spyOn(process.stdin, "emit").mockImplementation(() => true);
    await toolResultHandlers?.[0]?.(
      {
        toolName: "write",
        input: { path: ".pi/PLAN.md" },
        isError: false,
      },
      context.ctx,
    );

    expect(context.editorUpdates[0]).toBe("/plannotator-set-file .pi/PLAN.md");
  });

  it("waits until pending messages are drained", async () => {
    vi.useFakeTimers();
    createTempHome();
    const cwd = createTempDir("pi-kit-plannotator-auto-cwd-");

    const handlers = await setupPlannotatorAuto(cwd);
    const context = createMockContext(cwd);
    context.setPendingMessages(true);
    vi.spyOn(process.stdin, "emit").mockImplementation(() => true);

    await handlers.get("tool_result")?.[0]?.(
      {
        toolName: "edit",
        input: { path: ".pi/PLAN.md" },
        isError: false,
      },
      context.ctx,
    );
    expect(context.editorUpdates).toHaveLength(0);

    context.setPendingMessages(false);
    context.setIdle(true);
    await handlers.get("agent_end")?.[0]?.({}, context.ctx);

    expect(context.editorUpdates[0]).toBe("/plannotator-set-file .pi/PLAN.md");
  });

  it("ignores failed write/edit tool results", async () => {
    vi.useFakeTimers();
    createTempHome();
    const cwd = createTempDir("pi-kit-plannotator-auto-cwd-");

    const handlers = await setupPlannotatorAuto(cwd);
    const context = createMockContext(cwd);
    vi.spyOn(process.stdin, "emit").mockImplementation(() => true);

    await handlers.get("tool_result")?.[0]?.(
      {
        toolName: "write",
        input: { path: ".pi/PLAN.md" },
        isError: true,
      },
      context.ctx,
    );

    expect(context.editorUpdates).toHaveLength(0);
  });

  it("clears queued triggers when a new session starts", async () => {
    vi.useFakeTimers();
    createTempHome();
    const cwd = createTempDir("pi-kit-plannotator-auto-cwd-");

    const handlers = await setupPlannotatorAuto(cwd);
    const context = createMockContext(cwd);
    context.setIdle(false);
    vi.spyOn(process.stdin, "emit").mockImplementation(() => true);

    await handlers.get("tool_result")?.[0]?.(
      {
        toolName: "edit",
        input: { path: ".pi/PLAN.md" },
        isError: false,
      },
      context.ctx,
    );
    expect(context.editorUpdates).toHaveLength(0);

    await handlers.get("session_start")?.[0]?.({}, context.ctx);
    context.setIdle(true);
    await handlers.get("agent_end")?.[0]?.({}, context.ctx);

    expect(context.editorUpdates).toHaveLength(0);
  });
});
