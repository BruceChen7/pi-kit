import { afterEach, describe, expect, it, vi } from "vitest";

type SpawnSyncMockResult = {
  status: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function mockSpawnSync(result: SpawnSyncMockResult) {
  const spawnSync = vi.fn(() => result);
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawnSync,
  }));
  return spawnSync;
}

import {
  createFakePi,
  createTestContext,
  flushMicrotasks,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

function mockCodeReviewApi() {
  vi.doMock("../shared/settings.ts", () => ({
    loadGlobalSettings: vi.fn(() => ({
      globalPath: "/home/test/.pi/agent/third_extension_settings.json",
      global: {},
    })),
    loadSettings: vi.fn(() => ({
      merged: {
        plannotatorAuto: {
          codeReviewAutoTrigger: true,
        },
      },
    })),
  }));

  vi.doMock("../shared/git.ts", () => ({
    DEFAULT_GIT_TIMEOUT_MS: 1_000,
    getRepoRoot: vi.fn(() => "/repo"),
    getGitCommonDir: vi.fn(() => "/repo/.git"),
    checkRepoDirty: vi.fn(() => ({
      summary: {
        dirty: true,
      },
    })),
  }));
}

async function triggerCodeReview(
  emit: (name: string, event: unknown, ctx: unknown) => Promise<unknown>,
  ctx: unknown,
): Promise<void> {
  await emit(
    "tool_execution_start",
    {
      toolName: "write",
      toolCallId: "call-1",
      args: { path: "src/app.ts" },
    },
    ctx,
  );
  await emit(
    "tool_execution_end",
    {
      toolName: "write",
      toolCallId: "call-1",
      isError: false,
    },
    ctx,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("code review trigger timing", () => {
  it("starts code review through the Plannotator CLI and delivers feedback", async () => {
    vi.resetModules();
    const spawnSync = mockSpawnSync({
      status: 0,
      stdout: "Please add tests.",
      stderr: "",
    });

    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);

      await emit("agent_end", {}, ctx);

      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({
          cwd: "/repo",
          encoding: "utf-8",
          env: expect.objectContaining({ PLANNOTATOR_CWD: "/repo" }),
        }),
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("delivers code review feedback from CLI output", async () => {
    vi.resetModules();
    mockSpawnSync({ status: 0, stdout: "Please add tests.", stderr: "" });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("uses a one-second default delay before retrying busy code review", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const spawnSync = mockSpawnSync({
      status: 0,
      stdout: "Please add tests.",
      stderr: "",
    });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const sessionFile = "/repo/.pi/session.json";
    const busyCtx = createTestContext("/repo", {
      isIdle: false,
      sessionFile,
    });
    const idleCtx = createTestContext("/repo", { sessionFile });

    try {
      await emit("session_start", {}, busyCtx);
      await triggerCodeReview(emit, busyCtx);
      await emit("agent_end", {}, busyCtx);
      await emit("session_start", {}, idleCtx);

      await vi.advanceTimersByTimeAsync(999);
      await flushMicrotasks();
      expect(spawnSync).not.toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    } finally {
      await emit("session_shutdown", {}, idleCtx);
    }
  });

  it("uses the replacement session context for delayed CLI review retries", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const spawnSync = mockSpawnSync({
      status: 1,
      stdout: "",
      stderr: "review failed",
    });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo", {
      isIdle: false,
      sessionFile: "/repo/.pi/session.json",
    });
    const replacementCtx = createTestContext("/repo", {
      sessionFile: "/repo/.pi/session.json",
    });
    let stale = false;

    ctx.ui.notify.mockImplementation(() => {
      if (stale) {
        throw new Error(
          "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
        );
      }
    });

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expect(spawnSync).not.toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.anything(),
      );

      await emit("session_start", {}, replacementCtx);
      stale = true;

      await vi.advanceTimersByTimeAsync(1_200);
      await flushMicrotasks();

      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(replacementCtx.ui.notify).toHaveBeenCalledWith(
        "review failed",
        "warning",
      );
    } finally {
      await emit("session_shutdown", {}, replacementCtx);
    }
  });

  it("formats a follow-up when CLI code review returns feedback", async () => {
    vi.resetModules();
    mockSpawnSync({ status: 0, stdout: "Please add tests.", stderr: "" });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Code review closed (no feedback).",
        "info",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });
});
