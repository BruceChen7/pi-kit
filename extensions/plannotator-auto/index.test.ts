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
    },
    targetPath: string,
  ) => string | null;
  shouldQueueReviewForToolPath?: (
    planConfig: {
      planFile: string;
      resolvedPlanPath: string;
    } | null,
    targetPath: string,
  ) => boolean;
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
        },
        "/repo/.pi/PLAN.md",
      ),
    ).toBeNull();
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
        },
        "/repo/src/auth.ts",
      ),
    ).toBe(true);
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

const createFakePi = () => {
  const handlers = new Map<string, PiEventHandler[]>();
  const events = createFakeEventBus();

  return {
    api: {
      on(name: string, handler: PiEventHandler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events,
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    },
    emit: async (name: string, event: unknown, ctx: TestCtx): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx);
      }
    },
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("plan review trigger timing", () => {
  it("waits for the plan review result after a busy plan-file write", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];

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
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review rejected."),
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
      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(abort).not.toHaveBeenCalled();

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-immediate",
          approved: false,
          feedback: "Please revise the rollout steps.",
        });
      }

      await reviewPromise;
      expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).toHaveBeenCalledWith(
        "Plan review rejected.",
        { deliverAs: "steer" },
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
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
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

  it("does not re-trigger directory-mode plan review after the same plan was approved", async () => {
    vi.resetModules();
    const reviewResultListeners: Array<(result: unknown) => void> = [];
    const startPlanReview = vi.fn(async () => ({
      status: "handled" as const,
      result: {
        status: "pending" as const,
        reviewId: "review-1",
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
      formatCodeReviewMessage: vi.fn(() => ""),
      formatPlanReviewMessage: vi.fn(() => "Plan review approved."),
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

      const firstReviewPromise = emit(
        "tool_execution_end",
        {
          toolName: "write",
          toolCallId: "call-1",
          isError: false,
        },
        ctx,
      );

      await flushMicrotasks();
      expect(startPlanReview).toHaveBeenCalledTimes(1);

      for (const listener of reviewResultListeners) {
        listener({
          reviewId: "review-1",
          approved: true,
        });
      }
      await firstReviewPromise;

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

      expect(startPlanReview).toHaveBeenCalledTimes(1);
      expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally {
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
      formatCodeReviewMessage,
      formatPlanReviewMessage: vi.fn(() => ""),
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
