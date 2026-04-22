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

describe("annotate latest plan shortcut", () => {
  it("annotates the latest spec when it is newer than the latest plan", async () => {
    vi.resetModules();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-latest-spec-",
    );
    const repoName = repoRoot.split("/").pop() ?? "repo";
    const latestPlanPath = await writeTestFile(
      repoRoot,
      `.pi/plans/${repoName}/plan/2026-04-18-latest.md`,
      "# Latest plan\n",
      new Date("2026-04-18T00:00:00.000Z"),
    );
    const latestSpecPath = await writeTestFile(
      repoRoot,
      `.pi/plans/${repoName}/specs/2026-04-20-agent-design.md`,
      "# Latest spec\n",
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
          feedback: "Please refine the design edge cases.",
        },
      });
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toEqual([
        {
          action: "annotate",
          payload: {
            filePath: latestSpecPath,
            mode: "annotate",
          },
        },
      ]);
      expect(latestPlanPath).toContain("2026-04-18-latest.md");
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please refine the design edge cases."),
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
    const repoName = repoRoot.split("/").pop() ?? "repo";
    await writeTestFile(
      repoRoot,
      `.pi/plans/${repoName}/plan/2026-04-20-latest.md`,
      "# Latest\n",
    );

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
    const repoName = repoRoot.split("/").pop() ?? "repo";
    await writeTestFile(
      repoRoot,
      `.pi/plans/${repoName}/plan/2026-04-20-latest.md`,
      "# Latest\n",
    );

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
    const repoName = repoRoot.split("/").pop() ?? "repo";
    await writeTestFile(
      repoRoot,
      `.pi/plans/${repoName}/plan/2026-04-19-latest.md`,
      "# Latest\n",
    );

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

  it("includes configured extra review targets in latest-target annotation", async () => {
    vi.resetModules();

    const plannotatorAuto = await importPlannotatorAuto();
    const { api, emit, events, runShortcut } = createFakePi();
    plannotatorAuto(api as never);

    const repoRoot = await createTempRepo(
      "plannotator-auto-shortcut-extra-target-",
    );
    const configuredPlanPath = await writeTestFile(
      repoRoot,
      ".pi/plans/custom/plan/2026-04-17-configured.md",
      "# Configured\n",
      new Date("2026-04-17T00:00:00.000Z"),
    );
    const extraTargetPath = await writeTestFile(
      repoRoot,
      ".pi/plans/pi-kit/office-hours/ming-main-office-hours-20260422-123456.md",
      "# Office hours\n",
      new Date("2026-04-22T12:34:56.000Z"),
    );
    await writeTestFile(
      repoRoot,
      ".pi/third_extension_settings.json",
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: ".pi/plans/custom/plan",
            extraReviewTargets: [
              {
                dir: ".pi/plans/pi-kit/office-hours",
                filePattern: "^[^/]+-office-hours-\\d{8}-\\d{6}\\.md$",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
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
          feedback: "Extra target selected.",
        },
      });
    });

    const ctx = createTestContext(repoRoot);

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(configuredPlanPath).toContain("2026-04-17-configured.md");
      expect(annotateRequests).toEqual([
        {
          action: "annotate",
          payload: {
            filePath: extraTargetPath,
            mode: "annotate",
          },
        },
      ]);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await removeTempRepo(repoRoot);
    }
  });
});
