import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const emitForWorktreePath = vi.fn();
const clearBridge = vi.fn();

vi.mock("./pi-runtime-event-bridge.js", () => ({
  createPiRuntimeEventBridge: () => ({
    attachSession: vi.fn(),
    emitForWorktreePath,
    streamEvents: async function* () {
      // no-op
    },
    clear: clearBridge,
  }),
}));

vi.mock("./context.js", () => ({
  resolveKanbanCardContext: vi.fn(() => ({
    ok: false,
    error: "not used in this test",
  })),
  resolveKanbanCardContextByWorktreePath: vi.fn(
    ({ worktreePath }: { worktreePath: string }) =>
      worktreePath.endsWith("main--feat-checkout-v2")
        ? {
            ok: true,
            context: {
              kind: "child",
              lane: "In Progress",
              cardId: "feat-checkout-v2",
            },
          }
        : {
            ok: false,
            error: "no match",
          },
  ),
}));

const stopDaemon = vi.fn(async () => {});

vi.mock("../../kanban-daemon/daemon.js", () => ({
  createKanbanDaemon: vi.fn(
    (input: {
      host: string;
      token: string;
      service: unknown;
      resolveContextByWorktreePath?: (worktreePath: string) => {
        ok: boolean;
      };
    }) => ({
      host: input.host,
      token: input.token,
      service: input.service,
      get baseUrl() {
        return "http://127.0.0.1:7777";
      },
      acceptsRuntimeWorktree: (worktreePath: string) =>
        input.resolveContextByWorktreePath?.(worktreePath)?.ok ?? false,
      executeAction: vi.fn(),
      getActionStatus: vi.fn(),
      cancelAction: vi.fn(),
      getCardContext: vi.fn(),
      getCardRuntime: vi.fn(),
      readBoard: vi.fn(),
      patchBoard: vi.fn(),
      start: vi.fn(async () => {}),
      stop: stopDaemon,
    }),
  ),
}));

function runGit(cwd: string, args: string[]): void {
  spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-kanban-life-"),
  );
  tempDirs.push(repoRoot);
  runGit(repoRoot, ["init"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n", "utf-8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  emitForWorktreePath.mockClear();
  clearBridge.mockClear();
  stopDaemon.mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("kanban orchestrator lifecycle hooks", () => {
  it("stops forwarding runtime events after the daemon stops", async () => {
    const repoRoot = createRepo();
    const worktreePath = path.join(repoRoot, ".wt", "main--feat-checkout-v2");
    fs.mkdirSync(worktreePath, { recursive: true });

    const commands = new Map<
      string,
      (args: string, ctx: unknown) => Promise<void>
    >();
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => Promise<void>
    >();

    const { default: extension } = await import("./index.js");
    extension({
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      exec: vi.fn(),
      sendUserMessage: vi.fn(),
      on(
        name: string,
        handler: (event: unknown, ctx: unknown) => Promise<void>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);

    const start = commands.get("kanban-runtime-start");
    const stop = commands.get("kanban-runtime-stop");
    const beforeAgentStart = handlers.get("before_agent_start");
    expect(start).toBeTypeOf("function");
    expect(stop).toBeTypeOf("function");
    expect(beforeAgentStart).toBeTypeOf("function");
    if (!start || !stop || !beforeAgentStart) return;

    const ctx = {
      cwd: repoRoot,
      hasUI: false,
      ui: {
        notify() {
          // no-op
        },
      },
      sessionManager: {
        getSessionFile() {
          return null;
        },
      },
      async switchSession() {
        return { cancelled: false };
      },
    };

    await start("--port 0", ctx);
    await beforeAgentStart({}, { cwd: worktreePath });
    expect(emitForWorktreePath).toHaveBeenCalledTimes(1);
    expect(emitForWorktreePath).toHaveBeenLastCalledWith(worktreePath, {
      type: "agent-started",
    });

    await stop("", ctx);
    await beforeAgentStart({}, { cwd: worktreePath });
    expect(emitForWorktreePath).toHaveBeenCalledTimes(1);
  });
});
