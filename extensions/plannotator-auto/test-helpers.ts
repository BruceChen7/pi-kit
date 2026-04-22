import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export type TestCtx = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  abort: ReturnType<typeof vi.fn>;
  ui: {
    notify: ReturnType<typeof vi.fn>;
  };
  sessionManager: {
    getSessionFile: () => string;
  };
};

export type PiEventHandler = (event: unknown, ctx: TestCtx) => unknown;

export type FakeEventBus = {
  on: (channel: string, handler: (payload: unknown) => void) => void;
  emit: (channel: string, payload: unknown) => void;
};

export type ShortcutHandler = (ctx: TestCtx) => unknown;

export type ShortcutRegistration = {
  description: string;
  handler: ShortcutHandler;
};

export type ToolRegistration = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void | Promise<void>,
    ctx: TestCtx,
  ) => Promise<unknown>;
};

export function createFakeEventBus(): FakeEventBus {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();

  return {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
    emit(channel, payload) {
      for (const handler of handlers.get(channel) ?? []) {
        handler(payload);
      }
    },
  };
}

export function createFakePi() {
  const handlers = new Map<string, PiEventHandler[]>();
  const events = createFakeEventBus();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const tools = new Map<string, ToolRegistration>();

  return {
    api: {
      on(name: string, handler: PiEventHandler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerShortcut: vi.fn(
        (shortcut: unknown, registration: ShortcutRegistration) => {
          shortcuts.set(String(shortcut), registration);
        },
      ),
      registerTool: vi.fn((tool: ToolRegistration) => {
        tools.set(tool.name, tool);
      }),
      events,
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    },
    events,
    emit: async (
      name: string,
      event: unknown,
      ctx: TestCtx,
    ): Promise<unknown> => {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event, ctx);
      }
      return result;
    },
    runShortcut: async (shortcut: string, ctx: TestCtx): Promise<void> => {
      const registration = shortcuts.get(shortcut);
      if (!registration) {
        throw new Error(`Shortcut not registered: ${shortcut}`);
      }

      await registration.handler(ctx);
    },
    runTool: async (
      name: string,
      params: Record<string, unknown>,
      ctx: TestCtx,
    ): Promise<unknown> => {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`);
      }

      return tool.execute(
        "tool-call-1",
        params,
        new AbortController().signal,
        async () => {},
        ctx,
      );
    },
  };
}

export function createTestContext(
  cwd: string,
  options: {
    hasUI?: boolean;
    isIdle?: boolean;
    sessionFile?: string;
  } = {},
): TestCtx {
  return {
    cwd,
    hasUI: options.hasUI ?? true,
    isIdle: () => options.isIdle ?? true,
    abort: vi.fn(),
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionFile: () =>
        options.sessionFile ?? path.join(cwd, ".pi", "session.json"),
    },
  };
}

export async function createTempRepo(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeTestFile(
  repoRoot: string,
  repoRelativePath: string,
  content: string,
  modifiedAt?: Date,
): Promise<string> {
  const absolutePath = path.join(repoRoot, repoRelativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  if (modifiedAt) {
    await fs.utimes(absolutePath, modifiedAt, modifiedAt);
  }

  return absolutePath;
}

export async function removeTempRepo(repoRoot: string): Promise<void> {
  await fs.rm(repoRoot, { recursive: true, force: true });
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
