import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type ImportedModule = {
  resolvePlanFileForReview?: (
    ctx: { cwd: string },
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      resolvedPlanPaths: string[];
      resolvedSpecPaths?: string[];
      extraReviewTargets?: Array<{
        dir: string;
        pattern: RegExp;
      }>;
    },
    targetPath: string,
  ) => string | null;
  shouldQueueReviewForToolPath?: (
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      resolvedPlanPaths: string[];
      resolvedSpecPaths?: string[];
      extraReviewTargets?: Array<{
        dir: string;
        pattern: RegExp;
      }>;
    } | null,
    targetPath: string,
  ) => boolean;
  findLatestPlanFileForAnnotation?: (
    ctx: { cwd: string },
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
      resolvedPlanPaths: string[];
      resolvedSpecPaths?: string[];
      extraReviewTargets?: Array<{
        dir: string;
        pattern: RegExp;
      }>;
    },
  ) => {
    absolutePath: string;
    repoRelativePath: string;
  } | null;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

const importPlannotatorAuto = async (): Promise<ImportedModule> =>
  (await import("./index.js")) as ImportedModule;

describe("resolvePlanFileForReview", () => {
  it("returns repo-relative generated path for plan files in the configured directory", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(".pi/plans/repo/plan/2026-04-15-auth-flow.md");
  });

  it("returns null for legacy single-file paths", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBeNull();
  });

  it("matches generated design specs in the sibling specs directory", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
      ),
    ).toBe(".pi/plans/repo/specs/2026-04-20-auth-design.md");
  });

  it("matches generated plan files in any default alias directory", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/pi-kit/plan",
          resolvedPlanPath: "/repo/.pi/plans/pi-kit/plan",
          resolvedPlanPaths: [
            "/repo/.pi/plans/pi-kit/plan",
            "/repo/.pi/plans/pi-kit.feat-branch/plan",
          ],
          resolvedSpecPaths: [
            "/repo/.pi/plans/pi-kit/specs",
            "/repo/.pi/plans/pi-kit.feat-branch/specs",
          ],
        },
        "/repo/.pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(".pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md");
  });

  it("matches configured extra review targets using basename regex", async () => {
    const { resolvePlanFileForReview } = await importPlannotatorAuto();

    expect(
      resolvePlanFileForReview?.(
        { cwd: "/repo" },
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
          extraReviewTargets: [
            {
              dir: "/repo/.pi/plans/repo/office-hours",
              pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
            },
          ],
        },
        "/repo/.pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
      ),
    ).toBe(
      ".pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
    );
  });
});

describe("shouldQueueReviewForToolPath", () => {
  it("skips code review when a generated plan file changed inside the plan directory", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(false);
  });

  it("still queues code review when a legacy single-file path changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(shouldQueueReviewForToolPath).toBeTypeOf("function");
    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBe(true);
  });

  it("still queues code review when a non-plan file changed", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/src/auth.ts",
      ),
    ).toBe(true);
  });

  it("skips code review for generated design specs in the sibling specs directory", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
      ),
    ).toBe(false);
  });

  it("still queues code review for non-design files inside specs", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
        },
        "/repo/.pi/plans/repo/specs/2026-04-20-auth-notes.md",
      ),
    ).toBe(true);
  });

  it("skips code review for plan files in any default alias directory", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/pi-kit/plan",
          resolvedPlanPath: "/repo/.pi/plans/pi-kit/plan",
          resolvedPlanPaths: [
            "/repo/.pi/plans/pi-kit/plan",
            "/repo/.pi/plans/pi-kit.feat-branch/plan",
          ],
          resolvedSpecPaths: [
            "/repo/.pi/plans/pi-kit/specs",
            "/repo/.pi/plans/pi-kit.feat-branch/specs",
          ],
        },
        "/repo/.pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
      ),
    ).toBe(false);
  });

  it("skips code review for files matching configured extra review targets", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
          extraReviewTargets: [
            {
              dir: "/repo/.pi/plans/repo/office-hours",
              pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
            },
          ],
        },
        "/repo/.pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
      ),
    ).toBe(false);
  });

  it("still queues code review for non-matching files inside configured extra review target directories", async () => {
    const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

    expect(
      shouldQueueReviewForToolPath?.(
        {
          planFile: ".pi/plans/repo/plan",
          resolvedPlanPath: "/repo/.pi/plans/repo/plan",
          resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
          resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
          extraReviewTargets: [
            {
              dir: "/repo/.pi/plans/repo/office-hours",
              pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
            },
          ],
        },
        "/repo/.pi/plans/repo/office-hours/notes.md",
      ),
    ).toBe(true);
  });
});

describe("findLatestPlanFileForAnnotation", () => {
  it("returns the most recently modified generated plan file", async () => {
    const { findLatestPlanFileForAnnotation } = await importPlannotatorAuto();

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-latest-plan-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const olderPlan = path.join(planDir, "2026-04-17-older.md");
    const latestPlan = path.join(planDir, "2026-04-18-latest.md");
    const nonPlanFile = path.join(planDir, "notes.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(olderPlan, "# Older\n", "utf8");
    await fs.writeFile(latestPlan, "# Latest\n", "utf8");
    await fs.writeFile(nonPlanFile, "# Notes\n", "utf8");

    const olderDate = new Date("2026-04-17T00:00:00.000Z");
    const latestDate = new Date("2026-04-18T00:00:00.000Z");
    await fs.utimes(olderPlan, olderDate, olderDate);
    await fs.utimes(latestPlan, latestDate, latestDate);

    try {
      expect(
        findLatestPlanFileForAnnotation?.(
          { cwd: repoRoot },
          {
            planFile: path.join(".pi", "plans", repoName, "plan"),
            resolvedPlanPath: planDir,
            resolvedPlanPaths: [planDir],
            resolvedSpecPaths: [
              path.join(repoRoot, ".pi", "plans", repoName, "specs"),
            ],
          },
        ),
      ).toEqual({
        absolutePath: latestPlan,
        repoRelativePath: path.join(
          ".pi",
          "plans",
          repoName,
          "plan",
          "2026-04-18-latest.md",
        ),
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns the newest generated plan across default alias directories", async () => {
    const { findLatestPlanFileForAnnotation } = await importPlannotatorAuto();

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-latest-plan-alias-"),
    );
    const rootPlanDir = path.join(repoRoot, ".pi", "plans", "pi-kit", "plan");
    const worktreePlanDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      "pi-kit.feat-branch",
      "plan",
    );
    const olderPlan = path.join(rootPlanDir, "2026-04-17-older.md");
    const latestPlan = path.join(worktreePlanDir, "2026-04-18-latest.md");

    await fs.mkdir(rootPlanDir, { recursive: true });
    await fs.mkdir(worktreePlanDir, { recursive: true });
    await fs.writeFile(olderPlan, "# Older\n", "utf8");
    await fs.writeFile(latestPlan, "# Latest\n", "utf8");

    const olderDate = new Date("2026-04-17T00:00:00.000Z");
    const latestDate = new Date("2026-04-18T00:00:00.000Z");
    await fs.utimes(olderPlan, olderDate, olderDate);
    await fs.utimes(latestPlan, latestDate, latestDate);

    try {
      expect(
        findLatestPlanFileForAnnotation?.(
          { cwd: repoRoot },
          {
            planFile: path.join(".pi", "plans", "pi-kit", "plan"),
            resolvedPlanPath: rootPlanDir,
            resolvedPlanPaths: [rootPlanDir, worktreePlanDir],
            resolvedSpecPaths: [
              path.join(repoRoot, ".pi", "plans", "pi-kit", "specs"),
              path.join(
                repoRoot,
                ".pi",
                "plans",
                "pi-kit.feat-branch",
                "specs",
              ),
            ],
          },
        ),
      ).toEqual({
        absolutePath: latestPlan,
        repoRelativePath: path.join(
          ".pi",
          "plans",
          "pi-kit.feat-branch",
          "plan",
          "2026-04-18-latest.md",
        ),
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns the newest review target across plan and spec directories", async () => {
    const { findLatestPlanFileForAnnotation } = await importPlannotatorAuto();

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-latest-review-target-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const specDir = path.join(repoRoot, ".pi", "plans", repoName, "specs");
    const latestPlan = path.join(planDir, "2026-04-18-latest.md");
    const latestSpec = path.join(specDir, "2026-04-20-agent-design.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(latestPlan, "# Latest plan\n", "utf8");
    await fs.writeFile(latestSpec, "# Latest spec\n", "utf8");

    const planDate = new Date("2026-04-18T00:00:00.000Z");
    const specDate = new Date("2026-04-20T00:00:00.000Z");
    await fs.utimes(latestPlan, planDate, planDate);
    await fs.utimes(latestSpec, specDate, specDate);

    try {
      expect(
        findLatestPlanFileForAnnotation?.(
          { cwd: repoRoot },
          {
            planFile: path.join(".pi", "plans", repoName, "plan"),
            resolvedPlanPath: planDir,
            resolvedPlanPaths: [planDir],
            resolvedSpecPaths: [specDir],
          },
        ),
      ).toEqual({
        absolutePath: latestSpec,
        repoRelativePath: path.join(
          ".pi",
          "plans",
          repoName,
          "specs",
          "2026-04-20-agent-design.md",
        ),
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns the newest configured extra review target when it is newer than built-in targets", async () => {
    const { findLatestPlanFileForAnnotation } = await importPlannotatorAuto();

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-latest-extra-review-target-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const officeHoursDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      repoName,
      "office-hours",
    );
    const latestPlan = path.join(planDir, "2026-04-18-latest.md");
    const latestOfficeHours = path.join(
      officeHoursDir,
      "ming-main-office-hours-20260422-123456.md",
    );

    await fs.mkdir(planDir, { recursive: true });
    await fs.mkdir(officeHoursDir, { recursive: true });
    await fs.writeFile(latestPlan, "# Latest plan\n", "utf8");
    await fs.writeFile(latestOfficeHours, "# Latest office hours\n", "utf8");

    const planDate = new Date("2026-04-18T00:00:00.000Z");
    const officeHoursDate = new Date("2026-04-22T12:34:56.000Z");
    await fs.utimes(latestPlan, planDate, planDate);
    await fs.utimes(latestOfficeHours, officeHoursDate, officeHoursDate);

    try {
      expect(
        findLatestPlanFileForAnnotation?.(
          { cwd: repoRoot },
          {
            planFile: path.join(".pi", "plans", repoName, "plan"),
            resolvedPlanPath: planDir,
            resolvedPlanPaths: [planDir],
            resolvedSpecPaths: [
              path.join(repoRoot, ".pi", "plans", repoName, "specs"),
            ],
            extraReviewTargets: [
              {
                dir: officeHoursDir,
                pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
              },
            ],
          },
        ),
      ).toEqual({
        absolutePath: latestOfficeHours,
        repoRelativePath: path.join(
          ".pi",
          "plans",
          repoName,
          "office-hours",
          "ming-main-office-hours-20260422-123456.md",
        ),
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("getSessionKey", () => {
  it("falls back to a cwd-scoped ephemeral key when the session file is unavailable", async () => {
    const { getSessionKey } = await importPlannotatorAuto();

    expect(getSessionKey).toBeTypeOf("function");
    expect(
      getSessionKey?.({
        cwd: "/repo",
        sessionManager: { getSessionFile: () => null },
      }),
    ).toBe("/repo::ephemeral");
  });
});

type TestCtx = {
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

type PiEventHandler = (event: unknown, ctx: TestCtx) => unknown;

type FakeEventBus = {
  on: (channel: string, handler: (payload: unknown) => void) => void;
  emit: (channel: string, payload: unknown) => void;
};

const createFakeEventBus = (): FakeEventBus => {
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
};

type ShortcutHandler = (ctx: TestCtx) => unknown;
type ShortcutRegistration = {
  description: string;
  handler: ShortcutHandler;
};

type ToolRegistration = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void | Promise<void>,
    ctx: TestCtx,
  ) => Promise<unknown>;
};

const createFakePi = () => {
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
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("annotate latest plan shortcut", () => {
  it("requests plannotator annotate for the most recently modified plan file", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const olderPlanPath = path.join(planDir, "2026-04-17-older.md");
    const latestPlanPath = path.join(planDir, "2026-04-18-latest.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(olderPlanPath, "# Older\n", "utf8");
    await fs.writeFile(latestPlanPath, "# Latest\n", "utf8");

    const olderDate = new Date("2026-04-17T00:00:00.000Z");
    const latestDate = new Date("2026-04-18T00:00:00.000Z");
    await fs.utimes(olderPlanPath, olderDate, olderDate);
    await fs.utimes(latestPlanPath, latestDate, latestDate);

    const annotateRequests: Array<{
      action: string;
      payload: unknown;
    }> = [];

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
          feedback: "Please clarify handoff steps.",
        },
      });
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toHaveLength(1);
      expect(annotateRequests[0]).toEqual({
        action: "annotate",
        payload: {
          filePath: latestPlanPath,
          mode: "annotate",
        },
      });
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please clarify handoff steps."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("annotates the latest spec when it is newer than the latest plan", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-latest-spec-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const specDir = path.join(repoRoot, ".pi", "plans", repoName, "specs");
    const latestPlanPath = path.join(planDir, "2026-04-18-latest.md");
    const latestSpecPath = path.join(specDir, "2026-04-20-agent-design.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(latestPlanPath, "# Latest plan\n", "utf8");
    await fs.writeFile(latestSpecPath, "# Latest spec\n", "utf8");

    const planDate = new Date("2026-04-18T00:00:00.000Z");
    const specDate = new Date("2026-04-20T00:00:00.000Z");
    await fs.utimes(latestPlanPath, planDate, planDate);
    await fs.utimes(latestSpecPath, specDate, specDate);

    const annotateRequests: Array<{
      action: string;
      payload: unknown;
    }> = [];

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

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toHaveLength(1);
      expect(annotateRequests[0]).toEqual({
        action: "annotate",
        payload: {
          filePath: latestSpecPath,
          mode: "annotate",
        },
      });
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Please refine the design edge cases."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("waits synchronously for slow annotate responses instead of timing out", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-sync-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const latestPlanPath = path.join(planDir, "2026-04-20-latest.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(latestPlanPath, "# Latest\n", "utf8");

    events.on("plannotator:request", (data) => {
      const request = data as {
        respond: (response: unknown) => void;
      };

      setTimeout(() => {
        request.respond({
          status: "handled",
          result: {
            feedback: "Slow annotation completed.",
          },
        });
      }, 6_000);
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

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
      await fs.rm(repoRoot, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("delivers a follow-up when annotate returns inline comments without top-level feedback", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-inline-comments-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const latestPlanPath = path.join(planDir, "2026-04-20-latest.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(latestPlanPath, "# Latest\n", "utf8");

    events.on("plannotator:request", (data) => {
      const request = data as {
        respond: (response: unknown) => void;
      };

      request.respond({
        status: "handled",
        result: {
          feedback: "",
          annotations: [{ id: "note-1" }],
        },
      });
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

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
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("considers both default alias directories and picks the newest plan", async () => {
    vi.resetModules();

    vi.doMock("../shared/git.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../shared/git.ts")>();
      return {
        ...actual,
        getGitCommonDir: vi.fn(() => "/workspace/pi-kit/.git"),
      };
    });

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-alias-"),
    );
    const rootPlanDir = path.join(repoRoot, ".pi", "plans", "pi-kit", "plan");
    const worktreePlanDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      path.basename(repoRoot),
      "plan",
    );
    const olderPlanPath = path.join(rootPlanDir, "2026-04-17-older.md");
    const latestPlanPath = path.join(worktreePlanDir, "2026-04-18-latest.md");

    await fs.mkdir(rootPlanDir, { recursive: true });
    await fs.mkdir(worktreePlanDir, { recursive: true });
    await fs.writeFile(olderPlanPath, "# Older\n", "utf8");
    await fs.writeFile(latestPlanPath, "# Latest\n", "utf8");

    const olderDate = new Date("2026-04-17T00:00:00.000Z");
    const latestDate = new Date("2026-04-18T00:00:00.000Z");
    await fs.utimes(olderPlanPath, olderDate, olderDate);
    await fs.utimes(latestPlanPath, latestDate, latestDate);

    const annotateRequests: Array<{
      action: string;
      payload: unknown;
    }> = [];

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
          feedback: "Looks good.",
        },
      });
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toHaveLength(1);
      expect(annotateRequests[0]).toEqual({
        action: "annotate",
        payload: {
          filePath: latestPlanPath,
          mode: "annotate",
        },
      });
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("warns when no generated plan files are available", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-empty-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    await fs.mkdir(planDir, { recursive: true });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No plan files found in"),
        "warning",
      );
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("warns when plannotator is unavailable for annotate requests", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-unavailable-"),
    );
    const repoName = path.basename(repoRoot);
    const planDir = path.join(repoRoot, ".pi", "plans", repoName, "plan");
    const latestPlanPath = path.join(planDir, "2026-04-19-latest.md");

    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(latestPlanPath, "# Latest\n", "utf8");

    events.on("plannotator:request", (data) => {
      const request = data as {
        respond: (response: unknown) => void;
      };

      request.respond({
        status: "unavailable",
        error: "Plannotator context is not ready yet.",
      });
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

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
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("limits latest-plan lookup to the explicit configured directory", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-configured-"),
    );
    const configuredPlanDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      "custom",
      "plan",
    );
    const aliasPlanDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      path.basename(repoRoot),
      "plan",
    );
    const configuredPlanPath = path.join(
      configuredPlanDir,
      "2026-04-17-configured.md",
    );
    const aliasPlanPath = path.join(aliasPlanDir, "2026-04-18-alias.md");

    await fs.mkdir(configuredPlanDir, { recursive: true });
    await fs.mkdir(aliasPlanDir, { recursive: true });
    await fs.writeFile(configuredPlanPath, "# Configured\n", "utf8");
    await fs.writeFile(aliasPlanPath, "# Alias\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: ".pi/plans/custom/plan",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const annotateRequests: Array<{
      action: string;
      payload: unknown;
    }> = [];

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
          feedback: "Configured path only.",
        },
      });
    });

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toHaveLength(1);
      expect(annotateRequests[0]).toEqual({
        action: "annotate",
        payload: {
          filePath: configuredPlanPath,
          mode: "annotate",
        },
      });
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Configured path only."),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("includes configured extra review targets in latest-target annotation", async () => {
    vi.resetModules();

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, events, runShortcut } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-shortcut-extra-target-"),
    );
    const configuredPlanDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      "custom",
      "plan",
    );
    const extraTargetDir = path.join(
      repoRoot,
      ".pi",
      "plans",
      "pi-kit",
      "office-hours",
    );
    const configuredPlanPath = path.join(
      configuredPlanDir,
      "2026-04-17-configured.md",
    );
    const extraTargetPath = path.join(
      extraTargetDir,
      "ming-main-office-hours-20260422-123456.md",
    );

    await fs.mkdir(configuredPlanDir, { recursive: true });
    await fs.mkdir(extraTargetDir, { recursive: true });
    await fs.writeFile(configuredPlanPath, "# Configured\n", "utf8");
    await fs.writeFile(extraTargetPath, "# Office hours\n", "utf8");

    const configuredDate = new Date("2026-04-17T00:00:00.000Z");
    const extraTargetDate = new Date("2026-04-22T12:34:56.000Z");
    await fs.utimes(configuredPlanPath, configuredDate, configuredDate);
    await fs.utimes(extraTargetPath, extraTargetDate, extraTargetDate);

    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
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
      "utf8",
    );

    const annotateRequests: Array<{
      action: string;
      payload: unknown;
    }> = [];

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

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await runShortcut("ctrl+alt+l", ctx);

      expect(annotateRequests).toHaveLength(1);
      expect(annotateRequests[0]).toEqual({
        action: "annotate",
        payload: {
          filePath: extraTargetPath,
          mode: "annotate",
        },
      });
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("plan review trigger timing", () => {
  it("marks a plan draft pending after a busy plan-file write without auto-starting review", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-immediate",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review rejected."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const abort = vi.fn();
    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort,
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
        },
        ctx,
      );
      let settled = false;
      const reviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      ).then(() => {
        settled = true;
      });

      await flushMicrotasks();
      await reviewPromise;
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(settled).toBe(true);
      expect(abort).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("sends a strict follow-up gate message at agent_end when a plan draft is still pending", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-immediate",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review rejected."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-pending-gate-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(planFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("injects pending review guidance before the next agent turn", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn();

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review rejected."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
      waitForReviewResult: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-before-agent-start-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      const result = (await emit("before_agent_start", {}, ctx)) as {
        message?: { content?: string };
      };

      expect(result.message?.content ?? "").toContain(
        "plannotator_auto_submit_review",
      );
      expect(result.message?.content ?? "").toContain(planFileRelative);
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses git common-dir repo slug for default plan review path in worktree sessions", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-worktree",
      },
    }));

    vi.doMock("../shared/git.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../shared/git.ts")>();
      return {
        ...actual,
        getGitCommonDir: vi.fn(() => "/workspace/pi-kit/.git"),
      };
    });

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-kit.feat-worktree-plan-"),
    );
    const planFileRelative = ".pi/plans/pi-kit/plan/2026-04-16-worktree.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] verify\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
        },
        ctx,
      );

      const reviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      );

      await flushMicrotasks();
      await reviewPromise;
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("also accepts cwd-basename plan directories in worktree sessions", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-worktree-alias",
      },
    }));

    vi.doMock("../shared/git.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../shared/git.ts")>();
      return {
        ...actual,
        getGitCommonDir: vi.fn(() => "/workspace/pi-kit/.git"),
      };
    });

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-kit.feat-worktree-alias-plan-"),
    );
    const planFileRelative = `.pi/plans/${path.basename(repoRoot)}/plan/2026-04-16-worktree.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] verify\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
        },
        ctx,
      );

      const reviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      );

      await flushMicrotasks();
      await reviewPromise;
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("gates generated design specs until the agent submits the review explicitly", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-spec",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(
        () => "# Plan Review\n\nPlan approved. Proceed with implementation.",
      ),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-spec-review-"),
    );
    const specFileRelative =
      ".pi/plans/pi-kit/specs/2026-04-20-agent-design.md";
    const specFileAbsolute = path.join(repoRoot, specFileRelative);

    await fs.mkdir(path.dirname(specFileAbsolute), { recursive: true });
    await fs.writeFile(specFileAbsolute, "# Spec\n\n- draft\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: specFileRelative },
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

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(specFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not treat alias directories as plan files when planFile is explicitly configured", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn();

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { emit, api } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-explicit-dir-"),
    );
    const configuredPlanRelative =
      ".pi/plans/custom/plan/2026-04-16-configured.md";
    const aliasPlanRelative = `.pi/plans/${path.basename(repoRoot)}/plan/2026-04-16-alias.md`;

    await fs.mkdir(path.dirname(path.join(repoRoot, configuredPlanRelative)), {
      recursive: true,
    });
    await fs.mkdir(path.dirname(path.join(repoRoot, aliasPlanRelative)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoRoot, configuredPlanRelative),
      "# Configured\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, aliasPlanRelative),
      "# Alias\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: ".pi/plans/custom/plan",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: aliasPlanRelative },
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

      expect(startPlanReview).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("gates files matching configured extra review targets until explicit submission", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn();

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { emit, api } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-extra-target-review-"),
    );
    const extraTargetRelative =
      ".pi/plans/pi-kit/office-hours/ming-main-office-hours-20260422-123456.md";

    await fs.mkdir(path.dirname(path.join(repoRoot, extraTargetRelative)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoRoot, extraTargetRelative),
      "# Office Hours\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
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
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: extraTargetRelative },
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

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("plannotator_auto_submit_review"),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(extraTargetRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not trigger plan review for legacy single-file configuration", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn();

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-"),
    );
    const planFileRelative = ".pi/PLAN.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] first\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: planFileRelative,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      await flushMicrotasks();
      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("lists every pending review target in the strict gate message", async () => {
    vi.resetModules();

    const startPlanReview = vi.fn();

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
      waitForReviewResult: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-multi-pending-gate-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-flow.md`;
    const specFileRelative = `.pi/plans/${repoName}/specs/2026-04-16-flow-design.md`;

    await fs.mkdir(path.dirname(path.join(repoRoot, planFileRelative)), {
      recursive: true,
    });
    await fs.mkdir(path.dirname(path.join(repoRoot, specFileRelative)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoRoot, planFileRelative),
      "# Plan\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, specFileRelative),
      "# Spec\n",
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-2",
          args: { path: specFileRelative },
        },
        ctx,
      );
      await emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-2",
          isError: false,
        },
        ctx,
      );

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(planFileRelative),
        { deliverAs: "followUp" },
      );
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(specFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps a rewritten directory-mode plan pending without auto-starting review", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    let reviewCount = 0;
    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: `review-${++reviewCount}`,
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-directory-plan-"),
    );
    const planFileRelative = ".pi/plans/pi-kit/plan/2026-04-16-flow.md";
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(
      planFileAbsolute,
      "# Plan\n\n## Steps\n- [ ] first\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".pi", "third_extension_settings.json"),
      `${JSON.stringify(
        {
          plannotatorAuto: {
            planFile: ".pi/plans/pi-kit/plan",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => false,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);

      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      await flushMicrotasks();
      expect(startPlanReview).not.toHaveBeenCalled();

      await fs.writeFile(
        planFileAbsolute,
        "# Plan\n\n## Steps\n- [x] first\n\n## Review\n- approved\n",
        "utf8",
      );
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-2",
          args: { path: planFileRelative },
        },
        ctx,
      );
      await emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-2",
          isError: false,
        },
        ctx,
      );

      await emit("agent_end", {}, ctx);

      expect(startPlanReview).not.toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(planFileRelative),
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("submit review tool", () => {
  it("submits a pending plan draft and waits for approval", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];

    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-submit-plan",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => null),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus: vi.fn(),
      startCodeReview: vi.fn(),
      startPlanReview,
      waitForReviewResult: vi.fn(
        (_store, reviewId: string) =>
          new Promise((resolve) => {
            reviewResultListeners.push((result) => {
              const completed = result as {
                reviewId?: string;
                approved?: boolean;
                feedback?: string;
              };
              if (completed.reviewId === reviewId) {
                resolve({ status: "completed", ...completed });
              }
            });
          }),
      ),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, runTool } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-submit-tool-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      let settled = false;
      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      ).then((result) => {
        settled = true;
        return result;
      });

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-submit-plan",
          approved: true,
        });
      }

      const result = (await submitPromise) as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { status?: string };
      };
      expect(result.details?.status).toBe("approved");
      expect(result.content?.[0]?.text ?? "").toContain("approved");
    } finally {
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to review-status when the async review result event is missed", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "completed" as const,
        reviewId: "review-submit-fallback",
        approved: true,
      },
    }));

    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-submit-fallback",
      },
    }));

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
      requestAnnotation: vi.fn(),
      requestCodeReview: vi.fn(),
      requestReviewStatus,
      startCodeReview: vi.fn(),
      startPlanReview,
      waitForReviewResult: vi.fn(() => new Promise(() => {})),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit, runTool } = createFakePi();

    plannotatorAuto(api as never);

    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plannotator-auto-submit-fallback-"),
    );
    const repoName = path.basename(repoRoot);
    const planFileRelative = `.pi/plans/${repoName}/plan/2026-04-16-workflow.md`;
    const planFileAbsolute = path.join(repoRoot, planFileRelative);

    await fs.mkdir(path.dirname(planFileAbsolute), { recursive: true });
    await fs.writeFile(planFileAbsolute, "# Plan\n\n- [ ] test\n", "utf8");

    const ctx: TestCtx = {
      cwd: repoRoot,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => path.join(repoRoot, ".pi", "session.json"),
      },
    };

    try {
      await emit("session_start", {}, ctx);
      await emit(
        "tool_execution_start",
        {
          toolName: "write",
          toolCallId: "call-1",
          args: { path: planFileRelative },
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

      let settled = false;
      const submitPromise = Promise.resolve(
        runTool(
          "plannotator_auto_submit_review",
          { path: planFileRelative },
          ctx,
        ),
      ).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();

      expect(requestReviewStatus).toHaveBeenCalled();
      expect(settled).toBe(true);
      await submitPromise;
    } finally {
      vi.useRealTimers();
      await emit("session_shutdown", {}, ctx);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("code review trigger timing", () => {
  it("probes plannotator before waiting for a synchronous code review result", async () => {
    vi.resetModules();
    let resolveCodeReview:
      | ((value: {
          status: "handled";
          result: {
            approved: boolean;
            feedback?: string;
          };
        }) => void)
      | null = null;

    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "missing" as const,
      },
    }));
    const requestCodeReview = vi.fn(
      () =>
        new Promise<{
          status: "handled";
          result: {
            approved: boolean;
            feedback?: string;
          };
        }>((resolve) => {
          resolveCodeReview = resolve;
        }),
    );

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

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn(() => () => {}),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(
        (result: { approved?: boolean; feedback?: string }) => {
          if (result.approved) {
            return "# Code Review\n\nCode review completed — no changes requested.";
          }

          if (!result.feedback?.trim()) {
            return null;
          }

          return "Please add tests.\n\nPlease address this feedback.";
        },
      ),
      formatPlanReviewMessage: vi.fn(() => ""),
      requestAnnotation: vi.fn(),
      requestCodeReview,
      requestReviewStatus,
      startCodeReview: vi.fn(),
      startPlanReview: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const ctx: TestCtx = {
      cwd: "/repo",
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => "/repo/.pi/session.json",
      },
    };

    try {
      await emit("session_start", {}, ctx);
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

      const agentEndPromise = emit("agent_end", {}, ctx);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(requestCodeReview).toHaveBeenCalledTimes(1);
      expect(requestReviewStatus.mock.invocationCallOrder[0]).toBeLessThan(
        requestCodeReview.mock.invocationCallOrder[0],
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        "Plannotator request timed out.",
        "warning",
      );

      resolveCodeReview?.({
        status: "handled",
        result: {
          approved: false,
          feedback: "Please add tests.",
        },
      });
      await agentEndPromise;

      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Please add tests.\n\nPlease address this feedback.",
        { deliverAs: "followUp" },
      );
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

  it("delivers code review feedback from async review results", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "missing" as const,
      },
    }));
    const requestCodeReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "code-review-1",
      },
    }));

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

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage: vi.fn(
        (result: { approved?: boolean; feedback?: string }) => {
          if (result.approved) {
            return "# Code Review\n\nCode review completed — no changes requested.";
          }

          if (!result.feedback?.trim()) {
            return null;
          }

          return "Please add tests.\n\nPlease address this feedback.";
        },
      ),
      formatPlanReviewMessage: vi.fn(() => ""),
      requestAnnotation: vi.fn(),
      requestCodeReview,
      requestReviewStatus,
      startCodeReview: vi.fn(),
      startPlanReview: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const ctx: TestCtx = {
      cwd: "/repo",
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => "/repo/.pi/session.json",
      },
    };

    try {
      await emit("session_start", {}, ctx);
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

      await emit("agent_end", {}, ctx);

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(requestCodeReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "code-review-1",
          approved: false,
          feedback: "Please add tests.",
        });
      }

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

  it("delivers a follow-up when async code review returns annotations without top-level feedback", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const formatCodeReviewMessage = vi.fn(
      (result: {
        approved?: boolean;
        feedback?: string;
        annotations?: unknown[];
      }) => {
        if (result.feedback?.trim()) {
          return `${result.feedback}\n\nPlease address this feedback.`;
        }

        if ((result.annotations?.length ?? 0) > 0) {
          return "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.";
        }

        return null;
      },
    );
    const requestReviewStatus = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "missing" as const,
      },
    }));
    const requestCodeReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "code-review-annotations",
      },
    }));

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

    vi.doMock("./plannotator-api.ts", () => ({
      createRequestPlannotator: vi.fn(() => vi.fn()),
      createReviewResultStore: vi.fn(() => ({
        onResult: vi.fn((listener: (result: unknown) => void) => {
          reviewResultListeners.push(listener);
          return () => {
            const index = reviewResultListeners.indexOf(listener);
            if (index >= 0) {
              reviewResultListeners.splice(index, 1);
            }
          };
        }),
        getStatus: vi.fn(() => ({ status: "missing" as const })),
        markPending: vi.fn(),
        markCompleted: vi.fn(),
      })),
      formatAnnotationMessage: vi.fn(() => ""),
      formatCodeReviewMessage,
      formatPlanReviewMessage: vi.fn(() => ""),
      requestAnnotation: vi.fn(),
      requestCodeReview,
      requestReviewStatus,
      startCodeReview: vi.fn(),
      startPlanReview: vi.fn(),
    }));

    const { default: plannotatorAuto } = await import("./index.js");
    const { api, emit } = createFakePi();

    plannotatorAuto(api as never);

    const ctx: TestCtx = {
      cwd: "/repo",
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionFile: () => "/repo/.pi/session.json",
      },
    };

    try {
      await emit("session_start", {}, ctx);
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

      await emit("agent_end", {}, ctx);

      expect(requestReviewStatus).toHaveBeenCalledTimes(1);
      expect(requestCodeReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      const annotations = [
        { file: "src/app.ts", line: 12, text: "Add a test." },
      ];
      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "code-review-annotations",
          approved: false,
          annotations,
        });
      }

      expect(formatCodeReviewMessage).toHaveBeenCalledWith({
        approved: false,
        feedback: undefined,
        annotations,
      });
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "# Code Review\n\nCode review completed with inline annotations. Please address the review comments.",
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
