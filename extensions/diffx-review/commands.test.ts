import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRepoRoot: vi.fn(),
  loadDiffxReviewConfig: vi.fn(),
  getComments: vi.fn(),
  promptForDiffxReviewDiffArgs: vi.fn(),
  getDiffxReviewSession: vi.fn(),
  clearDiffxReviewSession: vi.fn(),
  markSessionHealth: vi.fn(),
  startDiffxReviewSession: vi.fn(),
  stopDiffxReviewSession: vi.fn(),
}));

vi.mock("../shared/git.ts", () => ({
  getRepoRoot: mocks.getRepoRoot,
}));

vi.mock("./config.ts", () => ({
  loadDiffxReviewConfig: mocks.loadDiffxReviewConfig,
}));

vi.mock("./client.ts", () => ({
  getComments: mocks.getComments,
  getCommentStats(comments: Array<{ status: string }>) {
    return {
      total: comments.length,
      open: comments.filter((comment) => comment.status !== "resolved").length,
      resolved: comments.filter((comment) => comment.status === "resolved")
        .length,
    };
  },
}));

vi.mock("./menu.ts", () => ({
  promptForDiffxReviewDiffArgs: mocks.promptForDiffxReviewDiffArgs,
}));

vi.mock("./runtime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./runtime.ts")>("./runtime.ts");
  return {
    ...actual,
    getDiffxReviewSession: mocks.getDiffxReviewSession,
    clearDiffxReviewSession: mocks.clearDiffxReviewSession,
    markSessionHealth: mocks.markSessionHealth,
    startDiffxReviewSession: mocks.startDiffxReviewSession,
    stopDiffxReviewSession: mocks.stopDiffxReviewSession,
  };
});

import { registerDiffxReviewCommands } from "./commands.ts";

const activeSession = {
  repoRoot: "/repo",
  host: "127.0.0.1",
  port: 3433,
  url: "http://127.0.0.1:3433",
  pid: 123,
  startedAt: 1,
  diffArgs: ["main..HEAD"],
  openInBrowser: true,
  cwdAtStart: "/repo",
  startCommand: "diffx -- main..HEAD",
  lastHealthcheckAt: null,
  lastHealthcheckOk: null,
};

const openComment = {
  id: "c1",
  filePath: "src/a.ts",
  side: "additions" as const,
  lineNumber: 10,
  lineContent: "+ const a = 1",
  body: "rename this",
  status: "open" as const,
  createdAt: 1,
  replies: [],
};

describe("diffx-review commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRepoRoot.mockReturnValue("/repo");
    mocks.loadDiffxReviewConfig.mockReturnValue({
      enabled: true,
      diffxCommand: "diffx",
      host: "127.0.0.1",
      defaultPort: null,
      reuseExistingSession: true,
      healthcheckTimeoutMs: 1000,
      startupTimeoutMs: 15000,
    });
    mocks.getComments.mockResolvedValue([openComment]);
    mocks.getDiffxReviewSession.mockReturnValue(activeSession);
    mocks.markSessionHealth.mockImplementation(
      (_repoRoot, _healthy) => activeSession,
    );
    mocks.stopDiffxReviewSession.mockResolvedValue({
      stopped: true,
      reason: "stopped",
    });
    mocks.startDiffxReviewSession.mockResolvedValue({
      ...activeSession,
      diffArgs: ["origin/main...HEAD"],
      url: "http://127.0.0.1:4444",
    });
  });

  it("replaces an existing session when explicit diff args are provided without UI", async () => {
    const commands = new Map<
      string,
      (args: string, ctx: Record<string, unknown>) => Promise<void>
    >();
    const notifications: Array<{ message: string; level: string }> = [];
    const sendMessage = vi.fn();

    registerDiffxReviewCommands({
      registerCommand(name, definition) {
        commands.set(name, definition.handler);
      },
      sendMessage,
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI);

    const handler = commands.get("diffx-start-review");
    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    await handler("-- origin/main...HEAD", {
      cwd: "/repo",
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    expect(mocks.stopDiffxReviewSession).toHaveBeenCalledWith("/repo");
    expect(mocks.startDiffxReviewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        diffArgs: ["origin/main...HEAD"],
        openInBrowser: true,
      }),
    );
    expect(notifications).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("No active"),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("registers process-review without the deprecated finish-review alias", async () => {
    const commands = new Map<
      string,
      (args: string, ctx: Record<string, unknown>) => Promise<void>
    >();
    const sendUserMessage = vi.fn();

    registerDiffxReviewCommands({
      registerCommand(name, definition) {
        commands.set(name, definition.handler);
      },
      sendMessage: vi.fn(),
      sendUserMessage,
    } as unknown as ExtensionAPI);

    expect(commands.has("diffx-process-review")).toBe(true);
    expect(commands.has("diffx-finish-review")).toBe(false);

    const ctx = {
      cwd: "/repo",
      hasUI: false,
      ui: {
        notify: vi.fn(),
      },
    };

    await commands.get("diffx-process-review")?.("", ctx);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("<diffx-review-comments>"),
    );
  });
});
