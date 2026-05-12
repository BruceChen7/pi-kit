import { describe, expect, it } from "vitest";

type ImportedModule = {
  resolvePlanFileForReview?: (
    ctx: { cwd: string },
    planConfig: PlanConfig,
    targetPath: string,
  ) => string | null;
  shouldQueueReviewForToolPath?: (
    planConfig: PlanConfig | null,
    targetPath: string,
  ) => boolean;
  getSessionKey?: (ctx: {
    cwd: string;
    sessionManager: { getSessionFile: () => string | null | undefined };
  }) => string;
};

type PlanConfig = {
  planFile: string;
  resolvedPlanPath: string;
  resolvedPlanPaths: string[];
  resolvedSpecPaths?: string[];
  extraReviewTargets?: Array<{
    dir: string;
    pattern: RegExp;
  }>;
};

async function importPlannotatorAuto(): Promise<ImportedModule> {
  return (await import("./index.js")) as ImportedModule;
}

function createPlanConfig(overrides: Partial<PlanConfig> = {}): PlanConfig {
  return {
    planFile: ".pi/plans/repo/plan",
    resolvedPlanPath: "/repo/.pi/plans/repo/plan",
    resolvedPlanPaths: ["/repo/.pi/plans/repo/plan"],
    resolvedSpecPaths: ["/repo/.pi/plans/repo/specs"],
    ...overrides,
  };
}

describe("index path helpers", () => {
  describe("resolvePlanFileForReview", () => {
    it.each([
      {
        name: "matches generated plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches generated HTML plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.html",
        expected: ".pi/plans/repo/plan/2026-04-15-auth-flow.html",
      },
      {
        name: "matches generated design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/repo/specs/2026-04-20-auth-design.md",
      },
      {
        name: "ignores HTML design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.html",
        expected: null,
      },
      {
        name: "matches alias plan directories",
        config: createPlanConfig({
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
        }),
        targetPath:
          "/repo/.pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/pi-kit.feat-branch/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches wildcard plan roots",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
        expected: ".pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
      },
      {
        name: "matches wildcard spec roots",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
        expected: ".pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
      },
      {
        name: "matches issue markdown files under a topic directory",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
        expected:
          ".pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
      },
      {
        name: "matches wildcard issue markdown files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
        expected:
          ".pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
      },
      {
        name: "ignores issue markdown files without a topic directory",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/issues/01-root-issue.md",
        expected: null,
      },
      {
        name: "ignores nested issue files below topic directories",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/nested/01-cleanup.md",
        expected: null,
      },
      {
        name: "ignores non-markdown issue files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/01-cleanup.txt",
        expected: null,
      },
      {
        name: "matches configured extra review targets",
        config: createPlanConfig({
          extraReviewTargets: [
            {
              dir: "/repo/.pi/plans/repo/office-hours",
              pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
            },
          ],
        }),
        targetPath:
          "/repo/.pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
        expected:
          ".pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
      },
    ])("$name", async ({ config, targetPath, expected }) => {
      const { resolvePlanFileForReview } = await importPlannotatorAuto();

      expect(
        resolvePlanFileForReview?.({ cwd: "/repo" }, config, targetPath),
      ).toBe(expected);
    });
  });

  describe("shouldQueueReviewForToolPath", () => {
    it.each([
      {
        name: "skips generated plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.md",
        expected: false,
      },
      {
        name: "skips generated HTML plan files",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/plan/2026-04-15-auth-flow.html",
        expected: false,
      },
      {
        name: "skips generated design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.md",
        expected: false,
      },
      {
        name: "keeps queueing HTML design specs",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/specs/2026-04-20-auth-design.html",
        expected: true,
      },
      {
        name: "skips wildcard generated plan files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/plan/2026-04-15-auth-flow.md",
        expected: false,
      },
      {
        name: "skips wildcard generated design specs",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/specs/2026-04-20-auth-design.md",
        expected: false,
      },
      {
        name: "skips issue markdown files under a topic directory",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/repo/issues/session-switch-lifecycle/cleanup-skill-toggle.md",
        expected: false,
      },
      {
        name: "skips wildcard issue markdown files",
        config: createPlanConfig(),
        targetPath:
          "/repo/.pi/plans/other-worktree/issues/session-switch-lifecycle/01-cleanup.md",
        expected: false,
      },
      {
        name: "keeps queueing issue markdown files without a topic directory",
        config: createPlanConfig(),
        targetPath: "/repo/.pi/plans/repo/issues/01-root-issue.md",
        expected: true,
      },
      {
        name: "skips configured extra review targets",
        config: createPlanConfig({
          extraReviewTargets: [
            {
              dir: "/repo/.pi/plans/repo/office-hours",
              pattern: /^[^/]+-office-hours-\d{8}-\d{6}\.md$/,
            },
          ],
        }),
        targetPath:
          "/repo/.pi/plans/repo/office-hours/ming-main-office-hours-20260422-123456.md",
        expected: false,
      },
      {
        name: "keeps queueing non-review files",
        config: createPlanConfig(),
        targetPath: "/repo/src/auth.ts",
        expected: true,
      },
    ])("$name", async ({ config, targetPath, expected }) => {
      const { shouldQueueReviewForToolPath } = await importPlannotatorAuto();

      expect(shouldQueueReviewForToolPath?.(config, targetPath)).toBe(expected);
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
});
