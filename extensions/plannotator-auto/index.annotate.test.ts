import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePi,
  createTempRepo,
  createTestContext,
  flushMicrotasks,
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

const recordSessionMarkdownWrite = async (
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

describe("annotate latest Markdown shortcut", () => {
  it("annotates the latest Markdown file modified in the current session", async () => {
    vi.resetModules();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
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
    const annotateRequests: Array<{ action: string; payload: unknown }> = [];

    events.on("plannotator:request", (data) => {
      const request = data as {
        action: string;
        payload: { filePath?: string; mode?: string };
        respond: (response: unknown) => void;
      };

      annotateRequests.push({
        action: request.action,
        payload: request.payload,
      });
      request.respond({
        status: "handled",
        result: {
          feedback: "Please refine the session Markdown.",
        },
      });
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionMarkdownWrite(emit, ctx, "notes/freeform.md");
      await recordSessionMarkdownWrite(emit, ctx, "drafts/anything-goes.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toEqual([
        {
          action: "annotate",
          payload: {
            filePath: latestPath,
            mode: "annotate",
          },
        },
      ]);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please refine the session Markdown."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("waits synchronously for slow annotate responses instead of timing out", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo("plannotator-auto-shortcut-sync-");
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    events.on("plannotator:request", (data) => {
      const request = data as { respond: (response: unknown) => void };

      setTimeout(() => {
        request.respond({
          status: "handled",
          result: {
            feedback: "Slow annotation completed.",
          },
        });
      }, 6_000);
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionMarkdownWrite(emit, ctx, "notes/latest.md");

      let settled = false;
      const shortcutPromise = runShortcut("ctrl+alt+l", ctx).then(() => {
        settled = true;
      });

      await flushMicrotasks();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await shortcutPromise;

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Slow annotation completed."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });

  it("delivers a follow-up when annotate returns inline comments without top-level feedback", async () => {
    vi.resetModules();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-inline-comments-",
    );
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    events.on("plannotator:request", (data) => {
      const request = data as { respond: (response: unknown) => void };
      request.respond({
        status: "handled",
        result: {
          feedback: "",
          annotations: [{ id: "note-1" }],
        },
      });
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionMarkdownWrite(emit, ctx, "notes/latest.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Annotation completed with inline comments. Please address the annotation feedback above.",
        ),
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

  it("warns when plannotator is unavailable for annotate requests", async () => {
    vi.resetModules();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-unavailable-",
    );
    await writeTestFile(repoRoot, "notes/latest.md", "# Latest\n");

    events.on("plannotator:request", (data) => {
      const request = data as { respond: (response: unknown) => void };
      request.respond({
        status: "unavailable",
        error: "Plannotator context is not ready yet.",
      });
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await recordSessionMarkdownWrite(emit, ctx, "notes/latest.md");
      await runShortcut("ctrl+alt+l", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Plannotator context is not ready yet.",
        "warning",
      );
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
