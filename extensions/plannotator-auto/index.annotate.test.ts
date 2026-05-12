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
  createTempRepo,
  createTestContext,
  removeTempRepo,
  writeTestFile,
} from "./test-helpers.js";

async function importPlannotatorAuto() {
  return (await import("./index.js")).default;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const recordSessionDocumentWrite = async (
  emit: ReturnType<typeof createFakePi>["emit"],
  ctx: ReturnType<typeof createTestContext>,
  repoRelativePath: string,
): Promise<void> => {
  const event = {
    toolCallId: `tool-call-${repoRelativePath}`,
    toolName: "write",
    args: { path: repoRelativePath },
  };

  await emit("tool_execution_start", event, ctx);
  await emit("tool_execution_end", { ...event, isError: false }, ctx);
};

describe("annotate latest document shortcut", () => {
  it("annotates the latest Markdown file modified in the current session", async () => {
    vi.resetModules();
    const spawnSync = mockSpawnSync({
      status: 0,
      stdout: JSON.stringify({
        decision: "annotated",
        feedback: "Please refine the session Markdown.",
      }),
      stderr: "",
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-session-md-",
    );
    await writeTestFile(
      repoRoot,
      "notes/freeform.md",
      "# Older session Markdown\n",
      new Date("2026-04-18T00:00:00.000Z"),
    );
    const latestPath = await writeTestFile(
      repoRoot,
      "drafts/anything-goes.md",
      "# Latest session Markdown\n",
      new Date("2026-04-20T00:00:00.000Z"),
    );
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionDocumentWrite(emit, ctx, "notes/freeform.md");
      await recordSessionDocumentWrite(emit, ctx, "drafts/anything-goes.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        ["annotate", latestPath, "--json"],
        expect.objectContaining({ cwd: repoRoot }),
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please refine the session Markdown."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("annotates latest HTML document with render-html CLI flag", async () => {
    vi.resetModules();
    const spawnSync = mockSpawnSync({
      status: 0,
      stdout: JSON.stringify({ decision: "dismissed" }),
      stderr: "",
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-session-html-",
    );
    const latestPath = await writeTestFile(
      repoRoot,
      "plans/visual.html",
      "<html><body>Plan</body></html>",
    );
    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionDocumentWrite(emit, ctx, "plans/visual.html");
      await runShortcut("ctrl+alt+l", ctx);

      expect(spawnSync).toHaveBeenCalledWith(
        "plannotator",
        ["annotate", latestPath, "--render-html", "--json"],
        expect.objectContaining({ cwd: repoRoot }),
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("waits synchronously for CLI annotate output", async () => {
    vi.resetModules();
    mockSpawnSync({
      status: 0,
      stdout: JSON.stringify({
        decision: "annotated",
        feedback: "Slow annotation completed.",
      }),
      stderr: "",
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-shortcut-sync-");
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionDocumentWrite(emit, ctx, "notes/latest.md");

      await runShortcut("ctrl+alt+l", ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Slow annotation completed."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("delivers a follow-up when CLI annotate returns feedback", async () => {
    vi.resetModules();
    mockSpawnSync({
      status: 0,
      stdout: JSON.stringify({
        decision: "annotated",
        feedback: "Please address this comment.",
      }),
      stderr: "",
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-inline-comments-",
    );
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionDocumentWrite(emit, ctx, "notes/latest.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please address this comment."),
        { deliverAs: "followUp" },
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plan annotation closed (no feedback).",
        "info",
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("warns when plannotator CLI is unavailable for annotate requests", async () => {
    vi.resetModules();
    mockSpawnSync({
      status: 1,
      stdout: "",
      stderr: "plannotator failed",
    });

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-unavailable-",
    );
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionDocumentWrite(emit, ctx, "notes/latest.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "plannotator failed",
        "warning",
      );
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
