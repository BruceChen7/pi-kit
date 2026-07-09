import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakePi,
  createTestContext,
  flushMicrotasks,
  mockHangingPlannotatorSpawn,
  mockPlannotatorSpawn,
} from "./test-helpers.js";

const mockSpawn = mockPlannotatorSpawn;

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
        plannotatorAuto: {},
      },
    })),
  }));

  vi.doMock("../shared/git.ts", () => ({
    DEFAULT_GIT_TIMEOUT_MS: 1_000,
    getRepoRoot: vi.fn(() => "/repo"),
    getGitCommonDir: vi.fn(() => "/repo/.git"),
  }));
}

function expectCodeReviewCliNotStarted(spawn: ReturnType<typeof mockSpawn>) {
  expect(spawn).not.toHaveBeenCalledWith(
    "plannotator",
    ["review"],
    expect.anything(),
  );
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
  it("does not automatically start code review after tracked file writes", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
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

      expectCodeReviewCliNotStarted(spawn);
      expect(api.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("runs CLI code review from the manual command", async () => {
    vi.resetModules();
    const spawn = mockSpawn({
      status: 0,
      stdout: "Manual feedback.",
      stderr: "",
    });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runCommand } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo", {
      uiCustom: vi.fn(async () => "code"),
    });

    try {
      await emit("session_start", {}, ctx);
      await runCommand("plannotator-review", "", ctx);
      // flush for the dynamic import of review-picker
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Manual feedback.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("runs CLI code review from the manual shortcut", async () => {
    vi.resetModules();
    const spawn = mockSpawn({ status: 0, stdout: "", stderr: "" });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo", {
      uiCustom: vi.fn(async () => "code"),
    });

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+shift+r", ctx);
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      const child = spawn.mock.results[0]?.value;
      expect(child.stdin.end).toHaveBeenCalledWith("");
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "# Code Review\n\nCode review completed — no changes requested.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("runs manual shortcut review without prechecking repo dirtiness", async () => {
    vi.resetModules();
    const spawn = mockSpawn({ status: 0, stdout: "", stderr: "" });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo", {
      uiCustom: vi.fn(async () => "code"),
    });

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+shift+r", ctx);
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        "plannotator",
        ["review"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "# Code Review\n\nCode review completed — no changes requested.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("keeps automatic repo review silent", async () => {
    vi.resetModules();
    const spawn = mockSpawn({ status: 0, stdout: "", stderr: "" });
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    try {
      await emit("session_start", {}, ctx);
      await triggerCodeReview(emit, ctx);
      await emit("agent_end", {}, ctx);

      expectCodeReviewCliNotStarted(spawn);
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("kills hanging plannotator children on session_shutdown", async () => {
    vi.resetModules();
    const { spawn: hangingSpawn, getChild } = mockHangingPlannotatorSpawn();
    mockCodeReviewApi();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit } = createFakePi();
    plannotatorAuto(api as never);
    const ctx = createTestContext("/repo");

    await emit("session_start", {}, ctx);

    // Fire-and-forget an annotate CLI call that hangs (child never exits).
    const { runPlannotatorAnnotateCli } = await import("./cli.js");
    void runPlannotatorAnnotateCli(ctx, "test.md", { timeoutMs: 60_000 });
    await flushMicrotasks();

    const child = getChild();
    expect(child).not.toBeNull();
    expect(hangingSpawn).toHaveBeenCalled();
    expect(child?.kill).not.toHaveBeenCalled();

    // session_shutdown should kill the hanging child
    await emit("session_shutdown", {}, ctx);

    expect(child?.kill).toHaveBeenCalled();
  });
});
